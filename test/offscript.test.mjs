// Off the script: what a judge says without following the demo lines. Swap an item described in words without
// asking for other options first, nothing-matches answers, remove without opening, the total mid-way, a yes too
// early or twice, a language change in the middle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, client, sc, text, inLawsPlan, talker } from './helpers.mjs';

const srv = await boot();
test.after(() => srv.close());
const STORY1 = 'Alexa, my in-laws land Saturday. Get the guest room ready: a cleaner Friday, fresh bedding, and dinner for six at home Saturday. Keep it under $400.';

test('swap_item: "sateen set" without asking for options: swapped in, shown, new total said', async () => {
  const c = await client(srv.mcpUrl);
  const { plan } = await inLawsPlan(c);
  const r = await c.callTool({ name: 'swap_item', arguments: { wanted: 'sateen set' } });
  assert.ok(!r.isError, text(r));
  const d = sc(r);
  assert.equal(d.mode, 'detail');
  assert.match(d.offer.title, /King sateen/);
  assert.equal(d.plan.breakdown.total, 384);
  assert.notEqual(d.plan.id, sc(plan).plan.id);
  assert.ok(d.confirmation_token);
  assert.match(text(r), /^Swapped Guest bed bundle for King sateen sheet set, white\. Chosen for cotton sateen.*New total \$384, \$16 left of your \$400\. Should I book it\?$/);
  await c.close();
});

test('swap_item: "a king size" and "another cleaner" and "better rated caterer" find the right line', async () => {
  const c = await client(srv.mcpUrl);
  await inLawsPlan(c);
  assert.match(sc(await c.callTool({ name: 'swap_item', arguments: { wanted: 'a king size' } })).offer.title, /King sateen/);
  // $384 + a $20 dearer cleaner would pass $400: refused with the numbers, nothing changes
  assert.match(text(await c.callTool({ name: 'swap_item', arguments: { wanted: 'another cleaner' } })), /costs \$404 but only \$400 is left/);
  await inLawsPlan(c); // a fresh plan at $372
  const clr = await c.callTool({ name: 'swap_item', arguments: { wanted: 'another cleaner' } });
  const cl = sc(clr);
  assert.ok(cl.offer, text(clr));
  assert.equal(cl.offer.category, 'cleaning');
  assert.notEqual(cl.offer.merchant, 'BrightNest Cleaning');
  await inLawsPlan(c); // fresh $372 plan: Olive & Thyme ($210, better rated) fits
  const ca = await c.callTool({ name: 'swap_item', arguments: { wanted: 'better rated', item: 'caterer' } });
  assert.ok(sc(ca).offer, text(ca));
  assert.equal(sc(ca).offer.category, 'catering');
  await c.close();
});

test('swap_item: nothing matches -> the closest options, plan unchanged, never a bare "not found"', async () => {
  const c = await client(srv.mcpUrl);
  const { plan } = await inLawsPlan(c);
  const r = await c.callTool({ name: 'swap_item', arguments: { wanted: 'something in silk' } });
  assert.ok(!r.isError);
  assert.match(text(r), /^I don't have “something in silk” among the options\. The closest: .*\$\d+.*Want one of these\?$/);
  assert.doesNotMatch(text(r), /couldn't find/i);
  assert.equal(sc(await c.callTool({ name: 'review_plan', arguments: {} })).plan.id, sc(plan).plan.id, 'the plan did not change');
  assert.match(text(await c.callTool({ name: 'swap_item', arguments: { wanted: 'cheaper' } })), /already the cheapest option of its kind/);
  assert.match(text(await c.callTool({ name: 'swap_item', arguments: { wanted: 'cheaper', item: 'caterer' } })), /Hearth Table Catering is already the cheapest option, at \$195\./);
  await c.close();
});

test('voice, off script: swap with no options asked, remove without opening, the total mid-way, yes twice', async () => {
  const say = talker(srv.mcpUrl, 'off-' + Math.random().toString(36).slice(2, 7));
  await say(STORY1);
  const swap = await say('Take the sateen set instead.');
  assert.ok(swap.steps.some((s) => ['swap_item', 'revise_plan'].includes(s.name) && !s.result.isError), swap.steps.map((s) => s.name).join());
  assert.match(swap.speech, /\$384/);
  const rm = await say('Remove the bedding.');
  assert.ok(rm.steps.some((s) => s.name === 'revise_plan' && !s.result.isError));
  const total = await say("What's the total so far?");
  assert.match(total.speech, /\$280/);
  const yes = await say('Yes, book it.');
  assert.equal(yes.steps.find((s) => s.name === 'confirm_plan').result.structuredContent.receipt.orders.length, 2);
  const again = await say('Yes, book it.');
  assert.ok(!again.steps.some((s) => s.name === 'confirm_plan' && !s.result.isError && !s.result.structuredContent.duplicate), 'no second booking');
  assert.match(again.speech, /Nothing is waiting for your yes/);
});

test('voice, off script: a yes before any plan moves no money; the language can change mid-way', async () => {
  const hh = 'early-' + Math.random().toString(36).slice(2, 7);
  const early = await talker(srv.mcpUrl, hh)('Yes, book it.');
  assert.ok(!early.steps.some((s) => s.name === 'confirm_plan' && !s.result.isError));
  assert.match(early.speech, /nothing was booked or charged/);
  const c = await client(srv.mcpUrl, hh);
  assert.equal((sc(await c.callTool({ name: 'get_household_status', arguments: {} })).open_orders || []).length, 0);
  await c.close();
  // an English plan, then the language switched to French: the French yes books it and Alexa answers in French
  const { SimulatedBrain } = await import('../src/brain/simulated.mjs');
  const brain = new SimulatedBrain({ mcpUrl: srv.mcpUrl });
  const h2 = 'lang-' + Math.random().toString(36).slice(2, 7);
  const a = await brain.runTurn({ text: STORY1, session: { device: 'show' }, household: h2, locale: 'en-US' });
  const b = await brain.runTurn({ text: 'Oui, réserve.', session: a.session, household: h2, locale: 'fr-FR' });
  assert.ok(b.steps.some((s) => s.name === 'confirm_plan' && !s.result.isError));
  assert.match(b.speech, /réservé/);
});

test('POST /turn: a bare yes with nothing waiting is answered by the host, no model, no tool, no money', async () => {
  const r = await fetch(`${srv.url}/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Yes, book it.', session: {}, household: 'host-yes', locale: 'en-US' }) });
  const out = await r.json();
  assert.equal(out.host_intent, 'nothing_waiting');
  assert.deepEqual(out.steps, []);
  assert.match(out.speech, /Nothing is waiting for your yes right now, so nothing was booked or charged\./);
  const fr = await (await fetch(`${srv.url}/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Oui, réserve.', session: {}, household: 'host-yes', locale: 'fr-FR' }) })).json();
  assert.match(fr.speech, /Rien n’attend votre oui/);
});

test('"can it come tomorrow?" is answered with the real delivery; a swap is always like for like', async () => {
  const c = await client(srv.mcpUrl);
  const { clean, bed, plan } = await inLawsPlan(c);
  const t = await c.callTool({ name: 'swap_item', arguments: { wanted: 'can it come tomorrow', item: 'bedding' } });
  assert.match(text(t), /^Hearth & Linen delivers in 2 days, so the Guest bed bundle cannot come tomorrow\. Nothing changed: your plan is still \$372\.$/);
  assert.equal(sc(await c.callTool({ name: 'review_plan', arguments: {} })).plan.id, sc(plan).plan.id);
  // seen live: the bedding swapped for a second cleaner to "answer" a timing question -> refused by the server
  const other = sc(clean).offers[1];
  const bad = await c.callTool({ name: 'revise_plan', arguments: { plan_id: sc(plan).plan.id, remove_offer_ids: [sc(bed).offers[0].id], add_offer_ids: [other.id] } });
  assert.ok(bad.isError);
  assert.match(text(bad), /different kind/);
  const dup = await c.callTool({ name: 'revise_plan', arguments: { plan_id: sc(plan).plan.id, add_offer_ids: [other.id] } });
  assert.ok(dup.isError);
  assert.match(text(dup), /already has one/);
  // nothing in linen besides what is in the plan: up to three closest options
  const linen = await c.callTool({ name: 'swap_item', arguments: { wanted: 'linen' } });
  assert.equal(sc(linen).offers.length - 1, 3, text(linen));
  await c.close();
});
