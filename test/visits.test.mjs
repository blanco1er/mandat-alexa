// Anonymous visit log: salted hash instead of IP, masking, internal visits excluded (header, secret-link cookie),
// 120-day TTL, the e-mail alert at most once an hour, and the owner's report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
import { _setPublisher, alertNewVisitor, internalKey, isInternal, maskText, outcomeOf, uaFamily, visitorId, TTL_DAYS } from '../src/core/visits.mjs';
import { commands } from '../src/store/dynamodb.mjs';
import { summarize, sessionsOf } from '../scripts/visits-report.mjs';
import { LocalJsonStore } from '../src/store/local-json.mjs';

const srv = await boot();
const sent = [];
_setPublisher(async (subject, message) => { sent.push({ subject, message }); return true; });
test.after(() => { srv.close(); _setPublisher(null); });
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const visits = async () => (await srv.service.store.query(`VISIT#${new Date().toISOString().slice(0, 10)}`, '')).map((r) => r.value);

test('the visitor is a salted hash, never the IP; e-mails and numbers are masked; families only', () => {
  const a = visitorId('203.0.113.7', UA);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, visitorId('203.0.113.7', UA), 'stable for the same visitor');
  assert.notEqual(a, visitorId('203.0.113.8', UA));
  assert.ok(!a.includes('203'));
  assert.equal(maskText('Mail me at jane.doe@example.com or call +1 (206) 555-0142, budget $400'), 'Mail me at [email] or call [number], budget $400');
  assert.equal(maskText('x'.repeat(500)).length, 200);
  assert.deepEqual(uaFamily(UA), { browser: 'Safari', os: 'macOS', bot: false });
  assert.equal(uaFamily('curl/8.1').bot, true);
  assert.deepEqual(outcomeOf([{ name: 'propose_plan', result: {} }, { name: 'confirm_plan', result: { isError: true } }]), { plan: true, paid: false, settled: false, stop: false, deleted: false });
});

test('rows expire after 120 days (DynamoDB TTL attribute)', () => {
  const ttl = Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;
  const cmd = commands.put('VISIT#2026-10-23', '2026-10-23T10:00:00.000Z#abc#01', { type: 'turn', ttl });
  assert.equal(cmd.Item.ttl, ttl);
  assert.equal(TTL_DAYS, 120);
});

test('page, device, language and turns are logged (no IP, sentence masked, tools, outcome); internal visits are not', async () => {
  const before = (await visits()).length;
  const post = (body, headers = {}) => fetch(`${srv.url}/visit`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA, 'x-mandat-client-ip': '198.51.100.20', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ type: 'page', device: 'show15', lang: 'fr-FR', ref: 'devpost.com' })).status, 204);
  await post({ type: 'nonsense' });
  const turn = await fetch(`${srv.url}/turn`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA, 'x-mandat-client-ip': '198.51.100.20' }, body: JSON.stringify({ text: 'How much is left? My email is judge@example.com', household: 'visit-test', device: 'dot', locale: 'en-US' }) });
  assert.equal(turn.status, 200);
  // internal: our scripts' header, and the owner's cookie from the secret link
  await post({ type: 'page' }, { 'x-mandat-visit': 'internal' });
  const link = await fetch(`${srv.url}/visit/internal?k=${internalKey()}`);
  assert.equal(link.status, 200);
  const cookie = link.headers.get('set-cookie');
  assert.match(cookie, /^mandat_internal=[0-9a-f]{32}; Max-Age=31536000; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
  await post({ type: 'page' }, { cookie: cookie.split(';')[0] });
  assert.equal((await fetch(`${srv.url}/visit/internal?k=wrong`)).status, 404);
  const rows = (await visits()).slice(before);
  assert.deepEqual(rows.map((r) => r.type), ['page', 'turn'], 'the bad type and both internal visits are not logged');
  const [page, t] = rows;
  assert.equal(page.ref, 'devpost.com');
  assert.equal(page.device, 'show15');
  assert.equal(page.lang, 'fr-FR');
  assert.equal(page.browser, 'Safari');
  assert.equal(t.visitor, page.visitor);
  assert.equal(t.text, 'How much is left? My email is [email]');
  assert.deepEqual(t.tools, ['get_household_status']);
  assert.equal(t.device, 'dot');
  assert.ok(!JSON.stringify(rows).includes('198.51.100.20'), 'never the IP');
  assert.ok(t.ttl > Date.now() / 1000 + 119 * 86400);
  assert.equal(isInternal(new Headers({ 'x-mandat-visit': 'internal' })), true);
});

test('e-mail alert: a new outside visitor with a turn, at most once an hour, subject with the source and turns', async () => {
  const store = new LocalJsonStore({ file: null });
  sent.length = 0;
  const t0 = Date.parse('2026-10-23T10:00:00Z');
  const row = (visitor, at) => ({ visitor, at: new Date(at).toISOString(), ref: 'devpost.com', browser: 'Chrome', os: 'macOS', device: 'show15', lang: 'en-US', text: 'my in-laws land Saturday', type: 'turn' });
  assert.equal(await alertNewVisitor(store, row('v1', t0), { now: t0 }), true);
  assert.equal(sent[0].subject, 'Mandat : nouveau visiteur (devpost.com) — 1 tour');
  assert.match(sent[0].message, /AWS_PROFILE=mandat node scripts\/visits-report\.mjs/);
  assert.equal(await alertNewVisitor(store, row('v1', t0 + 60e3), { now: t0 + 60e3 }), false, 'the same visitor: no second e-mail');
  assert.equal(await alertNewVisitor(store, row('v2', t0 + 20 * 60e3), { now: t0 + 20 * 60e3 }), false, 'another one inside the hour: waits');
  assert.equal(await alertNewVisitor(store, row('v2', t0 + 70 * 60e3), { now: t0 + 70 * 60e3 }), true, 'after the hour');
  assert.equal(sent[1].subject, 'Mandat : nouveau visiteur (devpost.com) — 2 tours');
  assert.equal(sent.length, 2);
});

test('the owner report: unique visitors, sources, how far they went, sessions, robots left out', () => {
  const ev = (visitor, at, type, extra = {}) => ({ visitor, at, type, browser: 'Chrome', os: 'macOS', bot: false, ...extra });
  const rows = [
    ev('aaaaaa11', '2026-10-23T10:00:00.000Z', 'page', { ref: 'devpost.com', device: 'show15', lang: 'en-US' }),
    ev('aaaaaa11', '2026-10-23T10:01:00.000Z', 'link'),
    ev('aaaaaa11', '2026-10-23T10:02:00.000Z', 'turn', { text: 'my in-laws land Saturday', tools: ['propose_plan'], outcome: { plan: true } }),
    ev('aaaaaa11', '2026-10-23T10:05:00.000Z', 'turn', { text: 'yes, book it', tools: ['confirm_plan'], outcome: { paid: true } }),
    ev('aaaaaa11', '2026-10-23T12:00:00.000Z', 'turn', { text: 'pause Mandat', tools: ['pause_spending'], outcome: { stop: true } }),
    ev('bbbbbb22', '2026-10-24T09:00:00.000Z', 'page', { device: 'dot', lang: 'fr-FR' }),
    ev('robot', '2026-10-24T09:00:00.000Z', 'turn', { bot: true, text: 'scan' }),
  ];
  assert.equal(sessionsOf(rows.filter((r) => !r.bot)).length, 3, 'two hours apart = two sessions');
  const txt = summarize(rows, { from: '2026-10-23', to: '2026-10-24', detail: true });
  assert.match(txt, /Visiteurs uniques : 2 · tours vocaux ou écrits : 3/);
  assert.match(txt, /Provenance : (devpost\.com 1 · accès direct 1|accès direct 1 · devpost\.com 1)/);
  assert.match(txt, /ont lié un compte : 1 \(50 %\)/);
  assert.match(txt, /plan proposé : 1 · « oui » et paiement de test : 1 · commande réglée : 0/);
  assert.match(txt, /arrêt d’urgence : 1/);
  assert.match(txt, /Session aaaaaa · 2026-10-23/);
  assert.doesNotMatch(txt, /scan/, 'robots are left out');
  assert.match(summarize([], {}), /Aucune visite externe/);
});
