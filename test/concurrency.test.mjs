// Seen live on 20 Oct 2026 (public demo, Amazon Nova making parallel tool calls on two Lambda containers):
//  1. two confirm_plan calls rewrote the same envelope from stale copies: one order vanished from the budget, and a
//     later refund on it failed with "Unknown payment" AFTER PayPal had captured (the order stayed "held");
//  2. the emergency stop then failed as a whole on that authorization (PayPal void -> 422 PREVIOUSLY_CAPTURED).
// Two Mandat instances on one store stand for two containers on one DynamoDB table. Fake PayPal, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers.mjs';
import { Mandat } from '../src/mandat.mjs';
import * as envelope from '../src/core/envelope.mjs';
import { createStore } from '../src/store/index.mjs';
import { createProvider } from '../src/providers/index.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function fakePaypal({ failVoid = {}, failRefundOnce = false } = {}) {
  const calls = [];
  let n = 0;
  const id = (p) => `${p}-${++n}`;
  return {
    calls, MODE: 'offline',
    async hold(a) { calls.push(['hold', a]); await pause(25); return { orderId: id('O'), authorizationId: id('AUTH'), mode: 'offline' }; },
    async capture(a) { calls.push(['capture', a]); await pause(5); return { captureId: id('CAP'), status: 'COMPLETED', mode: a.mode }; },
    async release(a) { calls.push(['void', a]); if (failVoid[a.authorizationId]) throw new Error(failVoid[a.authorizationId]); return { status: 'VOIDED', mode: a.mode }; },
    async refund(a) { calls.push(['refund', a]); if (failRefundOnce) { failRefundOnce = false; throw new Error('PayPal refund -> 500 INTERNAL_SERVER_ERROR'); } return { refundId: id('REF'), status: 'COMPLETED', mode: a.mode }; },
  };
}
const make = (store, paypal) => new Mandat({ store, provider: createProvider('simulated'), paypal, publicUrl: 'https://demo.example' });
async function twoPlans(m, hid) {
  const mdt = await m.setSpendingMandate(hid, { budget: 400, period: 'weekly', purpose: 'Household', auto_approve_under: 0 });
  const clean = await m.findHomeServices(hid, { need: 'deep clean', category: 'cleaning', when: 'Friday morning' });
  const food = await m.findHomeServices(hid, { need: 'dinner for six', category: 'catering', when: 'Saturday evening', guests: 6 });
  const p1 = await m.proposePlan(hid, { item_ids: [clean.data.offers[0].id] });
  const p2 = await m.proposePlan(hid, { item_ids: [food.data.offers[0].id] });
  return { mdt, p1: p1.data, p2: p2.data };
}
const envelopes = async (store, hid) => (await store.query(`HOUSEHOLD#${hid}`, 'ENVELOPE#')).map((r) => r.value);

test('two containers confirming two plans at once: both orders stay in the budget (no lost write)', async () => {
  const store = createStore('memory');
  const pp = fakePaypal();
  const a = make(store, pp), b = make(store, pp);
  const { p1, p2 } = await twoPlans(a, 'h-race');
  const [r1, r2] = await Promise.all([
    a.confirmPlan('h-race', { plan_id: p1.plan.id, confirmation_token: p1.confirmation_token, user_confirmation: 'Yes' }),
    b.confirmPlan('h-race', { plan_id: p2.plan.id, confirmation_token: p2.confirmation_token, user_confirmation: 'Yes' }),
  ]);
  const ids = [...r1.data.receipt.orders, ...r2.data.receipt.orders].map((o) => o.id);
  const [env] = await envelopes(store, 'h-race');
  assert.deepEqual(env.entries.map((e) => e.id).sort(), ids.sort(), 'every held order is in the envelope');
  assert.equal(envelope.totals(env).held, Math.round((p1.plan.breakdown.total + p2.plan.breakdown.total) * 100) / 100);
  const orders = (await store.query('HOUSEHOLD#h-race', 'ORDER#')).map((r) => r.value);
  assert.ok(orders.every((o) => o.envelope_key && o.envelope_key.startsWith('ENVELOPE#')), 'each order records its envelope');
});

test('a part refund on an order missing from its envelope works: entry restored, PayPal captured once, records match', async () => {
  const store = createStore('memory');
  const pp = fakePaypal();
  const m = make(store, pp);
  const { p1 } = await twoPlans(m, 'h-lost');
  const rec = await m.confirmPlan('h-lost', { plan_id: p1.plan.id, confirmation_token: p1.confirmation_token, user_confirmation: 'Yes' });
  const o = rec.data.receipt.orders[0];
  // what the lost write left behind on 20 Oct: an envelope without the order, an order without envelope_key (old row)
  const [row] = await store.query('HOUSEHOLD#h-lost', 'ENVELOPE#');
  await store.put('HOUSEHOLD#h-lost', row.sk, { ...row.value, entries: [] });
  const ord = await store.get('HOUSEHOLD#h-lost', `ORDER#${o.id}`);
  delete ord.envelope_key;
  await store.put('HOUSEHOLD#h-lost', `ORDER#${o.id}`, ord);
  const r = await m.closeOrder('h-lost', { order_id: o.id, action: 'refund', amount: 10, confirmation_token: o.close_token });
  const after = r.data.receipt.orders[0];
  assert.deepEqual(after.timeline.map((t) => t.state), ['held', 'captured', 'refunded']);
  assert.equal(pp.calls.filter(([k]) => k === 'capture').length, 1);
  assert.equal(pp.calls.filter(([k]) => k === 'refund').length, 1);
  const [env] = await envelopes(store, 'h-lost');
  const e = env.entries.find((x) => x.id === o.id);
  assert.ok(e && e.restored, 'the entry is back');
  assert.equal(e.state, 'captured');
  assert.equal(e.refunded, 10);
});

test('PayPal refund fails after the capture: the order is recorded as paid (never left "held"), and a retry refunds', async () => {
  const store = createStore('memory');
  const pp = fakePaypal({ failRefundOnce: true });
  const m = make(store, pp);
  const { p1 } = await twoPlans(m, 'h-half');
  const rec = await m.confirmPlan('h-half', { plan_id: p1.plan.id, confirmation_token: p1.confirmation_token, user_confirmation: 'Yes' });
  const o = rec.data.receipt.orders[0];
  await assert.rejects(() => m.closeOrder('h-half', { order_id: o.id, action: 'refund', amount: 10, confirmation_token: o.close_token }), /The order is paid; no refund was made/);
  const stored = await store.get('HOUSEHOLD#h-half', `ORDER#${o.id}`);
  assert.equal(stored.state, 'captured', 'PayPal captured, so the records say captured');
  const [env] = await envelopes(store, 'h-half');
  assert.equal(env.entries.find((x) => x.id === o.id).state, 'captured');
  const again = await m.closeOrder('h-half', { order_id: o.id, action: 'refund', amount: 10, confirmation_token: o.close_token });
  assert.equal(again.data.receipt.orders[0].timeline.at(-1).state, 'refunded');
  assert.equal(pp.calls.filter(([k]) => k === 'capture').length, 1, 'never captured twice');
});

test('a local check that fails stops close_order before any PayPal call', async () => {
  const store = createStore('memory');
  const pp = fakePaypal();
  const m = make(store, pp);
  const { p1 } = await twoPlans(m, 'h-dry');
  const rec = await m.confirmPlan('h-dry', { plan_id: p1.plan.id, confirmation_token: p1.confirmation_token, user_confirmation: 'Yes' });
  const o = rec.data.receipt.orders[0];
  const before = pp.calls.length;
  await assert.rejects(() => m.closeOrder('h-dry', { order_id: o.id, action: 'refund', amount: o.amount + 50, confirmation_token: o.close_token }));
  await assert.rejects(() => m.closeOrder('h-dry', { order_id: o.id, action: 'capture', amount: o.amount + 1, confirmation_token: o.close_token }));
  assert.equal(pp.calls.length, before, 'PayPal was never called');
  assert.equal((await store.get('HOUSEHOLD#h-dry', `ORDER#${o.id}`)).state, 'held');
});

test('emergency stop: an authorization PayPal already captured (422 PREVIOUSLY_CAPTURED) is resynced, the others are voided', async () => {
  const store = createStore('memory');
  const pp = fakePaypal();
  const m = make(store, pp);
  const { p1, p2 } = await twoPlans(m, 'h-stop');
  const r1 = await m.confirmPlan('h-stop', { plan_id: p1.plan.id, confirmation_token: p1.confirmation_token, user_confirmation: 'Yes' });
  const r2 = await m.confirmPlan('h-stop', { plan_id: p2.plan.id, confirmation_token: p2.confirmation_token, user_confirmation: 'Yes' });
  const captured = r1.data.receipt.orders[0], other = r2.data.receipt.orders[0];
  const auth = (await store.get('HOUSEHOLD#h-stop', `ORDER#${captured.id}`)).paypal.authorizationId;
  pp.calls.length = 0;
  const failing = fakePaypal({ failVoid: { [auth]: 'PayPal void -> 422 PREVIOUSLY_CAPTURED' } });
  m.paypal = failing;
  const r = await m.pauseSpending('h-stop');
  assert.match(r.speech, /Mandat is paused\./);
  assert.match(r.speech, /already paid at PayPal/);
  assert.match(r.speech, /I voided 1 payment hold/);
  assert.match(r.speech, /Nothing will be bought until you say “resume Mandat”\.$/);
  assert.equal((await store.get('HOUSEHOLD#h-stop', `ORDER#${captured.id}`)).state, 'captured');
  assert.equal((await store.get('HOUSEHOLD#h-stop', `ORDER#${other.id}`)).state, 'released');
  assert.equal((await store.get('HOUSEHOLD#h-stop', 'SETTINGS')).paused, true);
  const [env] = await envelopes(store, 'h-stop');
  assert.equal(envelope.totals(env).held, 0, 'nothing left on hold');
  assert.equal(envelope.totals(env).spent, captured.amount, 'the paid order counts as spent');
});

test('emergency stop: an unexpected PayPal error on one hold never stops the others, and says so', async () => {
  const store = createStore('memory');
  const pp = fakePaypal();
  const m = make(store, pp);
  const { p1, p2 } = await twoPlans(m, 'h-err');
  const r1 = await m.confirmPlan('h-err', { plan_id: p1.plan.id, confirmation_token: p1.confirmation_token, user_confirmation: 'Yes' });
  await m.confirmPlan('h-err', { plan_id: p2.plan.id, confirmation_token: p2.confirmation_token, user_confirmation: 'Yes' });
  const auth = (await store.get('HOUSEHOLD#h-err', `ORDER#${r1.data.receipt.orders[0].id}`)).paypal.authorizationId;
  m.paypal = fakePaypal({ failVoid: { [auth]: 'PayPal void -> 503 SERVICE_UNAVAILABLE' } });
  const r = await m.pauseSpending('h-err');
  assert.match(r.speech, /I could not void/);
  assert.equal(r.data.stop.not_voided.length, 1);
  assert.equal(r.data.stop.voided.length, 1);
});

test('DynamoDB lease: written only if absent, expired or ours; removed only by its owner; expires through the table TTL', async () => {
  const { commands } = await import('../src/store/dynamodb.mjs');
  const c = commands.lock('HOUSEHOLD#h', 'LOCK', 'me', 60000, 1_000_000);
  assert.equal(c.ConditionExpression, 'attribute_not_exists(PK) OR #u < :now OR lockOwner = :me');
  assert.deepEqual(c.ExpressionAttributeNames, { '#u': 'until' });
  assert.equal(c.Item.until, 1_060_000);
  assert.equal(c.Item.ttl, Math.floor(1_060_000 / 1000) + 3600);
  assert.equal(commands.unlock('HOUSEHOLD#h', 'LOCK', 'me').ConditionExpression, 'lockOwner = :me');
  const store = createStore('memory');
  assert.equal(await store.lock('p', 'LOCK', 'a', 50), true);
  assert.equal(await store.lock('p', 'LOCK', 'b', 50), false, 'held by a');
  await store.unlock('p', 'LOCK', 'b');
  assert.equal(await store.lock('p', 'LOCK', 'b', 50), false, 'b cannot remove a\'s lease');
  await pause(60);
  assert.equal(await store.lock('p', 'LOCK', 'b', 50), true, 'an expired lease is taken over');
});
