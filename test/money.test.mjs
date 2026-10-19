// Money safety: confirmation before any payment, budget never exceeded, idempotency, floors, partial capture/refund.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, client, inLawsPlan, sc, text } from './helpers.mjs';
import * as envelope from '../src/core/envelope.mjs';
import { guardQuote, merchant } from '../src/core/merchants.mjs';
import { isExplicitYes, Mandat } from '../src/mandat.mjs';
import { createStore } from '../src/store/index.mjs';
import { SimulatedProvider } from '../src/providers/simulated.mjs';

const srv = await boot();
test.after(() => srv.close());
const held = async (c) => (await c.callTool({ name: 'get_household_status', arguments: { section: 'orders' } })).structuredContent.open_orders.length;

test('propose_plan moves no money', async () => {
  const c = await client(srv.mcpUrl);
  const { plan } = await inLawsPlan(c);
  assert.equal(sc(plan).needs_user_yes, true);
  assert.equal(await held(c), 0);
  assert.equal(sc(plan).envelope.held, 0);
  await c.close();
});

test('confirm_plan refuses without the plan token, with a wrong token, or without the user\'s yes', async () => {
  const c = await client(srv.mcpUrl);
  const { plan } = await inLawsPlan(c);
  const id = sc(plan).plan.id;
  const tok = sc(plan).confirmation_token;
  for (const args of [
    { plan_id: id, confirmation_token: 'x'.repeat(32), user_confirmation: 'yes' },
    { plan_id: id, confirmation_token: tok },
    { plan_id: id, confirmation_token: tok, user_confirmation: 'hmm, maybe later' },
    { plan_id: id, confirmation_token: tok, user_confirmation: 'no, do not book it' },
    { plan_id: 'plan_0000000000', confirmation_token: tok, user_confirmation: 'yes' },
  ]) {
    const r = await c.callTool({ name: 'confirm_plan', arguments: args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(text(r), /Next step:/);
  }
  assert.equal(await held(c), 0, 'no hold was placed by any refused call');
  const ok = await c.callTool({ name: 'confirm_plan', arguments: { plan_id: id, confirmation_token: tok, user_confirmation: 'Yes, book it' } });
  assert.ok(!ok.isError, text(ok));
  assert.equal(await held(c), 3);
  await c.close();
});

test('the token of one plan cannot confirm another plan', async () => {
  const c = await client(srv.mcpUrl);
  const { plan, clean } = await inLawsPlan(c);
  const other = await c.callTool({ name: 'propose_plan', arguments: { item_ids: [sc(clean).offers[1].id], mandate_id: sc(plan).plan.mandate_id } });
  const r = await c.callTool({ name: 'confirm_plan', arguments: { plan_id: sc(other).plan.id, confirmation_token: sc(plan).confirmation_token, user_confirmation: 'yes' } });
  assert.equal(r.isError, true);
  await c.close();
});

test('only a plan under the auto-approve rule can be confirmed without a yes', async () => {
  const c = await client(srv.mcpUrl);
  await c.callTool({ name: 'set_spending_mandate', arguments: { budget: 150, period: 'weekly', purpose: 'Household essentials', auto_approve_under: 40 } });
  const dog = await c.callTool({ name: 'find_products', arguments: { query: 'dog food' } });
  const coffee = await c.callTool({ name: 'find_products', arguments: { query: 'seventh generation laundry detergent' } });
  const small = await c.callTool({ name: 'propose_plan', arguments: { item_ids: [sc(dog).offers.find((o) => o.total <= 40).id] } });
  const big = await c.callTool({ name: 'propose_plan', arguments: { item_ids: [sc(coffee).offers.find((o) => o.total > 40).id] } });
  assert.equal(sc(small).needs_user_yes, false);
  assert.equal(sc(big).needs_user_yes, true);
  assert.ok(!(await c.callTool({ name: 'confirm_plan', arguments: { plan_id: sc(small).plan.id, confirmation_token: sc(small).confirmation_token } })).isError);
  assert.equal((await c.callTool({ name: 'confirm_plan', arguments: { plan_id: sc(big).plan.id, confirmation_token: sc(big).confirmation_token } })).isError, true);
  await c.close();
});

test('confirm_plan is idempotent: a retry returns the same receipt and holds nothing twice', async () => {
  const c = await client(srv.mcpUrl);
  const { plan } = await inLawsPlan(c);
  const args = { plan_id: sc(plan).plan.id, confirmation_token: sc(plan).confirmation_token, user_confirmation: 'yes' };
  const [a, b] = await Promise.all([c.callTool({ name: 'confirm_plan', arguments: args }), c.callTool({ name: 'confirm_plan', arguments: args })]);
  const third = await c.callTool({ name: 'confirm_plan', arguments: args });
  const ids = (r) => sc(r).receipt.orders.map((o) => o.id).sort().join();
  assert.equal(ids(a), ids(b));
  assert.equal(ids(a), ids(third));
  assert.equal(sc(third).duplicate, true);
  assert.equal(await held(c), 3);
  assert.equal(sc(third).receipt.envelope.held, 380);
  await c.close();
});

test('a plan above what is left in the budget is refused at proposal', async () => {
  const c = await client(srv.mcpUrl);
  const m = await c.callTool({ name: 'set_spending_mandate', arguments: { budget: 100, period: 'once', purpose: 'Small budget' } });
  const food = await c.callTool({ name: 'find_home_services', arguments: { need: 'dinner for six', category: 'catering', when: 'Saturday evening' } });
  const r = await c.callTool({ name: 'propose_plan', arguments: { item_ids: [sc(food).offers[0].id], mandate_id: sc(m).mandate.id } });
  assert.equal(r.isError, true);
  assert.match(text(r), /only \$100 is left/);
  await c.close();
});

test('two plans that each fit but not together: the second confirmation is refused', async () => {
  const c = await client(srv.mcpUrl);
  const m = await c.callTool({ name: 'set_spending_mandate', arguments: { budget: 250, period: 'once', purpose: 'Party' } });
  const food = await c.callTool({ name: 'find_home_services', arguments: { need: 'dinner for six', category: 'catering', when: 'Saturday evening' } });
  const [o1, o2] = sc(food).offers;
  const p1 = await c.callTool({ name: 'propose_plan', arguments: { item_ids: [o1.id], mandate_id: sc(m).mandate.id } });
  const p2 = await c.callTool({ name: 'propose_plan', arguments: { item_ids: [o2.id], mandate_id: sc(m).mandate.id } });
  assert.ok(!p1.isError && !p2.isError);
  assert.ok(!(await c.callTool({ name: 'confirm_plan', arguments: { plan_id: sc(p1).plan.id, confirmation_token: sc(p1).confirmation_token, user_confirmation: 'yes' } })).isError);
  const r = await c.callTool({ name: 'confirm_plan', arguments: { plan_id: sc(p2).plan.id, confirmation_token: sc(p2).confirmation_token, user_confirmation: 'yes' } });
  assert.equal(r.isError, true);
  const st = await c.callTool({ name: 'get_household_status', arguments: { section: 'budget' } });
  const env = sc(st).envelopes.find((e) => e.purpose === 'Party');
  assert.ok(env.remaining >= 0 && env.held <= 250);
  await c.close();
});

test('captures and refunds never exceed what was held or paid', async () => {
  const c = await client(srv.mcpUrl);
  const { plan } = await inLawsPlan(c);
  const conf = await c.callTool({ name: 'confirm_plan', arguments: { plan_id: sc(plan).plan.id, confirmation_token: sc(plan).confirmation_token, user_confirmation: 'yes' } });
  const o = sc(conf).receipt.orders[0];
  assert.equal((await c.callTool({ name: 'close_order', arguments: { order_id: o.id, action: 'capture', amount: o.amount + 1, confirmation_token: o.close_token } })).isError, true);
  assert.equal((await c.callTool({ name: 'close_order', arguments: { order_id: o.id, action: 'capture', confirmation_token: 'wrong-token-123' } })).isError, true);
  assert.ok(!(await c.callTool({ name: 'close_order', arguments: { order_id: o.id, action: 'capture', confirmation_token: o.close_token } })).isError);
  assert.equal((await c.callTool({ name: 'close_order', arguments: { order_id: o.id, action: 'refund', amount: o.amount + 1, confirmation_token: o.close_token } })).isError, true);
  assert.equal((await c.callTool({ name: 'close_order', arguments: { order_id: o.id, action: 'capture', confirmation_token: o.close_token } })).isError, true, 'no double capture');
  await c.close();
});

test('a merchant agent can never price below its floor (guard on any model output)', () => {
  const m = merchant('m_hearth');
  const q = guardQuote(m, { total: 1 }, 6);
  assert.equal(q.total, 210 - 15);
  assert.equal(guardQuote(m, { total: 9999 }, 6).total, 210, 'nor above the list price');
});

test('explicit yes detection', () => {
  for (const y of ['Yes', 'yes, book it', 'Go ahead', 'tap:approve', 'OK do it']) assert.ok(isExplicitYes(y), y);
  for (const n of ['', 'no', 'not yet', 'yes... wait, no', 'maybe', undefined]) assert.ok(!isExplicitYes(n), String(n));
});

test('property: random plans, holds, captures and refunds never take an envelope below zero', async () => {
  const svc = new Mandat({ store: createStore('memory'), provider: new SimulatedProvider() });
  const h = 'fuzz';
  const m = await svc.setSpendingMandate(h, { budget: 300, period: 'once', purpose: 'Fuzz', auto_approve_under: 0 });
  const mid = m.data.mandate.id;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const cats = [['cleaning', 'Friday morning'], ['catering', 'Saturday evening'], ['handyman', 'Saturday morning'], ['plumbing', 'Monday morning']];
  for (let i = 0; i < 40; i++) {
    try {
      const [cat, when] = cats[Math.floor(rnd() * cats.length)];
      const f = await svc.findHomeServices(h, { need: `${cat} for ${1 + Math.floor(rnd() * 6)} guests`, category: cat, when });
      const p = await svc.proposePlan(h, { item_ids: [f.data.offers[Math.floor(rnd() * f.data.offers.length)].id], mandate_id: mid });
      const r = await svc.confirmPlan(h, { plan_id: p.data.plan.id, confirmation_token: p.data.confirmation_token, user_confirmation: 'yes' });
      const o = r.data.receipt.orders[0];
      const act = rnd();
      if (act < 0.4) await svc.closeOrder(h, { order_id: o.id, action: 'capture', amount: Math.round(o.amount * (0.5 + rnd() / 2)), confirmation_token: o.close_token });
      else if (act < 0.6) await svc.closeOrder(h, { order_id: o.id, action: 'cancel', confirmation_token: o.close_token });
    } catch (e) { assert.ok(e.next, 'only ToolErrors are expected: ' + e.message); }
    const env = await svc.envelopeOf(h, await svc.mandate(h, mid));
    const t = envelope.totals(env);
    assert.ok(t.remaining >= -1e-9, `remaining ${t.remaining}`);
    assert.ok(t.held + t.spent <= 300 + 1e-9);
  }
});
