// The 3 demo scenarios of the plan, end to end: utterance -> simulated brain -> real MCP over Streamable HTTP ->
// tools -> simulated PayPal. Each turn opens a new MCP connection (as a stateless deployment would); memory comes
// from the store only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, sc, talker } from './helpers.mjs';

const srv = await boot();
test.after(() => srv.close());
const H = 'scenario-household';
const say = talker(srv.mcpUrl, H);
const tools = (out) => out.steps.map((s) => s.name);
const last = (out, name) => [...out.steps].reverse().find((s) => s.name === name)?.result;

test('onboarding (earlier session): weekly budget with auto-approve under $40, two preferences', async () => {
  const a = await say('Set a weekly household budget of $150, and buy on your own under $40.');
  assert.deepEqual(tools(a), ['set_spending_mandate']);
  assert.equal(a.protocolVersion, '2025-11-25');
  await say('Remember that Max, our dog, is allergic to chicken.');
  const c = await say('Remember we use Seventh Generation detergent.');
  assert.equal(sc(last(c, 'remember_preference')).preferences.length, 2);
});

test('scenario 1 "The in-laws are coming": one sentence -> real cleaners + caterers and demo partners + products -> one mixed plan -> yes -> 3 holds', async () => {
  const out = await say('Alexa, my in-laws land Saturday. Get the guest room ready: a cleaner Friday, fresh bedding, and dinner for six at home Saturday. Keep it under $400.');
  assert.deepEqual(tools(out), ['set_spending_mandate', 'find_home_services', 'find_products', 'find_home_services', 'propose_plan']);
  const plan = sc(last(out, 'propose_plan'));
  assert.equal(plan.plan.lines.length, 3);
  assert.equal(plan.plan.breakdown.total, 380, 'real cleaner $100 estimated + bedding $85 + demo partner $195');
  assert.equal(plan.plan.breakdown.discount, 15, 'only the demo partner negotiates: $210 -> $195 for six');
  assert.equal(plan.needs_user_yes, true);
  assert.match(out.speech, /I found 4 cleaners near Capitol Hill and 4 caterers plus 3 demo partners\./);
  assert.match(out.speech, /Pure House Cleaning, about \$100 estimated.*Hearth Table Catering, a demo partner, \$195/);
  assert.match(out.speech, /Total \$380.*leaves \$20 of your \$400\. .*booking request at an estimated price.*demo partners are simulated\. Should I book it\?/);
  const cleaners = sc(out.steps[1].result);
  assert.ok(cleaners.offers.every((o) => o.source === 'local' && o.estimated && !o.card_verified), 'cleaners are real businesses with estimated prices, no agent');
  assert.ok(cleaners.offers.every((o) => o.total === 100 && o.estimate.qty === 2 && o.estimate.rate === 50), '2 h x $50, the documented rule');
  const caterers = sc(out.steps[3].result);
  assert.equal(caterers.offers[0].source, 'partner');
  assert.ok(caterers.offers.filter((o) => o.source === 'partner').every((o) => o.card_verified), 'every demo partner card verified');
  assert.ok(caterers.offers.some((o) => o.source === 'local'), 'real caterers are listed too');
  const yes = await say('Yes, book it.');
  assert.deepEqual(tools(yes), ['confirm_plan']);
  const r = sc(last(yes, 'confirm_plan')).receipt;
  assert.equal(r.orders.length, 3);
  assert.ok(r.orders.every((o) => o.state === 'held' && /^AUTH-/.test(o.paypal_authorization)));
  assert.equal(r.envelope.held, 380);
  assert.equal(r.envelope.remaining, 20);
  assert.match(yes.speech, /Pure House Cleaning has a booking request at an estimated price, not confirmed by them/);
  assert.doesNotMatch(yes.speech, /Pure House Cleaning (agreed|accepted|confirmed)/);
  assert.equal(r.idempotency_key, plan.plan.id);
});

test('scenario 2 "Four days later": memory across sessions, auto-buys under $40, asks for $52', async () => {
  const out = await say("We're almost out of dog food and laundry detergent.");
  assert.deepEqual(tools(out), ['find_products', 'propose_plan', 'confirm_plan', 'find_products', 'propose_plan']);
  const dog = sc(out.steps[0].result);
  assert.ok(dog.skipped.length >= 1 && dog.skipped.every((s) => /chicken/i.test(s.title)), 'chicken recipes skipped (Max)');
  assert.ok(dog.offers.every((o) => !/chicken/i.test(o.title)));
  assert.equal(sc(out.steps[1].result).plan.auto_approved, true);
  const detergent = sc(out.steps[3].result).offers[0];
  assert.match(detergent.title, /Seventh Generation/, 'the household brand comes first');
  assert.equal(sc(out.steps[4].result).needs_user_yes, true);
  assert.match(out.speech, /Done under your auto-approve rule: Salmon.*\$34, held in test money.*because Max is allergic to chicken/);
  assert.match(out.speech, /Seventh Generation.*\$52, above your auto-approve limit.*should I buy it\?/);
  const yes = await say('Yes');
  assert.deepEqual(tools(yes), ['confirm_plan']);
  assert.equal(sc(last(yes, 'confirm_plan')).receipt.envelope.remaining, 150 - 34 - 52);
});

test('scenario 3 "Plans change": the cleaning request moves, the demo partner declines -> void + replacement -> yes; then partial capture and refund', async () => {
  const out = await say('Their flight moved to Sunday.');
  assert.deepEqual(tools(out), ['get_household_status', 'change_order', 'change_order', 'propose_plan']);
  assert.match(out.speech, /I moved the booking request for Pure House Cleaning to Saturday at 10 AM, same \$100 hold\. Pure House Cleaning has not confirmed it\./);
  assert.match(out.speech, /Hearth Table Catering can't do it.*voided their \$195 hold/);
  assert.match(out.speech, /Olive & Thyme Kitchen can do Sunday at 7:30 PM for \$210/);
  const changed = out.steps.filter((s) => s.name === 'change_order').map((s) => sc(s.result).receipt.orders[0]);
  assert.equal(changed.find((o) => /Hearth Table/.test(o.merchant)).state, 'released');
  assert.equal(changed.find((o) => /Pure House/.test(o.merchant)).state, 'held');
  const yes = await say('Yes, go ahead.');
  assert.equal(sc(last(yes, 'confirm_plan')).receipt.envelope.remaining, 400 - 100 - 85 - 210);
  const settle = await say('Everything went well. Settle up: Olive billed $180, and refund $10 on the sheets.');
  const results = settle.steps.slice(1).map((s) => sc(s.result).receipt.orders[0]);
  const olive = results.find((o) => /Olive/.test(o.merchant));
  assert.deepEqual(olive.timeline.map((t) => t.state), ['held', 'captured', 'released']);
  assert.equal(olive.captured, 180);
  const bedding = results.filter((o) => /Linen/.test(o.merchant)).pop();
  assert.deepEqual(bedding.timeline.map((t) => t.state), ['held', 'captured', 'refunded']);
  assert.match(settle.speech, /\$30 less than held.*released the rest.*Refunded \$10/);
  assert.match(settle.speech, /^Settled 3 orders\./, 'only the event\'s orders, not the weekly restocks');
  const cleaning = results.find((o) => /Pure House/.test(o.merchant));
  assert.equal(cleaning.state, 'captured');
  const status = await say('How much is left?');
  assert.match(status.speech, /In-laws visit: \$45 left of \$400/);
});

test('Echo Dot (screenless) mode: at most 3 options read, explicit "say yes to confirm"', async () => {
  const dot = talker(srv.mcpUrl, 'dot-household', 'dot');
  const out = await dot('My in-laws land Saturday: a cleaner Friday and dinner for six at home Saturday. Keep it under $400.');
  assert.match(out.speech, /Say yes to confirm the plan\.$/);
  assert.doesNotMatch(out.speech, /screen|tap|card/i, 'never refers to the screen');
  const one = await dot('Find a plumber Monday for a leak.');
  assert.ok((one.speech.match(/\$\d+/g) || []).length <= 3 * 2);
});
