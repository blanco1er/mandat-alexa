// Anonymous visit log of the public demo: did the judges test it, from where, how far did they go?
// What is kept (120 days, DynamoDB TTL), per event: time, type, an anonymous visitor id (salted hash of IP + browser,
// never the IP), browser and system families, the referring site, the device and language chosen in the simulator,
// and for a voice/text turn the sentence (e-mails and numbers masked, 200 characters at most) and the tools called.
// Never: IP, password, token, e-mail, name, address. The owner's devices and our own scripts are not logged
// (X-Mandat-Visit: internal header, or the "internal" cookie set by a secret link the owner opens once).
// Read only by the owner with his AWS profile (scripts/visits-report.mjs); no public page shows it.
// Alert: an e-mail through Amazon SNS when a new outside visitor makes a turn, at most once an hour.
import crypto from 'node:crypto';

export const TTL_DAYS = 120;
const salt = () => crypto.createHash('sha256').update('mandat-visits:' + (process.env.MANDAT_NETWORK_SECRET || 'local')).digest('hex');
export const visitorId = (ip = '', ua = '') => crypto.createHash('sha256').update(`${salt()}|${ip}|${ua}`).digest('hex').slice(0, 16);
// the secret that marks the owner's own devices as internal (the cookie value and the link key)
export const internalKey = () => crypto.createHash('sha256').update('mandat-internal-visit:' + (process.env.MANDAT_NETWORK_SECRET || 'local')).digest('hex').slice(0, 32);

// e-mails, card or phone numbers and long digit runs are masked before anything is stored
export function maskText(s = '', max = 200) {
  return String(s)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\+?(?:\d[\s().-]{0,2}){7,}\d/g, '[number]')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}
export function uaFamily(ua = '') {
  const u = String(ua);
  const browser = /Edg\//.test(u) ? 'Edge' : /OPR\//.test(u) ? 'Opera' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : /curl|node|python|bot|crawl|spider|headless/i.test(u) ? 'Bot or script' : 'Other';
  const os = /iPhone|iPad|iOS/.test(u) ? 'iOS' : /Android/.test(u) ? 'Android' : /Mac OS X|Macintosh/.test(u) ? 'macOS' : /Windows/.test(u) ? 'Windows' : /Linux/.test(u) ? 'Linux' : 'Other';
  return { browser, os, bot: browser === 'Bot or script' || /HeadlessChrome/.test(u) };
}
export function refHost(ref = '', ownHost = '') {
  try { const h = new URL(ref).hostname.replace(/^www\./, ''); return h && h !== ownHost ? h : ''; } catch { return ''; }
}
const cookieOf = (h = '', name) => (String(h).split(/;\s*/).find((c) => c.startsWith(name + '=')) || '').slice(name.length + 1);
export function isInternal(headers) {
  if ((headers.get('x-mandat-visit') || '').toLowerCase() === 'internal') return true;
  if (headers.get('x-mandat-internal')) return true; // the brain's own MCP calls
  return cookieOf(headers.get('cookie') || '', 'mandat_internal') === internalKey();
}

// One event. `request` gives the visitor; `ev` = { type, ...details }. Returns false when not logged (internal).
export async function logVisit(store, request, ev, { now = Date.now() } = {}) {
  if (!store || process.env.MANDAT_VISITS === 'off') return false;
  const h = request.headers;
  if (isInternal(h)) return false;
  const ua = h.get('user-agent') || '';
  const fam = uaFamily(ua);
  const ip = h.get('x-mandat-client-ip') || 'local';
  const at = new Date(now).toISOString();
  const row = {
    at, type: String(ev.type || 'event').slice(0, 30), visitor: visitorId(ip, ua), browser: fam.browser, os: fam.os, bot: fam.bot,
    ref: ev.ref !== undefined ? ev.ref : refHost(h.get('referer') || '', new URL(request.url).hostname),
    country: (h.get('cloudfront-viewer-country') || '').slice(0, 2) || null,
    ...(ev.device ? { device: String(ev.device).slice(0, 12) } : {}),
    ...(ev.lang ? { lang: String(ev.lang).slice(0, 8) } : {}),
    ...(ev.text ? { text: maskText(ev.text) } : {}),
    ...(ev.tools ? { tools: ev.tools.slice(0, 20).map((t) => String(t).slice(0, 40)) } : {}),
    ...(ev.detail ? { detail: maskText(ev.detail, 80) } : {}),
    ...(ev.outcome ? { outcome: ev.outcome } : {}),
    ttl: Math.floor(now / 1000) + TTL_DAYS * 86400,
  };
  await store.put(`VISIT#${at.slice(0, 10)}`, `${at}#${row.visitor}#${crypto.randomBytes(2).toString('hex')}`, row);
  if (row.type === 'turn' && !row.bot) await alertNewVisitor(store, row, { now }).catch((e) => console.warn('[visits] alert:', e.message));
  return true;
}

// What a turn reached, from the tools it called (plan, yes, test payment, emergency stop, data deleted).
export function outcomeOf(steps = []) {
  const ok = (n) => steps.some((s) => s.name === n && !s.result?.isError);
  return { plan: ok('propose_plan') || ok('revise_plan') || ok('swap_item'), paid: ok('confirm_plan'), settled: ok('close_order'), stop: ok('pause_spending'), deleted: ok('delete_my_data') };
}

// ---------- alert by e-mail (Amazon SNS), at most once an hour ----------
let publisher = null; // injected in tests
export function _setPublisher(f) { publisher = f; }
async function publish(subject, message) {
  if (publisher) return publisher(subject, message);
  const topic = process.env.MANDAT_ALERT_TOPIC;
  if (!topic) return false;
  const sns = await import('@aws-sdk/client-sns'); // bundled in the Lambda Node.js runtime
  await new sns.SNSClient({ region: process.env.AWS_REGION || 'us-east-1' }).send(new sns.PublishCommand({ TopicArn: topic, Subject: subject.slice(0, 99), Message: message }));
  return true;
}
export async function alertNewVisitor(store, row, { now = Date.now() } = {}) {
  const seen = await store.get('SYSTEM#visits', `VISITOR#${row.visitor}`);
  const turns = (seen?.turns || 0) + 1;
  await store.put('SYSTEM#visits', `VISITOR#${row.visitor}`, { first: seen?.first || row.at, ref: seen?.ref || row.ref || '', turns, alerted: !!seen?.alerted, ttl: Math.floor(now / 1000) + TTL_DAYS * 86400 });
  if (seen?.alerted) return false;
  const last = await store.get('SYSTEM#visits', 'ALERT');
  if (last && now - Date.parse(last.at) < 3600e3) return false;
  const subject = `Mandat : nouveau visiteur (${row.ref || 'accès direct'}) — ${turns} tour${turns > 1 ? 's' : ''}`;
  const message = `Un visiteur externe vient d'utiliser la démo publique de Mandat for Alexa+.\n\nVenu de : ${row.ref || 'accès direct'}\nNavigateur : ${row.browser} sur ${row.os}\nAppareil : ${row.device || '—'} · langue : ${row.lang || '—'}\nDernière phrase : « ${row.text || ''} »\n\nRapport complet : AWS_PROFILE=mandat node scripts/visits-report.mjs\n(Au plus un e-mail par heure.)`;
  const sent = await publish(subject, message);
  if (sent === false) return false;
  await store.put('SYSTEM#visits', 'ALERT', { at: new Date(now).toISOString(), visitor: row.visitor });
  await store.put('SYSTEM#visits', `VISITOR#${row.visitor}`, { first: seen?.first || row.at, ref: seen?.ref || row.ref || '', turns, alerted: true, ttl: Math.floor(now / 1000) + TTL_DAYS * 86400 });
  return true;
}
