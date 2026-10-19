// Off-script battery against the deployed demo (real Amazon Nova 2 Lite brain): what a judge may say without
// following the demo lines. Each story starts on a fresh linked household (OAuth 2.1 + PKCE, like Alexa), the plan
// is prepared over MCP (no model cost), then each line is ONE real voice turn (POST /turn). Every case checks the
// SERVER STATE (plan kinds, total, duplicates, PayPal holds), not only the words, and that no technical error is said.
//   node scripts/offscript-live.mjs https://<function-url> [case-id …]     (default: every case)
// Output: one line per case (PASS/FAIL + why), the speech, the Bedrock spend; exit 1 if a case fails.
import { linkHousehold } from './link-demo.mjs';
import { connectMcp } from '../src/brain/simulated.mjs';
import { absorb, absorbTokens } from '../src/brain/policy.mjs';

const BASE = (process.argv[2] || 'https://fonzkp2f5pszfit6xmqqiw7qdm0dybyu.lambda-url.us-east-1.on.aws').replace(/\/$/, '');
const ONLY = process.argv.slice(3);
const TECH = /\b(token|error|invalid|undefined|null|exception|schema|tool|offer_id|plan_id|json|parameter|argument)\b/i;
const sc = (r) => r?.structuredContent || {};

async function household() {
  const t = await linkHousehold(BASE, { choice: 'new' });
  const { client } = await connectMcp(`${BASE}/mcp`, { name: 'offscript-live', headers: { Authorization: `Bearer ${t.access_token}`, 'X-Mandat-Visit': 'internal' } });
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`); return r; };
  let session = { device: 'show' };
  return {
    auth: `Bearer ${t.access_token}`, call, client,
    get session() { return session; },
    // the in-laws plan ($372: cleaner, bedding, caterer for six), waiting for a yes
    async inLaws(budget = 400) {
      const m = sc(await call('set_spending_mandate', { budget, period: 'once', purpose: 'In-laws visit' }));
      const steps = [];
      const add = async (name, args) => { const result = await call(name, args); steps.push({ name, result }); return sc(result); };
      const cl = await add('find_home_services', { need: 'deep clean of the guest room', category: 'cleaning', when: 'Friday morning' });
      const bd = await add('find_products', { query: 'queen bedding sheets for the guest room' });
      const ca = await add('find_home_services', { need: 'dinner for six at home', category: 'catering', when: 'Saturday evening', guests: 6 });
      await add('propose_plan', { item_ids: [cl.offers[0].id, bd.offers[0].id, ca.offers[0].id], mandate_id: m.mandate.id });
      for (const s of steps) session = absorbTokens(absorb(session, s.name, s.result), s.result);
      return session.pending;
    },
    async say(text, locale = 'en-US') {
      const r = await fetch(`${BASE}/turn`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, authorization: `Bearer ${t.access_token}`, 'X-Mandat-Visit': 'internal' }, body: JSON.stringify({ text, session, device: 'show', locale }) });
      const out = await r.json();
      if (r.ok) session = out.session || session;
      return { status: r.status, ...out };
    },
    async state() {
      const st = sc(await call('get_household_status', {}));
      const orders = [...(st.open_orders || []), ...(st.recent_orders || [])];
      let plan = null;
      try { plan = sc(await client.callTool({ name: 'review_plan', arguments: {} })).plan || null; } catch {}
      return { st, orders, plan, held: orders.filter((o) => o.state === 'held') };
    },
  };
}
const kind = (l) => (l.kind === 'service' ? l.category : /sheet|sateen|percale|bundle/i.test(l.title) ? 'sheets' : /duvet/i.test(l.title) ? 'duvet' : /towel/i.test(l.title) ? 'towels' : l.title);
const kinds = (p) => (p?.lines || []).map(kind).sort();
const noDup = (p) => new Set(kinds(p)).size === kinds(p).length;
const dollars = (s) => (String(s).match(/\$\s?\d+|\d+\s?\$/g) || []).length;

// [id, story, line, locale, check(state, out, before)] — stories share a household in order; a new story = new household
const CASES = [
  ['linen', 'A', 'Something in linen.', 'en-US', (s, o, b) => [
    ['plan unchanged (same plan, $372)', s.plan?.id === b.plan_id && s.plan?.breakdown?.total === 372],
    ['2 or 3 options named with prices', dollars(o.speech) >= 2]]],
  ['tomorrow', 'A', 'Can it come tomorrow?', 'en-US', (s, o, b) => [
    ['plan unchanged (no swap for a timing question)', s.plan?.id === b.plan_id && s.plan?.breakdown?.total === 372 && noDup(s.plan)],
    ['says the real delivery', /2 days|two days/i.test(o.speech)]]],
  ['cheaper', 'A', 'Make it cheaper.', 'en-US', (s) => [
    ['same kinds, no duplicate', JSON.stringify(kinds(s.plan)) === JSON.stringify(['catering', 'cleaning', 'sheets']) && noDup(s.plan)],
    ['total not higher than $372', (s.plan?.breakdown?.total ?? 999) <= 372],
    ['no money moved', s.orders.length === 0]]],
  ['drop', 'A', 'Drop the caterer.', 'en-US', (s) => [
    ['caterer gone, cleaner and bedding kept', JSON.stringify(kinds(s.plan)) === JSON.stringify(['cleaning', 'sheets'])],
    ['total went down', (s.plan?.breakdown?.total ?? 999) < 372],
    ['no money moved', s.orders.length === 0]]],
  ['yeah-but', 'A', 'Yeah sure, but cheaper.', 'en-US', (s) => [
    ['not booked (an ambiguous yes is not a yes)', s.orders.length === 0],
    ['a plan still waits, no duplicate', !!s.plan && noDup(s.plan)]]],
  ['french-yes', 'A', 'Oui, réserve.', 'fr-FR', (s, o, b) => [
    ['booked once: one hold per plan line, distinct PayPal authorizations', b.lines > 0 && s.held.length === b.lines && new Set(s.held.map((x) => x.paypal_authorization)).size === b.lines && new Set(s.held.map((x) => x.plan_id)).size === 1],
    ['answered in French', /réserv|paiement/i.test(o.speech)]]],
  ['what-booked', 'A', 'What did you book?', 'en-US', (s, o, b) => [
    ['nothing new booked or paid', s.held.length === b.held && s.orders.every((x) => x.state === 'held')],
    ['names what is booked', /BrightNest|Hearth/i.test(o.speech)]]],
  ['cancel-all', 'A', 'Cancel everything.', 'en-US', (s) => [
    ['every hold voided, nothing captured', s.orders.length > 0 && s.orders.every((x) => x.state === 'released')]]],
  ['budget-mid', 'B', 'Actually, make the budget $350 instead.', 'en-US', (s) => [
    ['budget now $350 (one active once-budget)', (s.st.envelopes || []).filter((e) => e.period === 'once').length === 1 && (s.st.envelopes || []).find((e) => e.period === 'once')?.budget === 350],
    ['no money moved', s.orders.length === 0]]],
  ['yes-over', 'B', 'Yes.', 'en-US', (s) => [
    ['never more than the $350 budget on hold', s.held.reduce((x, o) => x + o.amount, 0) <= 350],
    ['no duplicate holds', new Set(s.held.map((x) => x.paypal_authorization)).size === s.held.length]]],
  ['tv', 'C', 'Buy me a TV.', 'en-US', (s, o) => [
    ['nothing planned or bought', !s.plan && s.orders.length === 0],
    ['says what it can do instead', /clean|cater|plumb|handyman|bedding|pet|coffee|household|home/i.test(o.speech)]]],
];

const t0 = (await (await fetch(`${BASE}/healthz`)).json()).llm_budget.usd;
const homes = {};
let fails = 0;
const rows = [];
for (const [id, story, line, locale, check] of CASES) {
  if (ONLY.length && !ONLY.includes(id) && !ONLY.includes(story)) continue;
  if (!homes[story]) { homes[story] = await household(); if (story !== 'C') await homes[story].inLaws(); }
  const h = homes[story];
  const pre = await h.state();
  const before = { plan_id: h.session.pending?.plan_id, lines: pre.plan?.lines?.length || 0, held: pre.held.length };
  const out = await h.say(line, locale);
  const s = await h.state();
  const checks = [['HTTP 200', out.status === 200], ['no technical words said', !TECH.test(out.speech || '')], ...check(s, out, before)];
  const bad = checks.filter(([, ok]) => !ok);
  if (bad.length) fails++;
  rows.push({ id, line, ok: !bad.length, bad: bad.map(([n]) => n), tools: (out.steps || []).map((x) => x.name + (x.result?.isError ? '!' : '') + (bad.length ? JSON.stringify(x.args) : '')).join(','), speech: out.speech, host: out.host_intent });
  console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${id.padEnd(12)} "${line}"  [${out.host_intent ? 'host ' + out.host_intent : 'Nova'}: ${rows.at(-1).tools || '-'}]${bad.length ? '  ✗ ' + bad.map(([n]) => n).join('; ') : ''}`);
  console.log(`      says: ${out.speech}`);
}
for (const h of Object.values(homes)) await h.client.close().catch(() => {});
const t1 = (await (await fetch(`${BASE}/healthz`)).json()).llm_budget.usd;
console.log(`----\n${rows.length - fails} passed, ${fails} failed · Bedrock spend $${(t1 - t0).toFixed(4)}`);
process.exit(fails ? 1 : 0);
