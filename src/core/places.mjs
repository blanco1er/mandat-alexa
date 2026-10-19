// Real local businesses near the household: who could clean, cater, fix a pipe. Never fictional.
//   live      Google Places (New) Text Search when GOOGLE_PLACES_KEY is set: name, rating, number of reviews, opening
//             hours, one photo with its author. Else OpenStreetMap (Overpass): name, opening hours, website.
//             If both fail, the OpenStreetMap snapshot below.
//   snapshot  OpenStreetMap data saved with the code (src/core/places-snapshot.json, built by
//             scripts/build-places-snapshot.mjs): real businesses, no network. Tests and the local demo use it.
//   off       no real business (demo partners only).
// Rules: OpenStreetMap usage policies (identified User-Agent, low rate, results cached, "© OpenStreetMap contributors"
// shown); Google Maps Platform terms (attribution "Google Maps" and the photo author shown with the data). Every demo
// household lives in the same neighbourhood, so one search per trade serves everyone: results are cached per
// neighbourhood and trade (MANDAT_PLACES_CACHE_HOURS, 0 by default: see below) in memory and in the store (DynamoDB), photos
// too. Google Maps Platform terms only allow storing place ids (and coordinates up to 30 days): the 24-hour cache of
// names, ratings and photos is a cost choice for the public demo, documented in the README; set
// MANDAT_PLACES_CACHE_HOURS=0 for Google data in memory only (1 hour). Hard daily caps per person and in total.
// Mandat never contacts these businesses: their price is an ESTIMATE (src/core/estimate.mjs) and the booking is a
// REQUEST prepared by Mandat, paid as a hold of PayPal sandbox test money.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// The demo household lives in a real neighbourhood, never at a private house address.
export const HOME = Object.freeze({ area: 'Capitol Hill', label: 'Capitol Hill, Seattle, WA', city: 'Seattle', region: 'WA', postal: '98102', lat: 47.6238307, lon: -122.318368 });
export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const UA = 'Mandat-for-Alexa-demo/0.2 (Amazon Alexa+ hackathon demo; https://github.com/blanco1er)';
const RADIUS_M = 9000; // the trade comes to the home: within about 5.5 miles

export function placesMode() {
  const m = String(process.env.MANDAT_PLACES || 'snapshot').toLowerCase();
  return ['live', 'snapshot', 'off'].includes(m) ? m : 'snapshot';
}
const gKey = () => (placesMode() === 'live' ? (process.env.GOOGLE_PLACES_KEY || '').trim() || null : null);
export const googleEnabled = () => !!gKey();

// Injected in tests (fake Google and OSM answers); the real fetch otherwise.
let doFetch = (...a) => globalThis.fetch(...a);
export function _setFetch(f) { doFetch = f || ((...a) => globalThis.fetch(...a)); }

// ---------- caps (per warm process; Google bills per call) ----------
const CAP = {
  // Google's free monthly use per SKU (Places API New, 2026): 1,000 Text Search Enterprise, 1,000 photos. With the
  // shared 24-hour cache the demo needs about 4 searches and 16 photos a day; these caps keep a busy month under
  // 1,000 of each (30 x 30 = 900).
  gSearchDay: () => Number(process.env.MANDAT_GOOGLE_SEARCHES_PER_DAY) || 30,
  gSearchUser: () => Number(process.env.MANDAT_GOOGLE_SEARCHES_PER_USER_DAY) || 6,
  gPhotoDay: () => Number(process.env.MANDAT_GOOGLE_PHOTOS_PER_DAY) || 30,
};
let use = { day: '', search: 0, photo: 0, users: new Map() };
const today = () => new Date().toISOString().slice(0, 10);
function room(kind, user = '') {
  if (use.day !== today()) use = { day: today(), search: 0, photo: 0, users: new Map() };
  if (kind === 'photo') { if (use.photo >= CAP.gPhotoDay()) return false; use.photo++; return true; }
  const mine = use.users.get(user) || 0;
  if (use.search >= CAP.gSearchDay() || mine >= CAP.gSearchUser()) return false;
  use.search++; use.users.set(user, mine + 1);
  return true;
}
export function _resetCaps() { use = { day: '', search: 0, photo: 0, users: new Map() }; memo.clear(); gPausedUntil = 0; }
export const capsView = () => ({ day: use.day, google_searches: use.search, google_photos: use.photo, limits: { searches_per_day: CAP.gSearchDay(), searches_per_user_day: CAP.gSearchUser(), photos_per_day: CAP.gPhotoDay() } });

// Shared cache: memory first, then the store (one row per neighbourhood and trade, one per photo).
const memo = new Map();
let store = null;
export function setPlacesStore(s) { store = s || null; }
const CACHE_PK = 'SYSTEM#places';
// Default 0: Google Maps Platform terms allow keeping place ids only, so Google content stays in memory (1 hour) and is
// never written to the store; OpenStreetMap results (ODbL) may still be stored. Set it above 0 only with Google's agreement.
const cacheHours = () => { const v = process.env.MANDAT_PLACES_CACHE_HOURS; return v === undefined || v === '' ? 0 : Math.max(0, Number(v) || 0); };
async function recall(k) {
  const h = memo.get(k);
  if (h && h.until > Date.now()) return h.data;
  if (!store) return undefined;
  try { const row = await store.get(CACHE_PK, 'CACHE#' + k); if (row && row.until > Date.now()) { memo.set(k, row); return row.data; } } catch {}
  return undefined;
}
async function remember(k, data, ttlMs, { persist = true } = {}) {
  const row = { data, until: Date.now() + ttlMs };
  memo.set(k, row);
  if (memo.size > 300) memo.delete(memo.keys().next().value);
  if (persist && store && ttlMs > 0) { try { await store.put(CACHE_PK, 'CACHE#' + k, row); } catch {} }
  return data;
}

export function distanceM(a, b) {
  const R = 6371000, r = (d) => (d * Math.PI) / 180;
  const x = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(x)));
}

// ---------- opening hours: { mon: [[480, 1020]], ... } in minutes, or null when not published ----------
const OSM_DAY = { Mo: 'mon', Tu: 'tue', We: 'wed', Th: 'thu', Fr: 'fri', Sa: 'sat', Su: 'sun' };
const OSM_ORDER = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
export function parseOsmHours(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  if (/^24\/7$/.test(t)) return Object.fromEntries(DAYS.map((d) => [d, [[0, 1440]]]));
  const out = Object.fromEntries(DAYS.map((d) => [d, []]));
  let understood = false;
  for (const rule of t.split(';').map((x) => x.trim()).filter(Boolean)) {
    const m = /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?,?)+)\s+(off|closed|(?:\d{1,2}:\d{2}-\d{1,2}:\d{2},?\s*)+)$/.exec(rule);
    if (!m) continue;
    understood = true;
    const days = [];
    for (const part of m[1].split(',').filter(Boolean)) {
      const [a, b] = part.split('-');
      const i = OSM_ORDER.indexOf(a), j = b ? OSM_ORDER.indexOf(b) : i;
      for (let k = i; ; k = (k + 1) % 7) { days.push(OSM_DAY[OSM_ORDER[k]]); if (k === j) break; }
    }
    const spans = /off|closed/.test(m[2]) ? [] : m[2].split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.split('-').map((h) => { const [H, M] = h.split(':').map(Number); return H * 60 + M; }));
    for (const d of days) out[d] = spans;
  }
  return understood ? out : null;
}
export function googleHours(regular) {
  const periods = regular?.periods;
  if (!Array.isArray(periods) || !periods.length) return null;
  const out = Object.fromEntries(DAYS.map((d) => [d, []]));
  for (const p of periods) {
    if (!p.open) continue;
    if (!p.close) { for (const d of DAYS) out[d] = [[0, 1440]]; break; } // open 24 hours
    const from = (p.open.hour || 0) * 60 + (p.open.minute || 0);
    let to = (p.close.hour || 0) * 60 + (p.close.minute || 0);
    if (p.close.day !== p.open.day) to = 1440;
    out[DAYS[p.open.day]].push([from, to]);
  }
  return out;
}
// true / false from the published hours, null when unknown
export const openOn = (hours, day) => (!hours || !day ? null : (hours[day] || []).length > 0);

// ---------- what each trade is called, and what is not that trade ----------
const GOOGLE_QUERY = { cleaning: 'house cleaning service', catering: 'catering service', plumbing: 'plumber', handyman: 'handyman service' };
const NOT_IT = {
  cleaning: /dry ?clean|laundr|carpet|rug|upholster|window|pressure|duct|chimney|car ?wash|auto|detail|technolog|janitorial supply|cleanearth|airclean/i,
  catering: /commissary|food hall|\bkitchens\b|\beats\b|coffee|bakery|sushi|truck rental/i,
  plumbing: /supply|ferguson|wholesale|showroom/i,
  handyman: /hardware|supply|rental/i,
};
const OSM_QUERY = {
  cleaning: (r, la, lo) => `nwr["craft"="cleaning"](around:${r},${la},${lo});nwr["shop"="cleaning"](around:${r},${la},${lo});nwr["office"]["name"~"[Cc]lean|[Mm]aid|[Hh]ousekeep"](around:${r},${la},${lo});`,
  catering: (r, la, lo) => `nwr["craft"="caterer"](around:${r},${la},${lo});nwr["shop"="caterer"](around:${r},${la},${lo});`,
  plumbing: (r, la, lo) => `nwr["craft"="plumber"](around:${r},${la},${lo});`,
  handyman: (r, la, lo) => `nwr["craft"="handyman"](around:${r},${la},${lo});`,
};

// ---------- sources ----------
async function google({ category, lang, userId, near }) {
  const key = gKey();
  if (!key || Date.now() < gPausedUntil) return null;
  const k = `g|${category}|${near.lat.toFixed(3)},${near.lon.toFixed(3)}`;
  const hit = await recall(k);
  if (hit) return hit;
  if (!room('search', userId)) return null;
  const fields = ['id', 'displayName', 'formattedAddress', 'shortFormattedAddress', 'location', 'rating', 'userRatingCount', 'regularOpeningHours', 'googleMapsUri', 'websiteUri', 'photos', 'types', 'businessStatus'].map((f) => 'places.' + f).join(',');
  const r = await doFetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fields },
    body: JSON.stringify({ textQuery: GOOGLE_QUERY[category], pageSize: 10, languageCode: 'en', locationBias: { circle: { center: { latitude: near.lat, longitude: near.lon }, radius: 5000 } } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    if ([401, 403, 429].includes(r.status) || r.status >= 500) gPausedUntil = Date.now() + (r.status >= 500 ? 5 : 60) * 60000;
    throw new Error('Google Places HTTP ' + r.status);
  }
  const places = ((await r.json()).places || [])
    .filter((g) => g.businessStatus !== 'CLOSED_PERMANENTLY' && g.businessStatus !== 'CLOSED_TEMPORARILY' && g.location && g.displayName?.text)
    .filter((g) => !NOT_IT[category]?.test(g.displayName.text) && !(category === 'cleaning' && (g.types || []).some((t) => ['laundry', 'dry_cleaner', 'car_wash'].includes(t))))
    .map((g) => {
      const ph = (g.photos || [])[0];
      const by = ph?.authorAttributions?.[0];
      return {
        id: 'g:' + g.id, name: g.displayName.text.slice(0, 80), address: g.formattedAddress || '', area: (g.shortFormattedAddress || '').split(',')[0],
        lat: g.location.latitude, lon: g.location.longitude, rating: g.rating ?? null, ratings: g.userRatingCount ?? null,
        hours: googleHours(g.regularOpeningHours), website: g.websiteUri || null, maps_url: g.googleMapsUri || null,
        photo: ph?.name ? { ref: 'g:' + ph.name, author: by?.displayName ? String(by.displayName).slice(0, 60) : null } : null,
        source: 'google',
      };
    });
  const h = cacheHours();
  return remember(k, places, (h || 1) * 3600e3, { persist: h > 0 });
}
let gPausedUntil = 0;

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
export function osmToPlace(e, category) {
  const t = e.tags || {};
  const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
  if (!t.name || lat == null || NOT_IT[category]?.test(t.name)) return null;
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  return {
    id: `osm:${e.type}/${e.id}`, name: String(t.name).slice(0, 80), address: [street, t['addr:city'] || (street ? 'Seattle' : '')].filter(Boolean).join(', '), area: t['addr:street'] || '',
    lat, lon, rating: null, ratings: null, hours: parseOsmHours(t.opening_hours), hours_raw: t.opening_hours || null,
    website: t.website || t['contact:website'] || null, maps_url: `https://www.openstreetmap.org/${e.type}/${e.id}`, photo: null, source: 'osm',
  };
}
export async function overpassQuery(category, near = HOME, radius = RADIUS_M, rounds = 1) {
  const q = `[out:json][timeout:25];(${OSM_QUERY[category](radius, near.lat, near.lon)});out center tags 80;`;
  let last;
  // public Overpass servers are often busy: each mirror in turn, then one more round after a pause
  for (let round = 0; round < rounds; round++) {
    for (const url of OVERPASS) {
      try {
        const r = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Accept: 'application/json' }, body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error('Overpass HTTP ' + r.status);
        const j = await r.json();
        if (!Array.isArray(j.elements)) throw new Error('Overpass answered without elements');
        return j.elements;
      } catch (e) { last = e; }
    }
    if (round + 1 < rounds) await new Promise((r) => setTimeout(r, 2500));
  }
  throw last;
}
async function osm({ category, near }) {
  const k = `o|${category}|${near.lat.toFixed(3)},${near.lon.toFixed(3)}`;
  const hit = await recall(k);
  if (hit) return hit;
  const els = await overpassQuery(category, near);
  return remember(k, els.map((e) => osmToPlace(e, category)).filter(Boolean), Math.max(24, cacheHours()) * 3600e3);
}

const SNAPSHOT_FILE = fileURLToPath(new URL('./places-snapshot.json', import.meta.url));
let snap;
export function snapshot() {
  if (snap === undefined) { try { snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')); } catch { snap = null; } }
  return snap;
}
function fromSnapshot(category) {
  const s = snapshot();
  return (s?.categories?.[category] || []).map((e) => osmToPlace(e, category)).filter(Boolean);
}

export const ATTRIBUTION = { google: 'Google Maps', osm: '© OpenStreetMap contributors', snapshot: '© OpenStreetMap contributors' };

// The real businesses of one trade near the home, best first: Google's rating weighed by the number of reviews (a 4.9
// from 12 reviews is not a 4.9 from 600), then distance. { source, attribution, places } — places may be empty.
export async function findLocal({ category, userId = '', near = HOME, limit = 4 } = {}) {
  const mode = placesMode();
  if (mode === 'off' || !OSM_QUERY[category]) return { source: null, attribution: '', places: [] };
  let source = 'snapshot', places = null;
  if (mode === 'live') {
    try { places = await google({ category, userId, near }); if (places) source = 'google'; } catch (e) { console.warn('[places]', e.message); places = null; }
    if (!places || !places.length) { try { places = await osm({ category, near }); source = 'osm'; } catch (e) { console.warn('[places] osm:', e.message); places = null; } }
  }
  if (!places || !places.length) { places = fromSnapshot(category); source = 'snapshot'; }
  const trust = (p) => (p.rating ? p.rating - 1.5 / Math.sqrt(p.ratings || 1) : 0);
  const seen = new Set();
  const list = places
    .map((p) => ({ ...p, distance_m: distanceM(near, p) }))
    .filter((p) => p.distance_m <= RADIUS_M && !seen.has(p.name.toLowerCase()) && seen.add(p.name.toLowerCase()))
    .sort((a, b) => trust(b) - trust(a) || a.distance_m - b.distance_m)
    .slice(0, limit);
  return { source, attribution: ATTRIBUTION[source], places: list };
}

// ---------- Google photo bytes, for the image proxy (the key never reaches a browser) ----------
// { type, bytes } or null. One billed media call per photo and per cache period, whoever looks at it.
export async function googlePhoto(ref) {
  const key = gKey();
  const name = String(ref || '').replace(/^g:/, '');
  if (!key || !/^places\/[\w-]+\/photos\/[\w-]+$/.test(name)) return null;
  const k = 'p|' + name;
  const hit = await recall(k);
  if (hit) return { type: hit.type, bytes: Buffer.from(hit.b64, 'base64') };
  if (!room('photo')) return null;
  const r = await doFetch(`https://places.googleapis.com/v1/${name}/media?maxWidthPx=640&skipHttpRedirect=true`, { headers: { 'X-Goog-Api-Key': key }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) return null;
  const uri = (await r.json()).photoUri;
  if (!/^https:\/\/[\w.-]+\.googleusercontent\.com\//.test(uri || '')) return null;
  const img = await doFetch(uri, { signal: AbortSignal.timeout(8000) });
  const type = img.headers.get('content-type') || '';
  if (!img.ok || !/^image\//.test(type)) return null;
  const bytes = Buffer.from(await img.arrayBuffer());
  if (bytes.length > 2.5e6) return null;
  const h = cacheHours();
  // a photo row stays under the store's item limit (DynamoDB 400 KB); bigger ones live in memory only
  await remember(k, { type, b64: bytes.toString('base64') }, (h || 1) * 3600e3, { persist: h > 0 && bytes.length < 280e3 });
  return { type, bytes };
}
