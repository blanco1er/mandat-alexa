// Guards added when the brain moved to Amazon Nova on Bedrock (18 Oct 2026): the merchants' booking systems stay
// the truth over any model, a part refund on a held order settles it first, caterers need a guest count, the public
// demo has per-IP limits, and the LLM budget is shared across Lambda containers. No AWS call: Bedrock is faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, client, inLawsPlan, sc, text } from './helpers.mjs';
import { createLimiter } from '../src/app.mjs';
import { guardQuote, merchant } from '../src/core/merchants.mjs';
import { BedrockProvider } from '../src/providers/bedrock.mjs';
import * as spend from '../src/core/spend.mjs';

const srv = await boot();
test.after(() => srv.close());

test('a quote for a day the merchant is closed is dropped, whatever the model said', () => {
  const hearth = merchant('m_hearth'); // closed Sunday and Monday
  assert.equal(guardQuote(hearth, { total: 195, day: 'sun', slot: '19:30' }, 6), null);
  assert.ok(guardQuote(hearth, { total: 195, day: 'sat', slot: '19:30' }, 6));
});

test('caterers need a guest count: no dinner priced for one by accident', async () => {
  const c = await client(srv.mcpUrl);
  const r = await c.callTool({ name: 'find_home_services', arguments: { category: 'catering', need: 'family dinner at home', when: 'Sunday evening' } });
  assert.equal(r.isError, true);
  assert.match(text(r), /How many guests/);
  await c.close();
});

test('a part refund on an order still on hold settles it first: held -> captured -> refunded', async () => {
  const c = await client(srv.mcpUrl);
  const { plan } = await inLawsPlan(c);
  const conf = await c.callTool({ name: 'confirm_plan', arguments: { plan_id: sc(plan).plan.id, confirmation_token: sc(plan).confirmation_token, user_confirmation: 'yes' } });
  const bedding = sc(conf).receipt.orders.find((o) => o.kind === 'product');
  const r = await c.callTool({ name: 'close_order', arguments: { order_id: bedding.id, action: 'refund', amount: 28, confirmation_token: bedding.close_token } });
  assert.ok(!r.isError, text(r));
  const o = sc(r).receipt.orders[0];
  assert.deepEqual(o.timeline.map((t) => t.state), ['held', 'captured', 'refunded']);
  assert.equal(o.captured, bedding.amount);
  assert.equal(o.refunded, 28);
  assert.match(text(r), /Paid .* then: Refunded \$28/);
  await c.close();
});

test('the assistant data carries what a model needs to chain calls (recommended offer, order dates, mandate)', async () => {
  const c = await client(srv.mcpUrl);
  const { plan } = await inLawsPlan(c);
  await c.callTool({ name: 'confirm_plan', arguments: { plan_id: sc(plan).plan.id, confirmation_token: sc(plan).confirmation_token, user_confirmation: 'yes' } });
  const st = await c.callTool({ name: 'get_household_status', arguments: { section: 'orders' } });
  const data = JSON.parse(st.content[1].text.replace(/^Assistant data \(do not read aloud\):\s*/, ''));
  const clean = data.open_orders.find((o) => o.category === 'cleaning');
  assert.ok(clean.when && clean.mandate_id && clean.budget === 'In-laws visit');
  const found = await c.callTool({ name: 'find_home_services', arguments: { category: 'cleaning', need: 'clean', when: 'Friday morning' } });
  const ids = JSON.parse(found.content[1].text.replace(/^Assistant data \(do not read aloud\):\s*/, ''));
  assert.equal(ids.recommended_offer_id, ids.offers[0].offer_id);
  await c.close();
});

test('per-IP limiter: N per hour, then a retry-after', () => {
  let t = 0;
  const hit = createLimiter({ perHour: 2, now: () => t });
  assert.ok(hit('1.2.3.4').ok);
  assert.ok(hit('1.2.3.4').ok);
  const third = hit('1.2.3.4');
  assert.equal(third.ok, false);
  assert.ok(third.retryAfter > 0);
  assert.ok(hit('5.6.7.8').ok, 'other addresses are not affected');
  t += 3_600_001;
  assert.ok(hit('1.2.3.4').ok, 'the window slides');
  assert.ok(createLimiter({ perHour: 0 })('x').ok, '0 = no limit');
});

test('/turn answers 429 with a spoken sentence once an address is over its limit', async () => {
  process.env.MANDAT_LIMIT_TURNS = '1';
  const { start } = await import('../src/server.mjs');
  const s = await start({ port: 0, storeKind: 'memory', modelKind: 'simulated', brainKind: 'simulated' });
  try {
    const turn = () => fetch(`${s.url}/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'How much is left?', household: 'lim' }) });
    assert.equal((await turn()).status, 200);
    const r = await turn();
    assert.equal(r.status, 429);
    assert.match((await r.json()).speech, /nothing was booked or charged/);
  } finally { delete process.env.MANDAT_LIMIT_TURNS; await s.close(); }
});

test('shared LLM budget: a ledger total above the ceiling stops model calls in every container', async () => {
  spend._reset();
  process.env.MANDAT_LLM_BUDGET_USD = '1';
  let total = 0.5;
  const added = [];
  spend.setSharedLedger({ total: async () => total, add: async (usd) => { added.push(usd); total += usd; } });
  try {
    await spend.checkBudget(); // under the ceiling
    await spend.recordUsage('us.amazon.nova-2-lite-v1:0', { inputTokens: 100_000, outputTokens: 10_000 });
    assert.ok(Math.abs(added[0] - (0.1 * 0.33 + 0.01 * 2.75)) < 1e-9, 'Nova 2 Lite price per token');
    total = 1.2; // another container spent the rest
    spend._reset(); spend.setSharedLedger({ total: async () => total, add: async () => {} });
    await assert.rejects(spend.checkBudget(), (e) => e.code === 'LLM_BUDGET');
  } finally { delete process.env.MANDAT_LLM_BUDGET_USD; spend._reset(); }
});

test('Bedrock merchant agent (faked): the booking system sets the floor and the day, the model only talks', async () => {
  const p = new BedrockProvider();
  const sent = [];
  p.client = { send: async (cmd) => { sent.push(cmd.input); return { usage: { inputTokens: 10, outputTokens: 5 }, output: { message: { content: [{ text: '{"reply":"$70 tonight!","quote":{"total":70,"day":"fri","slot":"09:00"}}' }] } } }; } };
  p.sdk = { ConverseCommand: class { constructor(input) { this.input = input; } } };
  const r = await p.merchantAgent({ merchant: merchant('m_flowfix'), when: 'Monday morning', ask: 'fix a leak', guests: null });
  assert.equal(r.quote.total, 109, 'never below what the request qualifies for ($129 - $20 early in the week)');
  assert.match(sent[0].messages[0].content[0].text, /price with the deals this request qualifies for: \$109/);
  const closed = await p.merchantAgent({ merchant: merchant('m_hearth'), when: 'Sunday evening', ask: 'dinner', guests: 6 });
  assert.equal(closed.quote, null, 'closed on Sunday: no quote, whatever the model says');
  const change = await p.merchantChange({ merchant: merchant('m_hearth'), order: { label: 'Dinner', slotLabel: 'Saturday 19:30', amount: 195, guests: 6 }, change: { field: 'date', value: 'Sunday' } });
  assert.equal(change.accepted, false, 'the booking system declines; the model cannot accept');
});

test('under an auto-approve rule, two products cannot be bundled into one plan that hides the small one', async () => {
  const c = await client(srv.mcpUrl);
  await c.callTool({ name: 'set_spending_mandate', arguments: { budget: 150, period: 'weekly', auto_approve_under: 40, purpose: 'Household essentials' } });
  const dog = sc(await c.callTool({ name: 'find_products', arguments: { query: 'dog food' } })).offers[0];
  const coffee = sc(await c.callTool({ name: 'find_products', arguments: { query: 'laundry detergent' } })).offers.find((o) => o.total > 40);
  const both = await c.callTool({ name: 'propose_plan', arguments: { item_ids: [dog.id, coffee.id] } });
  assert.equal(both.isError, true);
  assert.match(text(both), /each product is its own plan/);
  const one = await c.callTool({ name: 'propose_plan', arguments: { item_ids: [dog.id] } });
  assert.equal(sc(one).needs_user_yes, false, 'the small one goes through under the rule');
  await c.close();
});
