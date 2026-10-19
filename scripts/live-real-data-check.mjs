// Real data on the public URL, straight over MCP (no model turn, no Nova spend): real products (Channel3), real local
// businesses (Google Places / OpenStreetMap) with estimated prices, demo partners, photos through /img, a mixed plan
// paid with PayPal sandbox test money, then every hold released. Checks the honesty rules on every sentence.
// Costs: about 3 Channel3 searches, 2 Google Text Searches and up to 6 photos (or none: shared 24-hour cache).
// Usage: node scripts/live-real-data-check.mjs [https://…lambda-url…on.aws]
import { connectMcp } from '../src/brain/simulated.mjs';
import { linkHousehold } from './link-demo.mjs';

const base = (process.argv[2] || 'https://fonzkp2f5pszfit6xmqqiw7qdm0dybyu.lambda-url.us-east-1.on.aws').replace(/\/$/, '');
const INTERNAL = { 'X-Mandat-Visit': 'internal' }; // our own checks never count as visits
const { access_token } = await linkHousehold(base, { choice: 'new' });
const { client } = await connectMcp(`${base}/mcp`, { household: 'real-check', name: 'live-real-data-check', headers: { Authorization: `Bearer ${access_token}`, ...INTERNAL } });
let failures = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failures++; };
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return { d: r.structuredContent, say: r.content?.[0]?.text || '' };
};
const photo = async (u) => { if (!u) return 'none'; const r = await fetch(u, { headers: INTERNAL }); return `${r.status} ${r.headers.get('content-type') || ''}`; };
const NEVER = (name) => new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (agreed|accepted|confirmed it|can do|lowered|negotiated)`, 'i');

const health = await (await fetch(`${base}/healthz`, { headers: INTERNAL })).json();
console.log(`healthz: products=${health.products} places=${health.places} paypal=${health.paypal} buyer=${health.paypal_buyer ?? 'n/a'} brain=${health.brain}`);

// 1. real products
await call('remember_preference', { subject: 'Max (dog)', fact: 'allergic to chicken' });
const bed = await call('find_products', { query: 'queen sheet set', max_price: 80 });
console.log(`\nproducts (${bed.d.source}): ${bed.say}`);
for (const o of bed.d.offers) console.log(`  - ${o.title.slice(0, 60)} | ${o.retailer || o.merchant} | $${o.total} | photo ${await photo(o.image_url)}`);
ok(bed.d.source === 'channel3', 'real products come from Channel3');
ok(/no order with the store/.test(bed.say), 'the voice says no order is placed with the store');
ok(bed.d.offers.every((o) => o.product_type === 'sheets'), 'only sheet sets (kind check)');
const det = await call('get_offer_details', { offer_id: bed.d.offers[0].id });
console.log(`  details: ${det.say}\n  specs: ${det.d.specs.map((s) => `${s.k}: ${s.v}`).join(' | ')}\n  link: ${det.d.link?.url?.slice(0, 50)}`);
ok(!!det.d.link?.url, 'the product sheet links to the store');
const dog = await call('find_products', { query: 'dry dog food' });
console.log(`  dog food: ${dog.say}`);
ok(dog.d.offers.every((o) => !/chicken/i.test(o.title)), 'no chicken for Max');

// 2. real local businesses + demo partners
const clean = await call('find_home_services', { need: 'deep clean of the guest room and bath', category: 'cleaning', when: 'Friday morning' });
console.log(`\ncleaners (${clean.d.places_source}, ${clean.d.attribution}): ${clean.say}`);
for (const o of clean.d.offers) console.log(`  - ${o.merchant} | ${o.source} | about $${o.total} | ★${o.rating ?? '-'} (${o.ratings ?? 0}) | ${Math.round(o.place?.distance_m || 0)} m | photo ${await photo(o.image_url)}${o.gallery?.[0]?.credit ? ' · ' + o.gallery[0].credit : ''}`);
ok(clean.d.offers.length > 0 && clean.d.offers.every((o) => o.source === 'local' && o.estimated), 'cleaners are real businesses with estimated prices');
ok(/Estimated prices are a typical rate/.test(clean.say), 'the voice says the price is an estimate');
const food = await call('find_home_services', { need: 'dinner for six at home', category: 'catering', when: 'Saturday evening', guests: 6 });
console.log(`\ncaterers: ${food.say}`);
for (const o of food.d.offers) console.log(`  - ${o.merchant} | ${o.source} | $${o.total}`);
ok(food.d.offers.some((o) => o.source === 'partner') && food.d.offers.some((o) => o.source === 'local'), 'demo partners and real caterers side by side');

// 3. a mixed plan, paid with test money, then released
const m = await call('set_spending_mandate', { budget: 400, period: 'once', purpose: 'Real data check', auto_approve_under: 0 });
const plan = await call('propose_plan', { item_ids: [clean.d.offers[0].id, bed.d.offers[0].id, food.d.offers[0].id], mandate_id: m.d.mandate.id });
console.log(`\nplan: ${plan.say}`);
ok(/booking request at an estimated price/.test(plan.say) && /test money|simulated payments/.test(plan.say), 'the plan says estimate, request and test money');
const held = await call('confirm_plan', { plan_id: plan.d.plan.id, confirmation_token: plan.d.confirmation_token, user_confirmation: 'Yes, book it.' });
console.log(`booked: ${held.say}`);
for (const o of held.d.receipt.orders) console.log(`  - ${o.merchant} | ${o.source} | ${o.paypal_mode} ${o.paypal_authorization} | $${o.amount}`);
for (const o of held.d.receipt.orders) await call('close_order', { order_id: o.id, action: 'cancel', confirmation_token: o.close_token });
console.log('  every hold released (cleanup)');
for (const name of clean.d.offers.map((o) => o.merchant)) ok(![plan.say, held.say, clean.say].some((t) => NEVER(name).test(t)), `nothing says ${name} agreed or confirmed`);
await client.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall real-data checks passed');
process.exit(failures ? 1 : 0);
