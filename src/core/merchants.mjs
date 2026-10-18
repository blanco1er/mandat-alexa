// Household merchant network (sandbox): fictional local businesses, each with its own AI sales agent that quotes
// and negotiates within the merchant's private terms. Every merchant agent carries an identity card signed by the
// network; Mandat verifies it before showing a quote ("Know Your Agent").
// The agent's brain is a provider (src/providers): "simulated" applies the terms deterministically, "bedrock" asks
// a Bedrock model with the same terms in its system prompt. Either way, the server re-checks the quote against the
// merchant's floor price: a model can never sell below the floor nor invent a cheaper price.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Network signing key (demo certificate authority). Env first (Lambda), then a local git-ignored file, else ephemeral.
const NETWORK_SECRET = process.env.MANDAT_NETWORK_SECRET || (() => {
  if (process.env.MANDAT_STORE === 'memory') return crypto.randomBytes(32).toString('hex');
  const f = path.resolve(process.env.MANDAT_DATA || 'data', '.network-secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s, { mode: 0o600 }); } catch {}
  return s;
})();

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ALL = DAYS;
const WEEKDAYS_SAT = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// price: per job (unit "job") or per guest (unit "guest"). deals: the merchant's private negotiation room.
// maxOff: the floor, as the largest total discount the merchant ever gives on one booking.
export const MERCHANTS = [
  // ----- cleaning -----
  {
    id: 'm_brightnest', name: 'BrightNest Cleaning', category: 'cleaning', area: 'Maple Heights', rating: 4.8,
    pitch: 'Two-person team, eco products, guest-room deep cleans.', label: 'Guest room + bath deep clean', unit: 'job', price: 95,
    open: WEEKDAYS_SAT, slots: { morning: '10:00', afternoon: '14:00', evening: '17:00' },
    deals: [{ days: ['fri'], before: 12, off: 10, why: 'a Friday slot before noon' }], maxOff: 10, moves: 'accepts',
    terms: 'Deep clean of a guest room and bathroom, 2.5 hours. $95. Floor: $10 off only for a Friday slot before noon. Open Monday to Saturday. Free rescheduling to any open day.',
  },
  {
    id: 'm_tidyhive', name: 'TidyHive', category: 'cleaning', area: 'Riverside', rating: 4.6,
    pitch: 'Same-week cleans, background-checked cleaners.', label: 'Guest room refresh', unit: 'job', price: 110,
    open: ALL, slots: { morning: '09:00', afternoon: '13:00', evening: '18:00' },
    deals: [{ any: true, off: 5, why: 'booking through an agent' }], maxOff: 5, moves: 'accepts',
    terms: 'Guest room refresh, 2 hours. $110. Floor: $5 off for agent bookings. Open every day.',
  },
  {
    id: 'm_sparkle', name: 'Sparkle & Sage', category: 'cleaning', area: 'Old Town', rating: 4.9,
    pitch: 'Premium hotel-style turn-down of guest rooms.', label: 'Hotel-style guest room prep', unit: 'job', price: 140,
    open: ['thu', 'fri', 'sat'], slots: { morning: '11:00', afternoon: '15:00' },
    deals: [], maxOff: 0, moves: 'declines',
    terms: 'Hotel-style guest room preparation. $140, no discounts. Thursday to Saturday only. No rescheduling within 48 hours.',
  },
  // ----- catering -----
  {
    id: 'm_hearth', name: 'Hearth Table Catering', category: 'catering', area: 'Maple Heights', rating: 4.7,
    pitch: 'Family-style dinners cooked and served at home.', label: 'Family-style dinner at home', unit: 'guest', price: 35,
    open: ['tue', 'wed', 'thu', 'fri', 'sat'], slots: { evening: '19:00', afternoon: '13:00' },
    deals: [{ minGuests: 6, off: 15, why: 'a table of six or more' }], maxOff: 15, moves: 'declines',
    terms: 'Family-style dinner at home, $35 per guest, chef and server included. Floor: $15 off for 6 guests or more. Closed Sunday and Monday. Date changes are not possible inside 72 hours.',
  },
  {
    id: 'm_olive', name: 'Olive & Thyme Kitchen', category: 'catering', area: 'Riverside', rating: 4.8,
    pitch: 'Mediterranean dinners, delivered hot and plated at home.', label: 'Mediterranean dinner at home', unit: 'guest', price: 38,
    open: ALL, slots: { evening: '19:30', afternoon: '12:30' },
    deals: [{ minGuests: 6, off: 12, why: 'a table of six or more' }, { days: ['sun'], off: 6, why: 'a Sunday booking' }], maxOff: 18, moves: 'accepts',
    terms: 'Mediterranean dinner, $38 per guest, delivered and plated. Floor: $12 off for 6+ guests and $6 off on Sundays (max $18). Bills only the guests actually served. Open every day.',
  },
  {
    id: 'm_basil', name: 'Basil Street Caterers', category: 'catering', area: 'Old Town', rating: 4.5,
    pitch: 'Classic American comfort food, buffet style.', label: 'Comfort-food buffet at home', unit: 'guest', price: 44,
    open: ALL, slots: { evening: '18:30' },
    deals: [], maxOff: 0, moves: 'accepts',
    terms: 'Comfort-food buffet, $44 per guest. No discounts. Open every day.',
  },
  // ----- plumbing / handyman (the add-on covers the whole home, not only the demo story) -----
  {
    id: 'm_flowfix', name: 'FlowFix Plumbing', category: 'plumbing', area: 'Maple Heights', rating: 4.7,
    pitch: 'Licensed plumbers, two-hour arrival window.', label: 'Plumber visit (first hour)', unit: 'job', price: 129,
    open: ALL, slots: { morning: '08:00', afternoon: '13:00', evening: '17:00' },
    deals: [{ days: ['mon', 'tue', 'wed'], off: 20, why: 'an early-week visit' }], maxOff: 20, moves: 'accepts',
    terms: 'Plumber visit, first hour $129. Floor: $20 off Monday to Wednesday.',
  },
  {
    id: 'm_handyhank', name: 'Handy Hank', category: 'handyman', area: 'Riverside', rating: 4.6,
    pitch: 'Small home fixes, furniture assembly, TV mounting.', label: 'Handyman, 2 hours', unit: 'job', price: 90,
    open: WEEKDAYS_SAT, slots: { morning: '09:00', afternoon: '14:00' },
    deals: [{ before: 12, off: 10, why: 'a morning slot' }], maxOff: 10, moves: 'accepts',
    terms: 'Handyman, 2 hours, $90. Floor: $10 off for morning slots.',
  },
];
export const CATEGORIES = [...new Set(MERCHANTS.map((m) => m.category))];

export function merchant(id) {
  const m = MERCHANTS.find((x) => x.id === id);
  if (!m) throw new Error('Unknown merchant ' + id);
  return m;
}

// Public identity card, signed by the network. Mandat recomputes the signature before trusting a quote.
export function identityCard(m) {
  const card = { agent: `${m.id}.agent`, merchant: m.name, category: m.category, area: m.area, issuedBy: 'Mandat Merchant Network (sandbox)', issued: '2026-10-01' };
  const signature = crypto.createHmac('sha256', NETWORK_SECRET).update(JSON.stringify(card)).digest('hex');
  return { ...card, signature };
}
export function verifyCard(card) {
  try {
    const { signature, ...rest } = card || {};
    const expected = crypto.createHmac('sha256', NETWORK_SECRET).update(JSON.stringify(rest)).digest('hex');
    return typeof signature === 'string' && signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

// Category words people say -> network categories.
const SYNONYMS = { cleaner: 'cleaning', cleaners: 'cleaning', clean: 'cleaning', maid: 'cleaning', housekeeping: 'cleaning', caterer: 'catering', caterers: 'catering', dinner: 'catering', chef: 'catering', food: 'catering', plumber: 'plumbing', leak: 'plumbing', handyman: 'handyman', repair: 'handyman', fix: 'handyman' };
export function normalizeCategory(c = '') {
  const k = String(c).toLowerCase().trim();
  if (CATEGORIES.includes(k)) return k;
  for (const w of k.split(/\W+/)) if (SYNONYMS[w]) return SYNONYMS[w];
  return null;
}

// Every merchant of the sandbox serves the whole demo town; `area` only orders results (closest first).
export function search({ category, area } = {}) {
  const cat = normalizeCategory(category);
  const near = (m) => (area && m.area.toLowerCase().includes(String(area).toLowerCase()) ? 0 : 1);
  return MERCHANTS.filter((m) => !cat || m.category === cat)
    .sort((a, b) => near(a) - near(b))
    .map(({ deals, maxOff, terms, ...pub }) => pub);
}

// ---- when / guests parsing (shared by the simulated agent and the server-side guard) ----
const DAY_WORDS = { sunday: 'sun', sun: 'sun', monday: 'mon', mon: 'mon', tuesday: 'tue', tue: 'tue', tues: 'tue', wednesday: 'wed', wed: 'wed', thursday: 'thu', thu: 'thu', thurs: 'thu', friday: 'fri', fri: 'fri', saturday: 'sat', sat: 'sat',
  dimanche: 'sun', lundi: 'mon', mardi: 'tue', mercredi: 'wed', jeudi: 'thu', vendredi: 'fri', samedi: 'sat',
  domingo: 'sun', lunes: 'mon', martes: 'tue', miercoles: 'wed', jueves: 'thu', viernes: 'fri', sabado: 'sat' };
// French and Spanish words for the parts of the day -> English ones (an assistant may pass "samedi soir").
const PART_WORDS = [[/\b(matin|manana|mañana)\b/g, 'morning'], [/\b(apres-midi|après-midi|tarde)\b/g, 'afternoon'], [/\b(soir|soiree|soirée|noche)\b/g, 'evening'], [/\b(\d{1,2})\s?h\s?(\d{2})?\b/g, (_, h, m) => `${h}:${m || '00'}`]];
export function parseWhen(text = '') {
  let t = String(text).toLowerCase();
  for (const [re, to] of PART_WORDS) t = t.replace(re, to);
  t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  let day = null;
  for (const w of t.split(/[^a-z]+/)) if (DAY_WORDS[w]) { day = DAY_WORDS[w]; break; }
  let hour = null;
  const hm = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b/.exec(t);
  if (hm) hour = hm[3] ? (Number(hm[1]) % 12) + (hm[3] === 'pm' ? 12 : 0) : Number(hm[4]);
  let part = /morning|before noon|\bam\b/.test(t) ? 'morning' : /afternoon|lunch/.test(t) ? 'afternoon' : /evening|night|dinner|\bpm\b/.test(t) ? 'evening' : null;
  if (hour !== null) part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  return { day, part, hour };
}
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
  deux: 2, trois: 3, quatre: 4, cinq: 5, huit: 8, neuf: 9, dix: 10, douze: 12, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, doce: 12 };
export function parseGuests(text = '') {
  const t = String(text).toLowerCase().replace(/\bsix\b/g, 'six').replace(/\bsept\b/g, 'seven');
  const W = 'one|two|three|four|five|six|seven|eight|nine|ten|twelve|deux|trois|quatre|cinq|huit|neuf|dix|douze|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce';
  const m = new RegExp(`(?:for|of|party of|table of|pour|para)\\s+(\\d{1,2}|${W})\\b`).exec(t) || new RegExp(`\\b(\\d{1,2}|${W})\\s+(?:people|guests|persons|adults|personnes|invités|convives|personas|invitados|comensales)\\b`).exec(t);
  if (!m) return null;
  return NUMBER_WORDS[m[1]] || Number(m[1]);
}
// "19:30" -> "7:30 PM", "10:00" -> "10 AM", inside any text (en-US speech and cards).
export function usTime(text = '') {
  return String(text).replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*[ap]\.?m)/gi, (_, h, m) => {
    const H = Number(h);
    const h12 = H % 12 || 12;
    return `${h12}${m === '00' ? '' : ':' + m} ${H < 12 ? 'AM' : 'PM'}`;
  });
}
export const DAY_NAMES = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };

// The list price of a booking before any discount.
export function listPrice(m, guests) { return m.unit === 'guest' ? m.price * (guests || 1) : m.price; }
// The lowest total the merchant ever accepts for that booking.
export function floorPrice(m, guests) { return Math.max(0, listPrice(m, guests) - (m.maxOff || 0)); }

// Server-side guard on any quote coming back from a merchant agent (simulated or Bedrock).
export function guardQuote(m, quote, guests) {
  if (!quote) return null;
  // a model can agree to a day the merchant is closed: the merchant's opening days are the truth
  if (quote.day && m.open && !m.open.includes(String(quote.day).toLowerCase().slice(0, 3))) return null;
  const list = listPrice(m, guests);
  const total = Math.round(Number(quote.total) * 100) / 100;
  if (!(total > 0)) return null;
  const safe = Math.min(list, Math.max(floorPrice(m, guests), total));
  return { ...quote, base: list, discount: Math.round((list - safe) * 100) / 100, total: safe };
}
