// Autonomy settings enforced by the server for each level, categories, daily limit, the emergency stop, settings by
// voice (first run question by question, in three languages), "delete my data", and the honest "why" of an item.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, client, sc, text, inLawsPlan } from './helpers.mjs';
import { autonomyVerdict, applyPatch, DEFAULTS } from '../src/core/settings.mjs';
import { parseSettings, detectHostIntent } from '../src/brain/host-intents.mjs';

const srv = await boot();
test.after(() => srv.close());

async function shopFor(c, query) { return sc(await c.callTool({ name: 'find_products', arguments: { query } })); }
async function setup(level, extra = {}) {
  const c = await client(srv.mcpUrl);
  await c.callTool({ name: 'get_settings', arguments: { first_run: true } });
  const u = await c.callTool({ name: 'update_settings', arguments: { autonomy: level, ...extra, onboarded: true } });
  assert.ok(!u.isError, text(u));
  return c;
}
const propose = async (c, offerId) => sc(await c.callTool({ name: 'propose_plan', arguments: { item_ids: [offerId] } }));

test('pure rules: each level, the daily limit, and pause', () => {
  const s = { ...DEFAULTS };
  assert.equal(autonomyVerdict({ settings: { ...s, autonomy: 'ask' }, threshold: 40, total: 5 }).auto, false);
  assert.equal(autonomyVerdict({ settings: s, threshold: 40, total: 34 }).auto, true);
  assert.equal(autonomyVerdict({ settings: s, threshold: 40, total: 52 }).reason, 'above_rule');
  assert.equal(autonomyVerdict({ settings: s, threshold: 40, total: 34, autoSpentToday: 40 }).reason, 'daily_cap');
  assert.equal(autonomyVerdict({ settings: { ...s, autonomy: 'hands_off' }, threshold: 40, total: 55 }).auto, true);
  assert.equal(autonomyVerdict({ settings: { ...s, autonomy: 'hands_off' }, threshold: 40, total: 61 }).auto, false);
  assert.equal(autonomyVerdict({ settings: { ...s, paused: true }, threshold: 40, total: 1 }).reason, 'paused');
  assert.equal(applyPatch(s, { auto_buy_under: 200 }).error.key, 'set_e_auto_over_week');
  assert.equal(applyPatch(s, { auto_buy_under: 70 }).error.key, 'set_e_auto_over_cap');
  assert.equal(applyPatch(s, { weekly_budget: 5 }).error.key, 'set_e_range');
  assert.deepEqual(applyPatch(s, { categories_off: ['catering'] }).next.categories, ['cleaning', 'repairs', 'home', 'pets', 'pantry']);
});

test('Ask me first: even a $34 restock under the auto-buy amount waits for a yes', async () => {
  const c = await setup('ask');
  const dog = (await shopFor(c, 'dog food')).offers[0];
  const p = await propose(c, dog.id);
  assert.equal(p.needs_user_yes, true);
  assert.equal(p.plan.auto_reason, 'ask');
  const no = await c.callTool({ name: 'confirm_plan', arguments: { plan_id: p.plan.id, confirmation_token: p.confirmation_token } });
  assert.ok(no.isError, 'no yes, no purchase');
  await c.close();
});

test('Balanced: buys $34 on its own, asks for $52, and the daily limit stops the next auto-buy', async () => {
  const c = await setup('balanced', { daily_cap: 60 });
  const dog = (await shopFor(c, 'dog food')).offers.find((o) => /Salmon/.test(o.title));
  const p1 = await propose(c, dog.id);
  assert.equal(p1.needs_user_yes, false);
  const r1 = await c.callTool({ name: 'confirm_plan', arguments: { plan_id: p1.plan.id, confirmation_token: p1.confirmation_token, user_confirmation: 'We are out of dog food' } });
  assert.ok(!r1.isError, text(r1));
  assert.equal(sc(r1).receipt.orders[0].auto, true);
  const coffee = (await shopFor(c, 'Northbeam coffee')).offers.find((o) => /Northbeam/.test(o.title));
  assert.equal((await propose(c, coffee.id)).needs_user_yes, true, '$52 is above the $40 rule');
  // $34 already bought alone today: another $34 would pass the $60 daily limit
  const dog2 = (await shopFor(c, 'dog food')).offers.find((o) => /Salmon/.test(o.title));
  const raw = await c.callTool({ name: 'propose_plan', arguments: { item_ids: [dog2.id] } });
  const p3 = sc(raw);
  assert.equal(p3.needs_user_yes, true);
  assert.equal(p3.plan.auto_reason, 'daily_cap');
  assert.match(text(raw), /more than I may buy on my own today \(\$26 left of your daily limit\), so I need your yes\. Should I book it\?/);
  await c.close();
});

test('Hands-off within limits: $52 bought alone inside a $100 daily limit; the yes is re-checked at confirmation', async () => {
  const c = await setup('hands_off', { daily_cap: 100 });
  const coffee = (await shopFor(c, 'Northbeam coffee')).offers.find((o) => /Northbeam/.test(o.title));
  const p = await propose(c, coffee.id);
  assert.equal(p.needs_user_yes, false);
  assert.equal(p.plan.auto_reason, 'hands_off');
  // the household switches to "Ask me first" before the plan is confirmed: the server asks again
  await c.callTool({ name: 'update_settings', arguments: { autonomy: 'ask' } });
  const r = await c.callTool({ name: 'confirm_plan', arguments: { plan_id: p.plan.id, confirmation_token: p.confirmation_token, user_confirmation: 'restock' } });
  assert.ok(r.isError, 'level changed to ask: no purchase without a yes');
  await c.close();
});

test('a category turned off is never planned, even with a yes', async () => {
  const c = await setup('balanced');
  await c.callTool({ name: 'update_settings', arguments: { categories_off: ['pets'] } });
  const dog = (await shopFor(c, 'dog food')).offers[0];
  const r = await c.callTool({ name: 'propose_plan', arguments: { item_ids: [dog.id] } });
  assert.ok(r.isError);
  assert.match(text(r), /Pet supplies is turned off/);
  await c.close();
});

test('weekly budget by voice and in settings are the same envelope (changed in place, held money kept)', async () => {
  const c = await setup('balanced');
  const st = sc(await c.callTool({ name: 'get_household_status', arguments: {} }));
  assert.equal(st.envelopes[0].budget, 150);
  const u = await c.callTool({ name: 'update_settings', arguments: { weekly_budget: 200 } });
  assert.match(text(u), /Weekly budget: \$200/);
  const st2 = sc(await c.callTool({ name: 'get_household_status', arguments: {} }));
  assert.equal(st2.envelopes.length, 1);
  assert.equal(st2.envelopes[0].budget, 200);
  assert.equal(st2.envelopes[0].mandate_id, st.envelopes[0].mandate_id, 'same envelope');
  assert.equal(st2.settings.weekly_budget, 200);
  await c.close();
});

test('emergency stop: voids every hold, drops plans waiting for a yes, refuses even a yes; resume turns it back on', async () => {
  const c = await setup('balanced');
  const { plan } = await inLawsPlan(c);
  const p = sc(plan);
  const held = await c.callTool({ name: 'confirm_plan', arguments: { plan_id: p.plan.id, confirmation_token: p.confirmation_token, user_confirmation: 'Yes, book it' } });
  assert.equal(sc(held).receipt.orders.length, 3);
  const dog = (await shopFor(c, 'dog food')).offers[0];
  const coffee = (await shopFor(c, 'Northbeam coffee')).offers.find((o) => /Northbeam/.test(o.title));
  const waiting = await propose(c, coffee.id);
  const stop = await c.callTool({ name: 'pause_spending', arguments: {} });
  assert.match(text(stop), /Mandat is paused\. I voided 3 payment holds \(\$372\)/);
  assert.match(text(stop), /dropped 1 plan/);
  const st = sc(await c.callTool({ name: 'get_household_status', arguments: {} }));
  assert.equal(st.open_orders.length, 0);
  assert.equal(st.envelopes.find((e) => e.purpose === 'In-laws visit').remaining, 400, 'every dollar back in the envelope');
  assert.equal(st.settings.paused, true);
  const yes = await c.callTool({ name: 'confirm_plan', arguments: { plan_id: waiting.plan.id, confirmation_token: waiting.confirmation_token, user_confirmation: 'Yes' } });
  assert.ok(yes.isError);
  const p2 = await c.callTool({ name: 'propose_plan', arguments: { item_ids: [dog.id] } });
  assert.ok(p2.isError);
  assert.match(text(p2), /paused/);
  const back = await c.callTool({ name: 'resume_spending', arguments: {} });
  assert.match(text(back), /back on/);
  assert.equal((await propose(c, dog.id)).needs_user_yes, false);
  await c.close();
});

test('settings said aloud: English, French, Spanish', () => {
  assert.deepEqual(parseSettings('Make it 200 a week, and buy on your own under $40.'), { weekly_budget: 200, auto_buy_under: 40 });
  assert.deepEqual(parseSettings('Balanced'), { autonomy: 'balanced' });
  assert.deepEqual(parseSettings('hands-off within limits, 80 a day'), { daily_cap: 80, autonomy: 'hands_off' });
  assert.deepEqual(parseSettings('No catering.'), { categories_off: ['catering'] });
  assert.deepEqual(parseSettings('200 par semaine'), { weekly_budget: 200 });
  assert.deepEqual(parseSettings('Demande-moi d’abord'), { autonomy: 'ask' });
  assert.deepEqual(parseSettings('200 dólares a la semana y equilibrado'), { weekly_budget: 200, autonomy: 'balanced' });
  assert.deepEqual(parseSettings('60', 'daily_cap'), { daily_cap: 60 });
  for (const s of ['Alexa, pause Mandat.', 'Stop all spending!', 'Mets Mandat en pause', 'Arrête toutes les dépenses', 'Pausa Mandat', 'Detén todos los gastos']) assert.equal(detectHostIntent(s).kind, 'pause', s);
  for (const s of ['Resume Mandat', 'Reprends Mandat', 'Réactive Mandat', 'Reanuda Mandat']) assert.equal(detectHostIntent(s).kind, 'resume', s);
  for (const s of ['Alexa, open Mandat settings', 'Ouvre les réglages de Mandat', 'Abre los ajustes de Mandat']) assert.equal(detectHostIntent(s).kind, 'open_settings', s);
  assert.equal(detectHostIntent('Alexa, my in-laws land Saturday. Get the guest room ready: a cleaner Friday, fresh bedding, and dinner for six at home Saturday. Keep it under $400.', { settingsOpen: true }), null, 'a long errand is never read as a setting');
  assert.equal(detectHostIntent('How much is left?'), null);
});

// one voice turn through POST /turn, keeping the session like the simulator does
function voice(household, device = 'dot', locale = 'en-US') {
  let session = {};
  return async (t) => {
    const r = await fetch(`${srv.url}/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t, session, household, device, locale }) });
    const out = await r.json();
    session = out.session || session;
    return out;
  };
}

test('Echo Dot first run, question by question, then "that\'s all"', async () => {
  const hh = 'dot-' + Math.random().toString(36).slice(2, 8);
  const say = voice(hh);
  const open = await say('Alexa, open Mandat settings.');
  assert.equal(open.host_intent, 'open_settings');
  assert.match(open.speech, /what weekly budget should Mandat stay inside\? It is \$150 for now/);
  const a = await say('200');
  assert.match(a.speech, /^Weekly budget: \$200\. How much freedom should Mandat have/);
  const b = await say('Balanced.');
  assert.match(b.speech, /^Balanced\. Under what amount may I buy on my own, without asking\? It is \$40 now\./);
  const c = await say('Keep it.');
  assert.match(c.speech, /^OK\. Last one: a daily limit/);
  const d = await say("That's all.");
  assert.match(d.speech, /^All set: \$200 a week\. Balanced: I buy on my own under \$40, up to \$60 a day, and ask above that\./);
  assert.equal(d.session.onboarding, null);
  const m = await client(srv.mcpUrl, hh);
  assert.equal(sc(await m.callTool({ name: 'get_settings', arguments: {} })).settings.onboarded, true);
  await m.close();
});

test('first run in French and Spanish; the card follows the voice', async () => {
  const fr = voice('fr-' + Math.random().toString(36).slice(2, 8), 'show', 'fr-FR');
  assert.match((await fr('Ouvre les réglages de Mandat')).speech, /quel budget par semaine/);
  const r = await fr('250 par semaine');
  assert.match(r.speech, /Budget hebdomadaire : 250 \$/);
  assert.deepEqual(r.steps.map((s) => s.name), ['update_settings']);
  assert.deepEqual(r.steps[0].result.structuredContent.changed, ['weekly_budget']);
  const es = voice('es-' + Math.random().toString(36).slice(2, 8), 'show', 'es-ES');
  await es('Abre los ajustes de Mandat');
  assert.match((await es('Autónomo dentro de los límites')).speech, /Autónomo dentro de los límites/);
});

test('emergency stop and "delete my data" by voice never reach the model', async () => {
  const hh = 'v-' + Math.random().toString(36).slice(2, 8);
  const say = voice(hh, 'show');
  await say('Alexa, open Mandat settings');
  const p = await say('Stop all spending.');
  assert.equal(p.host_intent, 'pause');
  assert.match(p.speech, /Mandat is paused/);
  assert.equal((await say('Resume Mandat')).host_intent, 'resume');
  const ask = await say('Delete my Mandat data.');
  assert.match(ask.speech, /cannot be undone\. Say “yes, delete it” to confirm/);
  const no = await say('No, wait.');
  assert.match(no.speech, /nothing was deleted/);
  await say('Delete my data');
  const yes = await say('Yes, delete it.');
  assert.equal(yes.unlinked, true);
  assert.match(yes.speech, /erased this household/);
  assert.equal((await srv.service.store.query(`HOUSEHOLD#${hh}`, '')).length, 0);
});

test('item card: a dearer option shows its extra cost in amber, with what it is chosen for', async () => {
  const c = await client(srv.mcpUrl);
  const { bed, plan } = await inLawsPlan(c);
  const sateen = sc(bed).offers.find((o) => /sateen/i.test(o.title));
  const rev = sc(await c.callTool({ name: 'revise_plan', arguments: { plan_id: sc(plan).plan.id, remove_offer_ids: [sc(bed).offers[0].id], add_offer_ids: [sateen.id] } }));
  assert.ok(rev.plan);
  const r = await c.callTool({ name: 'get_offer_details', arguments: { offer_id: sateen.id } });
  const why = sc(r).why;
  assert.deepEqual(why.map((w) => w.tone).slice(0, 2), ['plus', 'cost']);
  assert.match(why[0].text, /^Chosen for cotton sateen, silky finish/);
  assert.match(why[1].text, /^Costs \$12 more than Guest bed bundle, the cheapest similar option$/);
  assert.match(text(r), /Chosen for cotton sateen.*Costs \$12 more/);
  await c.close();
});
