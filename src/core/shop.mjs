// Real products with Channel3: one API over millions of products from thousands of US retailers, with photos, brand,
// key features and each retailer's real price, availability and link. Mandat searches, compares and recommends.
// Mandat NEVER orders from the store: the plan is paid with a hold of PayPal sandbox test money, and every card and
// spoken sentence says so. Key from CHANNEL3_API_KEY (environment only, set with scripts/set-channel3.sh).
// Market: United States, prices in USD, whatever language the household speaks.

// Live Channel3 search only when explicitly switched on (MANDAT_SHOP=live) AND a key is in the environment.
// Otherwise Mandat uses its test catalogue (src/core/catalog.mjs), clearly labelled: no external call at all.
export function shopKey() {
  if (process.env.MANDAT_SHOP !== 'live') return null;
  return process.env.CHANNEL3_API_KEY?.trim() || null;
}
export const shopEnabled = () => !!shopKey();

let doFetch = (...a) => globalThis.fetch(...a);
export function _setFetch(f) { doFetch = f || ((...a) => globalThis.fetch(...a)); }
let store = null;
export function setShopStore(s) { store = s || null; }

// Guarded: searches per person and per day, a global daily cap, and a shared cache (memory + store, 12 hours).
const PER_USER = () => Number(process.env.MANDAT_SHOP_SEARCHES_PER_USER_DAY) || 15;
const GLOBAL = () => Number(process.env.MANDAT_SHOP_SEARCHES_PER_DAY) || 200;
const TTL = 12 * 3600e3;
let day = '', used = 0, perUser = new Map();
const cache = new Map();
export function _resetShop() { day = ''; used = 0; perUser = new Map(); cache.clear(); }
export const shopUse = () => ({ day, searches: used, limits: { per_day: GLOBAL(), per_user_day: PER_USER() } });
const MARKET = { country: 'US', language: 'en', currency: 'USD' };

// What kind of thing was asked for: only products of that kind come back (a search for coffee beans that finds only
// canisters and grinders finds nothing, it never offers a canister). The settings category goes with it.
export const TYPES = [
  { type: 'paper towels', words: /\bpaper towels?\b/i, cat: /paper towel/i, settings: 'home' },
  { type: 'sheets', words: /\b(sheets?|bedding|bed linen|linens?|pillowcases?|sateen|percale)\b/i, cat: /bed sheets|sheet sets|bedding sets|pillowcases|bedding/i, settings: 'home' },
  { type: 'duvet', words: /\b(duvet|comforter|quilt)\b/i, cat: /comforter|duvet|quilt/i, settings: 'home' },
  { type: 'towels', words: /\btowels?\b/i, cat: /towel/i, settings: 'home' },
  { type: 'dog food', words: /\b(dog food|kibble|dog)\b/i, cat: /dog food/i, settings: 'pets' },
  { type: 'cat food', words: /\b(cat food|cat)\b/i, cat: /cat food/i, settings: 'pets' },
  { type: 'laundry detergent', words: /\b(laundry|detergent)\b/i, cat: /laundry detergent/i, settings: 'home' },
  { type: 'coffee', words: /\b(coffee|espresso|beans)\b/i, cat: /^(coffee|ground coffee|whole bean coffee|coffee beans)$/i, settings: 'pantry' },
];
export const typeOf = (query = '') => TYPES.find((t) => t.words.test(String(query))) || null;

// The shape Mandat works with: one product, its best offer, a few facts. Cheapest in-stock offer first.
export function shape(p) {
  const offers = (p.offers || []).filter((o) => o?.url && o.price?.price > 0).sort((a, b) => (a.availability === 'InStock' ? 0 : 1) - (b.availability === 'InStock' ? 0 : 1) || a.price.price - b.price.price);
  const best = offers[0];
  if (!best) return null;
  const img = (p.images || []).find((i) => i.is_main_image) || p.images?.[0];
  const imgs = [img, ...(p.images || []).filter((i) => i !== img)].filter((i) => i?.url).filter((i, k, all) => all.findIndex((x) => x.url === i.url) === k).slice(0, 6);
  const attrs = p.structured_attributes || {};
  const size = (attrs['bedding-size'] || attrs.size || [])[0];
  return {
    id: p.id,
    title: String(p.title || '').slice(0, 140),
    brand: p.brands?.[0]?.name || '',
    images: imgs.map((i) => ({ url: i.url, alt: String(i.alt_text || p.title || '').slice(0, 140) })),
    price: best.price.price,
    was: best.price.compare_at_price && best.price.compare_at_price > best.price.price ? best.price.compare_at_price : null,
    currency: best.price.currency || 'USD',
    retailer: best.domain,
    url: best.url,
    inStock: best.availability === 'InStock',
    offers: offers.slice(0, 3).map((o) => ({ retailer: o.domain, price: o.price.price, currency: o.price.currency, inStock: o.availability === 'InStock', url: o.url })),
    features: (p.key_features || []).slice(0, 4).map((x) => String(x).slice(0, 90)),
    materials: (p.materials || []).slice(0, 3).map(String),
    size: size ? String(size).slice(0, 30) : '',
    category: p.category?.title || '',
    category_path: [...(p.category?.path || []).map((x) => x.title), p.category?.title].filter(Boolean).join(' > '),
    description: String(p.description || '').slice(0, 600),
  };
}

const cacheGet = async (k) => {
  const h = cache.get(k);
  if (h && Date.now() - h.at < TTL) return h.data;
  if (!store) return null;
  try { const row = await store.get('SYSTEM#shop', 'CACHE#' + k); if (row && Date.now() - row.at < TTL) { cache.set(k, row); return row.data; } } catch {}
  return null;
};
const cachePut = async (k, data) => {
  const row = { at: Date.now(), data };
  cache.set(k, row);
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  if (store) { try { await store.put('SYSTEM#shop', 'CACHE#' + k, row); } catch {} }
};

// -> { products, type } ; products already limited to the kind asked for.
export async function searchProducts({ query, maxPrice, limit = 8, userId = '' }) {
  const k = shopKey();
  if (!k) throw Object.assign(new Error('shop_off'), { status: 503 });
  const q = String(query || '').trim().slice(0, 200);
  if (!q) throw new Error('Say what to look for.');
  const kind = typeOf(q);
  const ck = JSON.stringify([q.toLowerCase(), maxPrice || 0, limit]);
  const hit = await cacheGet(ck);
  if (hit) return { products: hit, type: kind };
  const today = new Date().toISOString().slice(0, 10);
  if (day !== today) { day = today; used = 0; perUser = new Map(); }
  const mine = perUser.get(userId) || 0;
  if (used >= GLOBAL() || mine >= PER_USER()) throw Object.assign(new Error('shop_cap'), { status: 429 });
  const body = { query: q, limit: Math.min(12, Math.max(3, limit)), filters: { availability: ['InStock'], ...(maxPrice > 0 ? { price: { max_price: maxPrice } } : {}) }, config: MARKET };
  used++;
  perUser.set(userId, mine + 1);
  const r = await doFetch('https://api.trychannel3.com/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': k, ...(userId ? { 'x-user-id': userId } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Object.assign(new Error('Channel3 HTTP ' + r.status), { status: r.status });
  const all = ((await r.json()).products || []).map(shape).filter(Boolean).filter((p) => !(maxPrice > 0) || p.price <= maxPrice);
  const data = kind ? all.filter((p) => kind.cat.test(p.category_path) || kind.cat.test(p.category)) : all;
  await cachePut(ck, data);
  return { products: data, type: kind };
}
