// Real data, without the network: fake Channel3, Google Places and OpenStreetMap answers (test/fixtures) behind the
// real code paths. Real products (kind check, allergens, usual brand, photos, honest wording), real local businesses
// (Google ranking, closed days, estimated prices, booking requests, caps and cache, fallbacks), the image proxy.
// Rule checked everywhere: a real business never "agreed", "accepted", "confirmed" or "lowered" anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, client, sc, text, talker } from './helpers.mjs';
import * as shop from '../src/core/shop.mjs';
import * as places from '../src/core/places.mjs';
import { _setImgFetch, imgUrl } from '../src/core/imgproxy.mjs';
import { estimateFor } from '../src/core/estimate.mjs';
import { hoursText } from '../src/core/i18n.mjs';
import { usualOf } from '../src/mandat.mjs';

const fx = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const C3 = fx('channel3-search.json'), G = fx('google-places.json'), OSM = fx('overpass-catering.json');
const calls = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
let googleDown = false;
async function fake(url, init = {}) {
  const u = String(url);
  calls.push(u.replace(/\?.*$/, ''));
  if (u.startsWith('https://api.trychannel3.com/v1/search')) {
    assert.equal(init.headers['x-api-key'], 'test-channel3-key');
    const q = JSON.parse(init.body).query.toLowerCase();
    assert.deepEqual(JSON.parse(init.body).config, { country: 'US', language: 'en', currency: 'USD' }, 'US market, USD, always');
    return json(/sheet|bedding/.test(q) ? C3.sheets : /dog/.test(q) ? C3.dog : /coffee/.test(q) ? C3.coffee : { products: [] });
  }
  if (u === 'https://places.googleapis.com/v1/places:searchText') {
    if (googleDown) return json({ error: { message: 'quota' } }, 429);
    assert.equal(init.headers['X-Goog-Api-Key'], 'test-google-key');
    return json(/cleaning/.test(JSON.parse(init.body).textQuery) ? G.cleaning : { places: [] });
  }
  if (/^https:\/\/places\.googleapis\.com\/v1\/places\/.+\/media/.test(u)) return json({ photoUri: 'https://lh3.googleusercontent.com/test-photo' });
  if (u.startsWith('https://lh3.googleusercontent.com/')) return new Response(Buffer.from('fake-jpeg'), { headers: { 'content-type': 'image/jpeg' } });
  if (u.startsWith('https://cdn.trychannel3.com/')) return new Response(Buffer.from('fake-webp'), { headers: { 'content-type': 'image/webp' } });
  if (/overpass/.test(u)) return json(/caterer/.test(decodeURIComponent(init.body)) ? OSM : { elements: [] });
  throw new Error('unexpected fetch ' + u);
}

process.env.MANDAT_SHOP = 'live';
process.env.CHANNEL3_API_KEY = 'test-channel3-key';
process.env.MANDAT_PLACES = 'live';
process.env.GOOGLE_PLACES_KEY = 'test-google-key';
shop._setFetch(fake); places._setFetch(fake); _setImgFetch(fake);
const srv = await boot();
test.after(() => { srv.close(); shop._setFetch(); places._setFetch(); _setImgFetch(); });
test.beforeEach(() => { shop._resetShop(); places._resetCaps(); googleDown = false; calls.length = 0; });

const NEVER = /\b(agreed|accepted|confirmed (it|your)|lowered|negotiated with) /i;

test('units: estimate rules, hours, the usual brand, the kind of thing asked for', () => {
  assert.deepEqual(estimateFor('cleaning', { need: 'deep clean of the guest room and bath' }), { total: 100, rate: 50, qty: 2, per: 'hour' });
  assert.equal(estimateFor('cleaning', { need: 'whole home deep clean' }).total, 200);
  assert.equal(estimateFor('catering', { guests: 6 }).total, 270);
  assert.equal(estimateFor('plumbing', {}).total, 150);
  const h = places.parseOsmHours('Mo-Fr 09:00-17:30; Sa-Su off; PH off');
  assert.equal(places.openOn(h, 'fri'), true);
  assert.equal(places.openOn(h, 'sat'), false);
  assert.equal(places.openOn(null, 'sat'), null, 'unknown hours are never a "closed"');
  assert.equal(hoursText(h), 'Mon–Fri 9 AM–5:30 PM · Sat–Sun closed');
  assert.equal(hoursText(h, 'fr-FR'), 'lun.–ven. 9 h–17 h 30 · sam.–dim. fermé');
  assert.equal(places.parseOsmHours('"by appointment"'), null);
  assert.equal(usualOf('We use Seventh Generation detergent'), 'Seventh Generation detergent');
  assert.equal(usualOf('allergic to chicken'), null);
  assert.equal(shop.typeOf('queen sheet set').type, 'sheets');
  assert.equal(shop.typeOf('paper towels').type, 'paper towels');
});

test('Channel3: only the kind asked for comes back (no canister for sheets), US market, cached, capped per person', async () => {
  const r = await shop.searchProducts({ query: 'queen sheet set', userId: 'u1' });
  assert.deepEqual(r.products.map((p) => p.id), ['c3_sheet_a', 'c3_sheet_b']);
  assert.equal(r.products[1].retailer, 'Linenstore', 'cheapest in-stock offer first; the store named, not its domain');
  assert.equal(r.products[1].retailer_domain, 'linenstore.example');
  assert.equal(r.products[0].was, 49.99);
  await shop.searchProducts({ query: 'queen sheet set', userId: 'u1' });
  assert.equal(calls.filter((c) => c.includes('trychannel3')).length, 1, 'the second identical search comes from the cache');
  // coffee beans: the store search only finds a canister -> nothing (never a canister offered as coffee)
  assert.deepEqual((await shop.searchProducts({ query: 'coffee beans', userId: 'u1' })).products, []);
  process.env.MANDAT_SHOP_SEARCHES_PER_USER_DAY = '2';
  await assert.rejects(shop.searchProducts({ query: 'dog food', userId: 'u1' }), /shop_cap/);
  delete process.env.MANDAT_SHOP_SEARCHES_PER_USER_DAY;
});

test('find_products (live): real products, photos through /img, allergen found in the description, honest voice', async () => {
  const c = await client(srv.mcpUrl);
  await c.callTool({ name: 'remember_preference', arguments: { subject: 'Max (dog)', fact: 'allergic to chicken' } });
  const dog = await c.callTool({ name: 'find_products', arguments: { query: 'dry dog food' } });
  assert.ok(!dog.isError, text(dog));
  const d = sc(dog);
  assert.equal(d.source, 'channel3');
  assert.deepEqual(d.offers.map((o) => o.product_id), ['c3_dog_salmon'], 'the chicken in the description is caught');
  assert.equal(d.skipped[0].title, 'Complete Adult Dry Dog Food');
  assert.match(text(dog), /^Best match: Salmon Recipe Dry Dog Food, \$36\.50 at Pets\. I skipped 1 with chicken.*Real product; I pay with simulated payments and place no order with the store\.$/);
  const bed = sc(await c.callTool({ name: 'find_products', arguments: { query: 'queen sheet set', max_price: 80 } }));
  const o = bed.offers[0];
  assert.equal(o.live, true);
  assert.equal(o.slot_label, 'Delivery set by the store');
  assert.equal(o.product_type, 'sheets');
  assert.equal(o.product_category, 'home');
  assert.match(o.image_url, new RegExp(`^${srv.url}/img\\?src=https%3A%2F%2Fcdn\\.trychannel3\\.com%2F`));
  assert.equal(o.gallery.length, 2);
  // the photo is served from our own origin, signed; a forged link is refused
  const img = await fetch(o.image_url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/webp');
  assert.equal((await fetch(o.image_url.replace(/s=[0-9a-f]+/, 's=000000'))).status, 404);
  assert.equal((await fetch(`${srv.url}/img?src=${encodeURIComponent('https://evil.example/x.png')}&s=abc`)).status, 404);
  const det = await c.callTool({ name: 'get_offer_details', arguments: { offer_id: o.id } });
  const dd = sc(det);
  assert.deepEqual(dd.link, { url: 'https://buy.trychannel3.com/test-a', label: 'Examplehome' });
  assert.ok(dd.specs.some((s) => s.k === 'Price' && /\$39\.99 · was \$49\.99 · Examplehome/.test(s.v)));
  assert.ok(dd.specs.some((s) => s.k === 'Delivery' && /no order placed in this demo/.test(s.v)));
  assert.ok(dd.why.some((w) => /^Real product and price at Examplehome\. Paid with simulated payments; no order is placed with the store$/.test(w.text)));
  assert.match(text(det), /A real product; I pay with simulated payments and place no order with the store\./);
  // "can it come tomorrow?" about a real product: the store sets the date, nothing promised
  await c.callTool({ name: 'set_spending_mandate', arguments: { budget: 300, period: 'once', purpose: 'Test' } });
  await c.callTool({ name: 'propose_plan', arguments: { item_ids: [o.id] } });
  assert.match(text(await c.callTool({ name: 'swap_item', arguments: { wanted: 'tomorrow', item: 'sheets' } })), /^Examplehome sets the delivery date .* cannot promise tomorrow\./);
  // coffee: nothing that is really coffee -> said plainly, nothing offered
  const coffee = await c.callTool({ name: 'find_products', arguments: { query: 'coffee beans' } });
  assert.ok(coffee.isError);
  assert.match(text(coffee), /online stores I search have nothing that matches coffee beans/);
  await c.close();
});

test('find_home_services (Google): ranked by rating weighed by reviews, closed day and dry cleaners left out, estimate + request, photo credit', async () => {
  const c = await client(srv.mcpUrl);
  const r = await c.callTool({ name: 'find_home_services', arguments: { need: 'deep clean of the guest room and bath', category: 'cleaning', when: 'Friday morning' } });
  assert.ok(!r.isError, text(r));
  const d = sc(r);
  assert.equal(d.places_source, 'google');
  assert.equal(d.attribution, 'Google Maps');
  assert.deepEqual(d.offers.map((o) => o.merchant), ['Sparkly Test Maids', 'Five Star Few Reviews'], 'a 4.9 from 412 reviews before a 5.0 from 3; no dry cleaner; nothing 40 km away');
  const closed = await c.callTool({ name: 'find_home_services', arguments: { need: 'clean', category: 'cleaning', when: 'Saturday morning' } });
  assert.ok(!sc(closed).offers.some((o) => o.merchant === 'Weekend Off Cleaners'));
  assert.ok(d.declined.some((x) => x.merchant === 'Weekend Off Cleaners' && /published hours say closed on Friday/.test(x.reply)));
  const o = d.offers[0];
  assert.equal(o.source, 'local');
  assert.equal(o.total, 100);
  assert.equal(o.rating, 4.9);
  assert.equal(o.ratings, 412);
  assert.equal(o.gallery[0].credit, 'Test Photographer · Google Maps');
  assert.match(text(r), /^I found 2 cleaners near Capitol Hill\. Best: Sparkly Test Maids, rated 4\.9, about \$100 estimated\. Then: Five Star Few Reviews, rated 5, about \$100 estimated\. Estimated prices are a typical rate; the business sets the real price\.$/);
  // the photo: one billed media call, then cached for everyone
  const p1 = await fetch(o.image_url);
  assert.equal(p1.status, 200);
  assert.equal(p1.headers.get('content-type'), 'image/jpeg');
  await fetch(o.image_url);
  assert.equal(calls.filter((x) => x.endsWith('/media')).length, 1, 'photo cached');
  // same trade, same neighbourhood: the next household gets the cache, Google is not called again
  const c2 = await client(srv.mcpUrl);
  await c2.callTool({ name: 'find_home_services', arguments: { need: 'clean', category: 'cleaning', when: 'Friday morning' } });
  assert.equal(calls.filter((x) => x.includes('searchText')).length, 1);
  // a real business is never negotiated with
  const neg = await c.callTool({ name: 'negotiate_offer', arguments: { offer_id: o.id, ask: '$80?' } });
  assert.ok(neg.isError);
  await c.close(); await c2.close();
});

test('fallbacks: Google refuses -> OpenStreetMap; nothing there -> the saved snapshot; the source is always named', async () => {
  googleDown = true;
  const c = await client(srv.mcpUrl);
  const food = sc(await c.callTool({ name: 'find_home_services', arguments: { need: 'dinner for six', category: 'catering', when: 'Saturday evening', guests: 6 } }));
  assert.equal(food.places_source, 'osm');
  assert.equal(food.attribution, '© OpenStreetMap contributors');
  const locals = food.offers.filter((o) => o.source === 'local').map((o) => o.merchant);
  assert.ok(locals.includes('Test Table Catering') && !locals.includes('Shared Commissary Kitchens'), locals.join());
  assert.equal(food.offers[0].source, 'partner', 'the negotiated demo partner is cheaper than the $270 estimate');
  const plumb = sc(await c.callTool({ name: 'find_home_services', arguments: { need: 'leak', category: 'plumbing', when: 'Monday morning' } }));
  assert.equal(plumb.places_source, 'snapshot', 'Overpass had nothing: the saved OpenStreetMap snapshot');
  assert.ok(plumb.offers.some((o) => o.source === 'local'));
  await c.close();
});

test('a mixed plan, booked, moved and settled: honest from start to end (voice and data)', async () => {
  const say = talker(srv.mcpUrl, 'mixed-' + Math.random().toString(36).slice(2, 7));
  const plan = await say('Alexa, my in-laws land Saturday. Get the guest room ready: a cleaner Friday, fresh bedding, and dinner for six at home Saturday. Keep it under $400.');
  const p = sc(plan.steps.at(-1).result).plan;
  assert.deepEqual(p.lines.map((l) => l.source), ['local', 'channel3', 'partner']);
  assert.equal(p.breakdown.total, 100 + 39.99 + 195);
  assert.match(plan.speech, /Sparkly Test Maids, about \$100 estimated, Brushed Microfiber Queen Sheet Set from Examplehome, \$39\.99 and Hearth Table Catering, a demo partner, \$195\./);
  assert.match(plan.speech, /It is all paid with simulated payments; the real business only gets a booking request at an estimated price; no order is placed with the store; demo partners are simulated\. Should I book it\?$/);
  const yes = await say('Yes, book it.');
  assert.match(yes.speech, /Sparkly Test Maids has a booking request at an estimated price, not confirmed by them\. No order is placed with Examplehome\./);
  const orders = sc(yes.steps[0].result).receipt.orders;
  assert.deepEqual(orders.map((o) => o.source), ['local', 'channel3', 'partner']);
  const moved = await say('Their flight moved to Sunday.');
  assert.match(moved.speech, /I moved the booking request for Sparkly Test Maids to Saturday at 10 AM, same \$100 hold\. Sparkly Test Maids has not confirmed it\./);
  for (const s of [plan, yes, moved]) {
    for (const name of ['Sparkly Test Maids', 'Five Star Few Reviews']) assert.doesNotMatch(s.speech, new RegExp(`${name} (agreed|accepted|confirmed it|can do|lowered)`), s.speech);
    assert.doesNotMatch(s.speech.replace(/Hearth Table Catering[^.]*\./g, ''), NEVER);
  }
});

test('honesty is kept by the host: a model that drops "test money" or "booking request" gets the sentence back', async () => {
  const { ensureHonesty } = await import('../src/brain/honesty.mjs');
  const step = (honesty) => ({ name: 'propose_plan', result: { structuredContent: { honesty } } });
  const plan = [{ text: 'It is all paid with PayPal sandbox test money; the real business only gets a booking request at an estimated price.', must: 'test money|simulated' }, { text: 'It is all paid with PayPal sandbox test money; the real business only gets a booking request at an estimated price.', must: 'request' }];
  const dropped = ensureHonesty({ speech: 'I found a cleaner, bedding and dinner. The total is $357.99. Should I book it?', steps: [step(plan)] });
  assert.equal(dropped.speech, 'I found a cleaner, bedding and dinner. The total is $357.99. It is all paid with PayPal sandbox test money; the real business only gets a booking request at an estimated price. Should I book it?');
  // only the latest result counts: the plan's sentence covers the product search before it
  const two = ensureHonesty({ speech: 'Plan ready. ¿Lo reservo?', steps: [{ name: 'find_products', result: { structuredContent: { honesty: { text: 'No order.', must: 'no order' } } } }, step([{ text: 'Paid with test money.', must: 'test money' }])] });
  assert.equal(two.speech, 'Plan ready. Paid with test money. ¿Lo reservo?');
  assert.equal(ensureHonesty({ speech: 'Total $380. Say yes to confirm the plan.', steps: [step([{ text: 'Paid with test money.', must: 'test money' }])] }).speech, 'Total $380. Paid with test money. Say yes to confirm the plan.');
  assert.equal(dropped.honesty_added, true);
  const kept = ensureHonesty({ speech: 'Total $357.99, paid with test money; Seattle Green Maids only gets a request.', steps: [step(plan)] });
  assert.equal(kept.honesty_added, undefined, 'said in its own words: nothing added');
  const fr = ensureHonesty({ speech: 'Le total est 357,99 $.', steps: [step({ text: 'Tout est payé avec l’argent de test PayPal sandbox.', must: 'test money|argent de test' })] });
  assert.match(fr.speech, /argent de test PayPal sandbox\.$/);
  // the real tool results carry it
  const c = await client(srv.mcpUrl);
  await c.callTool({ name: 'set_spending_mandate', arguments: { budget: 400, period: 'once', purpose: 'Test' } });
  const clean = sc(await c.callTool({ name: 'find_home_services', arguments: { need: 'clean', category: 'cleaning', when: 'Friday morning' } }));
  assert.equal(clean.honesty.must, 'estimat|estim');
  const p = sc(await c.callTool({ name: 'propose_plan', arguments: { item_ids: [clean.offers[0].id] } }));
  assert.ok(p.honesty.some((h) => /^request/.test(h.must)));
  const r = sc(await c.callTool({ name: 'confirm_plan', arguments: { plan_id: p.plan.id, confirmation_token: p.confirmation_token, user_confirmation: 'yes' } }));
  assert.deepEqual(r.honesty.map((h) => h.must), ['test money|simulated|argent de test|simulés|dinero de prueba|simulados', 'request|demande|solicitud']);
  await c.close();
});
