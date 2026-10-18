// End-to-end money check on the public URL, straight over MCP (no model turn, no Bedrock brain spend):
// budget -> 2 services -> plan -> explicit yes -> 2 holds -> cancel one (void) -> capture the other for less
// (partial capture) -> refund part of it. Prints each order's PayPal mode, authorization id and timeline.
// After the owner linked the demo buyer (scripts/link-paypal-demo-buyer.sh) every line must say "sandbox".
// Usage: node scripts/live-paypal-check.mjs [https://…lambda-url…on.aws]
// The public demo requires account linking: the check links a fresh empty household first (OAuth 2.1 + PKCE).
import { connectMcp } from '../src/brain/simulated.mjs';
import { linkHousehold } from './link-demo.mjs';

const base = (process.argv[2] || 'https://fonzkp2f5pszfit6xmqqiw7qdm0dybyu.lambda-url.us-east-1.on.aws').replace(/\/$/, '');
const household = 'paypal-check-' + Date.now().toString(36);
const { access_token } = await linkHousehold(base, { choice: 'new' });
const { client } = await connectMcp(`${base}/mcp`, { household, name: 'live-paypal-check', headers: { Authorization: `Bearer ${access_token}` } });
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return r.structuredContent;
};
const health = await (await fetch(`${base}/healthz`)).json();
console.log(`healthz: paypal=${health.paypal} demo buyer=${health.paypal_buyer ?? 'n/a'}`);
const m = await call('set_spending_mandate', { budget: 400, period: 'once', purpose: 'PayPal check', auto_approve_under: 0 });
console.log(`budget: ${m.mandate.status}, payments ${m.mandate.paypal.mode}${m.mandate.paypal.demo_buyer ? ' (demo buyer)' : ''}`);
const clean = await call('find_home_services', { need: 'deep clean', category: 'cleaning', when: 'Friday morning' });
const food = await call('find_home_services', { need: 'dinner for six', category: 'catering', when: 'Saturday evening', guests: 6 });
const plan = await call('propose_plan', { item_ids: [clean.offers[0].id, food.offers[0].id], mandate_id: m.mandate.id });
const held = await call('confirm_plan', { plan_id: plan.plan.id, confirmation_token: plan.confirmation_token, user_confirmation: 'Yes, book it.' });
const show = (o) => `${o.merchant.padEnd(24)} ${o.paypal_mode.padEnd(8)} ${String(o.paypal_authorization).padEnd(20)} ${o.timeline.map((t) => `${t.state} ${t.amount ?? ''}`.trim()).join(' -> ')}`;
for (const o of held.receipt.orders) console.log('hold    ', show(o));
const [c, f] = held.receipt.orders;
const tok = Object.fromEntries(held.receipt.orders.map((o) => [o.id, o.close_token]));
const voided = await call('close_order', { order_id: c.id, action: 'cancel', confirmation_token: tok[c.id] });
console.log('void    ', show(voided.receipt.orders[0]));
const captured = await call('close_order', { order_id: f.id, action: 'capture', amount: Math.round(f.amount * 0.9), confirmation_token: tok[f.id] });
console.log('capture ', show(captured.receipt.orders[0]));
const refunded = await call('close_order', { order_id: f.id, action: 'refund', amount: 10, confirmation_token: tok[f.id] });
console.log('refund  ', show(refunded.receipt.orders[0]));
console.log(`left in the budget: $${refunded.receipt.envelope.remaining}`);
await client.close();
