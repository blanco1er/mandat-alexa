// PayPal sandbox without a PayPal account for the household (or the judges): the owner links one sandbox demo buyer
// once; every budget then holds, captures, voids and refunds with its saved payment token. A fake PayPal module
// records the calls (no network). Without the demo buyer, everything stays simulated and says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers.mjs';
import { Mandat } from '../src/mandat.mjs';
import { createStore } from '../src/store/index.mjs';
import { createProvider } from '../src/providers/index.mjs';

function fakePaypal() {
  const calls = [];
  let n = 0;
  const id = (p) => `${p}-${++n}`;
  return {
    calls, MODE: 'sandbox',
    async createMandateSetup(a) { calls.push(['setup', a]); return { id: 'SETUP-1', approveUrl: 'https://www.sandbox.paypal.com/agreements/approve?approval_session_id=x', mode: 'sandbox' }; },
    async activateMandate(sid) { calls.push(['activate', sid]); return { paymentTokenId: 'VAULT-REAL-1', payer: 'buyer@personal.example.com', mode: 'sandbox' }; },
    async hold(a) { calls.push(['hold', a]); return a.mode === 'sandbox' ? { orderId: id('O'), authorizationId: id('8AUTH'), status: 'CREATED', mode: 'sandbox' } : { orderId: id('ORDER'), authorizationId: id('AUTH'), mode: 'offline' }; },
    async capture(a) { calls.push(['capture', a]); return { captureId: id('CAP'), status: 'COMPLETED', mode: a.mode }; },
    async release(a) { calls.push(['void', a]); return { status: 'VOIDED', mode: a.mode }; },
    async refund(a) { calls.push(['refund', a]); return { refundId: id('REF'), status: 'COMPLETED', mode: a.mode }; },
  };
}
const svc = (paypal) => new Mandat({ store: createStore('memory'), provider: createProvider('simulated'), paypal, publicUrl: 'https://demo.example' });
async function bookOne(m, hid) {
  await m.setSpendingMandate(hid, { budget: 400, period: 'once', purpose: 'In-laws visit', auto_approve_under: 0 });
  const clean = await m.findHomeServices(hid, { need: 'deep clean', category: 'cleaning', when: 'Friday morning' });
  const food = await m.findHomeServices(hid, { need: 'dinner for six', category: 'catering', when: 'Saturday evening', guests: 6 });
  const plan = await m.proposePlan(hid, { item_ids: [clean.data.offers[0].id, food.data.offers[0].id] });
  return m.confirmPlan(hid, { plan_id: plan.data.plan.id, confirmation_token: plan.data.confirmation_token, user_confirmation: 'Yes, book it' });
}

test('keys but no demo buyer yet: budgets work at once, payments are simulated and labelled so', async () => {
  const pp = fakePaypal();
  const m = svc(pp);
  const r = await m.setSpendingMandate('h1', { budget: 150, period: 'weekly', purpose: 'Household', auto_approve_under: 40 });
  assert.equal(r.data.mandate.status, 'active');
  assert.equal(r.data.approval_url, null, 'no PayPal login asked from anyone');
  assert.equal(r.data.mandate.paypal.mode, 'offline');
  const rec = await bookOne(m, 'h2');
  assert.ok(rec.data.receipt.orders.every((o) => o.paypal_mode === 'offline'));
  assert.ok(pp.calls.filter(([k]) => k === 'hold').every(([, a]) => a.mode === 'offline'));
  assert.deepEqual(await m.demoBuyerStatus(), { paypal: 'sandbox', linked: false, payer: null, linked_at: null });
});

test('owner links the demo buyer once; a forged or stale approval is refused', async () => {
  const pp = fakePaypal();
  const m = svc(pp);
  await assert.rejects(() => m.finishDemoBuyerLink('SETUP-1'), /does not match/);
  const { approveUrl } = await m.startDemoBuyerLink();
  assert.match(approveUrl, /sandbox\.paypal\.com/);
  assert.equal(pp.calls[0][1].returnUrl, 'https://demo.example/paypal/demo-buyer/return');
  await assert.rejects(() => m.finishDemoBuyerLink('SETUP-OTHER'), /does not match/);
  const ok = await m.finishDemoBuyerLink('SETUP-1');
  assert.equal(ok.payer, 'b•••@personal.example.com', 'the buyer email is masked');
  await assert.rejects(() => m.finishDemoBuyerLink('SETUP-1'), /does not match/, 'one use only');
  assert.equal((await m.demoBuyerStatus()).linked, true);
});

test('with the demo buyer: real sandbox hold per item with the vault token, then capture, partial capture, void and refund', async () => {
  const pp = fakePaypal();
  const m = svc(pp);
  await m.startDemoBuyerLink();
  await m.finishDemoBuyerLink('SETUP-1');
  const rec = await bookOne(m, 'h3');
  const holds = pp.calls.filter(([k]) => k === 'hold').map(([, a]) => a);
  assert.equal(holds.length, 2);
  assert.ok(holds.every((a) => a.mode === 'sandbox' && a.paymentTokenId === 'VAULT-REAL-1'), 'merchant-initiated, vaulted token, no buyer present');
  const [clean, food] = rec.data.receipt.orders;
  assert.ok(rec.data.receipt.orders.every((o) => o.paypal_mode === 'sandbox' && /^8AUTH-/.test(o.paypal_authorization)));
  const tok = Object.fromEntries(rec.data.receipt.orders.map((o) => [o.id, o.close_token]));
  // the caterer bills less: partial capture, the rest released by PayPal (final_capture)
  await m.closeOrder('h3', { order_id: food.id, action: 'capture', amount: 180, confirmation_token: tok[food.id] });
  const cap = pp.calls.find(([k]) => k === 'capture')[1];
  assert.equal(cap.mode, 'sandbox'); assert.equal(cap.amount, 180);
  // the cleaner is cancelled before it happens: void
  await m.closeOrder('h3', { order_id: clean.id, action: 'cancel', confirmation_token: tok[clean.id] });
  assert.equal(pp.calls.find(([k]) => k === 'void')[1].mode, 'sandbox');
  // a part of the dinner is refunded
  await m.closeOrder('h3', { order_id: food.id, action: 'refund', amount: 20, confirmation_token: tok[food.id] });
  const ref = pp.calls.find(([k]) => k === 'refund')[1];
  assert.equal(ref.mode, 'sandbox'); assert.equal(ref.amount, 20); assert.match(ref.captureId, /^CAP-/);
});

test('the real PayPal module never labels a simulated hold "sandbox", and never sends a fake id to PayPal', async () => {
  const pp = await import('../src/core/paypal.mjs');
  const h = await pp.hold({ mode: 'offline', paymentTokenId: 'PTOKEN-ABCDEF123456', amount: 85, currency: 'USD', merchant: 'BrightNest', description: 'x', reference: 'r' });
  assert.equal(h.mode, 'offline');
  assert.match(h.authorizationId, /^AUTH-[0-9A-F]{12}$/);
  // even an order wrongly flagged "sandbox" with a fake id stays local
  assert.equal((await pp.release({ mode: 'sandbox', authorizationId: h.authorizationId })).mode, 'offline');
  assert.equal((await pp.capture({ mode: 'sandbox', authorizationId: h.authorizationId, amount: 80, currency: 'USD' })).mode, 'offline');
});
