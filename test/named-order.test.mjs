// Seen live on 20 Oct 2026: "Everything went well. Settle up: Olive billed $180, and refund $10 on the sheets." and
// Amazon Nova sent the refund to the dog food order. close_order now receives the user's words (user_request, set by
// the host) and refuses a refund or a cancel aimed at an order the sentence does not name, giving the right one.
import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers.mjs';
import { Mandat, clauseFor, orderNamedIn } from '../src/mandat.mjs';
import { createStore } from '../src/store/index.mjs';
import { createProvider } from '../src/providers/index.mjs';

function fakePaypal() {
  const calls = [];
  let n = 0;
  return {
    calls, MODE: 'offline',
    async hold(a) { calls.push(['hold', a]); n++; return { orderId: `O-${n}`, authorizationId: `AUTH-${n}`, mode: 'offline' }; },
    async capture(a) { calls.push(['capture', a]); return { captureId: `CAP-${++n}`, status: 'COMPLETED', mode: a.mode }; },
    async release(a) { calls.push(['void', a]); return { status: 'VOIDED', mode: a.mode }; },
    async refund(a) { calls.push(['refund', a]); return { refundId: `REF-${++n}`, status: 'COMPLETED', mode: a.mode }; },
  };
}
const SETTLE = 'Everything went well. Settle up: Olive billed $180, and refund $10 on the sheets.';

async function household() {
  const pp = fakePaypal();
  const m = new Mandat({ store: createStore('memory'), provider: createProvider('simulated'), paypal: pp, publicUrl: 'https://demo.example' });
  const hid = 'h-named';
  // the in-laws visit: a cleaner, sheets, a caterer
  const visit = await m.setSpendingMandate(hid, { budget: 400, period: 'once', purpose: 'In-laws visit', auto_approve_under: 0 });
  const clean = await m.findHomeServices(hid, { need: 'deep clean', category: 'cleaning', when: 'Friday morning' });
  const bed = await m.findProducts(hid, { query: 'queen bedding sheets for the guest room' });
  const food = await m.findHomeServices(hid, { need: 'dinner for six', category: 'catering', when: 'Saturday evening', guests: 6 });
  const p = await m.proposePlan(hid, { item_ids: [clean.data.offers[0].id, bed.data.offers[0].id, food.data.offers[0].id], mandate_id: visit.data.mandate.id });
  const r = await m.confirmPlan(hid, { plan_id: p.data.plan.id, confirmation_token: p.data.confirmation_token, user_confirmation: 'Yes, book it' });
  // four days later: dog food on the weekly budget
  const week = await m.setSpendingMandate(hid, { budget: 150, period: 'weekly', purpose: 'Household', auto_approve_under: 0 });
  const dog = await m.findProducts(hid, { query: 'dog food' });
  const p2 = await m.proposePlan(hid, { item_ids: [dog.data.offers[0].id], mandate_id: week.data.mandate.id });
  const r2 = await m.confirmPlan(hid, { plan_id: p2.data.plan.id, confirmation_token: p2.data.confirmation_token, user_confirmation: 'Yes' });
  const orders = [...r.data.receipt.orders, ...r2.data.receipt.orders];
  const by = (re) => orders.find((o) => re.test(`${o.label} ${o.merchant}`));
  return { m, pp, hid, orders, sheets: by(/sheet|bed|linen|percale/i), dog: by(/dog|kibble/i), cleaner: orders.find((o) => o.category === 'cleaning'), caterer: orders.find((o) => o.category === 'catering') };
}

test('the clause that carries the action, and which orders it names', () => {
  assert.equal(clauseFor(SETTLE, 'refund').trim(), 'refund $10 on the sheets');
  assert.equal(clauseFor(SETTLE, 'cancel'), '');
  assert.ok(orderNamedIn({ label: 'Signature 3-Piece Sheet Set', merchant: 'Ashley' }, 'refund $10 on the sheets'));
  assert.ok(!orderNamedIn({ label: 'Horizon Legacy Northern Water Fish Recipe Dry Dog Food', merchant: 'Chewy' }, 'refund $10 on the sheets'));
  assert.ok(orderNamedIn({ merchant: 'Olive & Thyme Kitchen', category: 'catering' }, 'olive billed $180'));
  assert.ok(orderNamedIn({ label: 'Croquettes', merchant: 'Chewy' }, 'rembourse les croquettes de chewy'));
});

test('"refund $10 on the sheets" aimed at the dog food is refused, with the sheets order to use instead; nothing moves', async () => {
  const { m, pp, hid, sheets, dog } = await household();
  assert.ok(sheets && dog, 'test data: a sheets order and a dog food order');
  const before = pp.calls.length;
  await assert.rejects(
    () => m.closeOrder(hid, { order_id: dog.id, action: 'refund', amount: 10, confirmation_token: dog.close_token, user_request: SETTLE }),
    (e) => /did not name\. Nothing moved/.test(e.message) && e.next.includes(sheets.id) && /Call close_order again/.test(e.next),
  );
  assert.equal(pp.calls.length, before, 'no PayPal call');
  // the model retries with the order the server gave: it works
  const ok = await m.closeOrder(hid, { order_id: sheets.id, action: 'refund', amount: 10, confirmation_token: sheets.close_token, user_request: SETTLE });
  assert.deepEqual(ok.data.receipt.orders[0].timeline.map((t) => t.state), ['held', 'captured', 'refunded']);
});

test('settling up may pay every held order of the event, named or not (capture is not checked)', async () => {
  const { m, hid, cleaner, caterer } = await household();
  const a = await m.closeOrder(hid, { order_id: caterer.id, action: 'capture', amount: 180, confirmation_token: caterer.close_token, user_request: SETTLE });
  const b = await m.closeOrder(hid, { order_id: cleaner.id, action: 'capture', confirmation_token: cleaner.close_token, user_request: SETTLE });
  assert.equal(a.data.receipt.orders[0].state, 'captured');
  assert.equal(b.data.receipt.orders[0].state, 'captured');
});

test('a refund that names nothing is not blocked; two items named and a third targeted: ask which', async () => {
  const { m, hid, dog, sheets, cleaner } = await household();
  await assert.rejects(
    () => m.closeOrder(hid, { order_id: cleaner.id, action: 'refund', amount: 10, confirmation_token: cleaner.close_token, user_request: 'Refund $10 on the sheets and the dog food.' }),
    (e) => /Ask the user which one/.test(e.next) && e.next.includes(sheets.id) && e.next.includes(dog.id),
  );
  const r = await m.closeOrder(hid, { order_id: dog.id, action: 'refund', amount: 5, confirmation_token: dog.close_token, user_request: 'Refund $5 please.' });
  assert.equal(r.data.receipt.orders[0].refunded, 5);
});

test('French and Spanish: "rembourse les 10 $ des draps", "devuelve 10 dólares de las sábanas"', async () => {
  const { m, hid, dog, sheets } = await household();
  for (const u of ['Tout s’est bien passé. On solde : Olive a facturé 180 $, et rembourse les 10 $ des draps.', 'Todo salió bien. Liquida: Olive cobró 180 dólares, y reembolsa los 10 dólares de las sábanas.']) {
    await assert.rejects(() => m.closeOrder(hid, { order_id: dog.id, action: 'refund', amount: 10, confirmation_token: dog.close_token, user_request: u }), (e) => e.next.includes(sheets.id), u);
  }
});

test('a cancel aimed at another order than the one named is refused too', async () => {
  const { m, hid, cleaner, caterer } = await household();
  await assert.rejects(
    () => m.closeOrder(hid, { order_id: caterer.id, action: 'cancel', confirmation_token: caterer.close_token, user_request: 'Cancel the cleaner, we will do it ourselves.' }),
    (e) => e.next.includes(cleaner.id),
  );
  const ok = await m.closeOrder(hid, { order_id: cleaner.id, action: 'cancel', confirmation_token: cleaner.close_token, user_request: 'Cancel the cleaner, we will do it ourselves.' });
  assert.equal(ok.data.receipt.orders[0].state, 'released');
});
