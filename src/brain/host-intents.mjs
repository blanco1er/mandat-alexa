// Host intents: what the Alexa host handles itself, before (and without) the model, in English, French and Spanish.
//  - the emergency stop ("Alexa, pause Mandat", "stop all spending") and resume: safety never waits on a model;
//  - "open Mandat settings", and settings said aloud while the settings card is open or during the first run
//    ("200 a week", "Balanced", "no catering", "that's all"), question by question on an Echo Dot;
//  - "delete my Mandat data": Alexa explains what is erased, then waits for an explicit yes.
// Each one is a real MCP tools/call on the household's own account link (the access token travels with it), so the
// MCP traffic, the live activity and the cards are the same as when the model calls the tool.
// Returns null when the utterance is not one of these (the model's brain takes the turn).
import { connectMcp } from './simulated.mjs';
import { money, tr } from '../core/i18n.mjs';
import { isExplicitYes } from '../mandat.mjs';

// lower case, no accents, straight apostrophes: plain ASCII word boundaries then work in every language
export const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘`´]/g, "'").replace(/\s+/g, ' ').trim();

const PAUSE = /\b(pause|freeze|halt)\b.*\bmandat\b|\bmandat\b.*\b(pause|freeze)\b|\bstop (all |any )?(the )?(spending|buying|purchases|payments)\b|\bemergency stop\b|\bmandat en pause\b|\b(arrete|stoppe|bloque|suspends?|gele) (toutes? )?(les )?(depenses|achats|paiements)\b|\barret d'urgence\b|\bpausa(r)? (a )?mandat\b|\bmandat en pausa\b|\b(deten|para|bloquea|congela) (todos )?(los )?(gastos|pagos)\b|\b(deten|para) (todas )?(las )?compras\b|\bparada de emergencia\b/;
const RESUME = /\b(resume|unpause|restart|reactivate)\b.*\b(mandat|spending|buying)\b|\bturn mandat back on\b|\b(reprends|reprendre|reactive|reactiver|relance|relancer)\b.*\b(mandat|depenses|achats)\b|\b(reanuda|reanudar|reactiva|reactivar)\b.*\b(mandat|gastos|compras)\b/;
const OPEN = /\b(open|show|change|edit)\b.*\bmandat\b.*\bsettings\b|\bmandat settings\b|\bsettings (for|of) mandat\b|\b(ouvre|affiche|montre|modifie)\b.*\b(reglages|parametres)\b.*\bmandat\b|\b(reglages|parametres) de mandat\b|\b(abre|muestra|ensena|cambia)\b.*\b(ajustes|configuracion)\b.*\bmandat\b|\b(ajustes|configuracion) de mandat\b/;
const DELETE = /\b(delete|erase|wipe)\b.*\bdata\b|\b(delete|erase)\b.*\bmandat\b.*\b(account|everything)\b|\b(supprime|supprimer|efface|effacer)\b.*\bdonnees\b|\b(borra|borrar|elimina|eliminar)\b.*\bdatos\b/;
const DONE = /^(alexa,? )?(that'?s (all|it|fine|good)|done|all set|all good|save( it)?|looks good|perfect|c'est (tout|bon|parfait)|termine|parfait|ca me va|eso es todo|listo|ya esta|perfecto|guardar|guarda)\b/;
// Not household errands (weather, time, a joke, music, news): a polite answer in the user's language, no model, no tool
const OFF_TOPIC = /\b(weather|forecast|temperature|what time|time is it|joke|play (some )?music|news|quel temps|la meteo|meteo|il fait (quel temps|beau|froid|chaud)|quelle heure|une blague|blague|mets de la musique|les infos|actualites|que tiempo|el tiempo|hace (frio|calor|sol)|que hora|un chiste|chiste|pon musica|las noticias)\b/;
const KEEP = /^(alexa,? )?(keep( it)?|no change|that'?s fine|fine|ok(ay)?|same|garde(-le)?|on garde|ca va|d'accord|igual|esta bien|dejalo|vale)\b/;
export const LEVEL_WORDS = [
  ['ask', /\bask (me )?first\b|\balways ask\b|\bdemande[- ]moi d'abord\b|\bme demander d'abord\b|\bdemande d'abord\b|\btoujours demander\b|\bpreguntame primero\b|\bpregunta(r)? primero\b|\bsiempre pregunta\b/],
  ['hands_off', /\bhands[- ]?off\b|\bwithin (the |my )?limits\b|\bautonome\b|\ben autonomie\b|\bautonomo\b|\bdentro de (los |mis )?limites\b/],
  ['balanced', /\bbalanced\b|\bequilibre\b|\bequilibrado\b/],
];
const CAT_WORDS = {
  cleaning: /\b(clean(ing|er|ers)?|menage|nettoyage|limpieza)\b/,
  catering: /\b(catering|caterers?|traiteurs?|comida a domicilio)\b/,
  repairs: /\b(repairs?|plumb(ing|er|ers)|handym[ae]n|reparations?|plomberie|plombiers?|bricolage|reparaciones|fontaneria|fontaneros?|manitas)\b/,
  home: /\b(home|bedding|linens?|maison|linge|literie|hogar|ropa de cama)\b/,
  pets: /\b(pets?|dogs?|pet supplies|animaux|chiens?|mascotas|perros?)\b/,
  pantry: /\b(pantry|groceries|grocery|coffee|epicerie|courses|cafe|despensa|comestibles)\b/,
};
const OFF = /\b(no|without|turn off|stop buying|never buy|disable|pas de|plus de|sans|desactive|sin|desactiva|nada de|nunca)\b/;
const ON = /\b(turn on|allow|enable|add|active|autorise|ajoute|activa|permite|anade)\b/;
const WEEK = /\b(a|per|each|every|this) week\b|\bweekly\b|\bsemaine\b|\bhebdo(madaire)?\b|\bsemana(l|les)?\b/;
const DAY = /\b(a|per|each) day\b|\bdaily\b|\bpar jour\b|\bjour\b|\bquotidien(ne)?\b|\bal dia\b|\bpor dia\b|\bdiario\b/;
const AUTO = /\bunder\b|\bbelow\b|\bon (your|its) own\b|\bwithout asking\b|\bauto\b|\bsous\b|\ben dessous\b|\btoute seule\b|\bseule\b|\bsans (me )?demander\b|\bpor debajo\b|\bpor tu cuenta\b|\bsola\b|\bsin preguntar\b|\bmenos de\b/;
const STEP_FIELD = { weekly_budget: 'weekly_budget', auto_buy_under: 'auto_buy_under', daily_cap: 'daily_cap' };

// "150 a week, and buy on your own under $40" -> { weekly_budget: 150, auto_buy_under: 40 }
export function parseSettings(text, step = null) {
  const t = norm(text);
  const patch = {};
  for (const clause of t.split(/,|;|\band\b|\bet\b|\by\b|\bthen\b|\bpuis\b|\bluego\b/)) {
    const m = /(\d{1,4}(?:[.,]\d{1,2})?)/.exec(clause.replace(/(\d),(\d{3})\b/g, '$1$2'));
    if (!m) continue;
    const n = Number(m[1].replace(',', '.'));
    if (WEEK.test(clause)) patch.weekly_budget = n;
    else if (DAY.test(clause)) patch.daily_cap = n;
    else if (AUTO.test(clause)) patch.auto_buy_under = n;
    else if (STEP_FIELD[step] && patch[STEP_FIELD[step]] === undefined) patch[STEP_FIELD[step]] = n;
  }
  for (const [level, re] of LEVEL_WORDS) if (re.test(t)) { patch.autonomy = level; break; }
  const off = [], on = [];
  // "we're almost out of dog food" / "casi no nos queda pienso para el perro" is an errand, never "no pets"
  const errand = /\b(almost out|running (low|out)|out of|need|presque plus|n'a plus|n'y a plus|besoin|il faut|casi no (nos )?queda|se nos acaba|necesit|falta)\b/.test(t);
  if (!errand) for (const clause of t.split(/,|;|\band\b|\bet\b|\by\b/)) {
    const cats = Object.keys(CAT_WORDS).filter((c) => CAT_WORDS[c].test(clause));
    if (!cats.length) continue;
    if (OFF.test(clause)) off.push(...cats); else if (ON.test(clause)) on.push(...cats);
  }
  if (off.length) patch.categories_off = off;
  if (on.length) patch.categories_on = on;
  return patch;
}

export function detectHostIntent(text, session = {}) {
  const t = norm(text);
  if (PAUSE.test(t)) return { kind: 'pause' };
  if (RESUME.test(t)) return { kind: 'resume' };
  if (session.pendingDelete) return isExplicitYes(text) ? { kind: 'delete_confirm' } : { kind: 'delete_cancel' };
  if (DELETE.test(t)) return { kind: 'delete_ask' };
  if (OPEN.test(t)) return { kind: 'open_settings' };
  if (OFF_TOPIC.test(t) && !/\$|\d|budget|mandat|book|buy|order|plan|reserv|achet|commande|presupuesto|compra|clean|menage|limpieza|cater|traiteur|dinner|diner|cena|deliver|livr|entrega|plumb|plomb|fontaner|dog|chien|perro|sheet|drap|sabana|linge|ropa/.test(t)) return { kind: 'off_topic' };
  // a bare yes with no plan waiting (too early, or said twice): nothing to pay, and no model gets the chance to
  // invent something to pay (seen live: Nova captured two orders on a repeated "Yes, book it")
  if (!session.pending && !session.settingsOpen && !session.onboarding && isExplicitYes(text) && t.split(' ').length <= 6) return { kind: 'nothing_waiting' };
  // settings said aloud: only while the settings card is open (or during the first run), and only for a short
  // sentence or one that names a week, a day or a level ("Keep it under $400" inside a long errand stays the model's)
  const short = t.split(' ').length <= 12 || WEEK.test(t) || DAY.test(t) || LEVEL_WORDS.some(([, re]) => re.test(t));
  if ((session.settingsOpen || session.onboarding) && short) {
    const step = session.onboarding?.step || null;
    const patch = parseSettings(text, step);
    if (Object.keys(patch).length) return { kind: 'settings', patch, step };
    if (DONE.test(t)) return { kind: 'settings_done', step };
    if (step && KEEP.test(t)) return { kind: 'settings_keep', step };
  }
  return null;
}

const sc = (r) => r?.structuredContent || {};
const said = (r) => r?.content?.[0]?.text || '';
function askVars(s, locale) { return { week: money(s.weekly_budget, locale), auto: money(s.auto_buy_under, locale), cap: money(s.daily_cap, locale) }; }

export async function runHostIntent({ text, session = {}, locale, household, turn, authorization, mcpUrl, headers = {} }) {
  const intent = detectHostIntent(text, session);
  if (!intent) return null;
  const extra = { ...headers, ...(authorization ? { Authorization: authorization } : {}), ...(turn ? { 'X-Mandat-Turn': turn } : {}), ...(locale ? { 'X-Mandat-Locale': locale } : {}) };
  const { client, transport } = await connectMcp(mcpUrl, { household, name: 'alexa-host', headers: extra });
  const steps = [];
  const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); steps.push({ name, args, result }); return result; };
  let s = { ...session };
  let speech = '';
  const out = (more = {}) => ({ speech: speech.replace(/\s+/g, ' ').trim(), steps, session: s, protocolVersion: transport.protocolVersion || '2025-11-25', host_intent: intent.kind, ...more });
  try {
    switch (intent.kind) {
      case 'pause': {
        const r = await call('pause_spending');
        s = { ...s, pending: null, settingsOpen: false, onboarding: null, pendingDelete: false };
        speech = said(r);
        return out();
      }
      case 'resume': { speech = said(await call('resume_spending')); return out(); }
      case 'nothing_waiting': { speech = tr(locale, 'p_nothing_waiting'); return out(); }
      case 'off_topic': { speech = tr(locale, 'off_topic'); return out(); }
      case 'delete_ask': {
        const r = await call('get_household_status', { section: 'orders' });
        const open = sc(r).open_orders || [];
        s = { ...s, pendingDelete: true };
        speech = tr(locale, 'delete_ask', { n: open.length, amt: money(open.reduce((x, o) => x + (o.amount || 0), 0), locale) });
        return out();
      }
      case 'delete_cancel': { s = { ...s, pendingDelete: false }; speech = tr(locale, 'delete_cancelled'); return out(); }
      case 'delete_confirm': {
        const r = await call('delete_my_data', { user_confirmation: text });
        s = r.isError ? { ...s, pendingDelete: false } : {};
        speech = said(r).replace(/\s*Next step:.*$/, '');
        return out({ unlinked: !r.isError });
      }
      case 'open_settings': {
        const r = await call('get_settings', {});
        const step = sc(r).onboarding_step || null;
        s = { ...s, settingsOpen: true, onboarding: step ? { step } : null };
        speech = said(r);
        return out();
      }
      case 'settings': case 'settings_keep': case 'settings_done': {
        const patch = intent.kind === 'settings' ? { ...intent.patch } : {};
        // everything the person said counts as answered (and "keep it" answers the question asked)
        const answered = ['weekly_budget', 'autonomy', 'auto_buy_under', 'daily_cap'].filter((k) => patch[k] !== undefined);
        if (intent.step && intent.kind === 'settings_keep') answered.push(intent.step);
        if (answered.length) patch.answered = answered;
        if (intent.kind === 'settings_done') {
          if (!session.onboarding) { s = { ...s, settingsOpen: false }; speech = tr(locale, 'settings_closed'); return out({ settings_closed: true }); }
          patch.onboarded = true;
        }
        let r = await call('update_settings', patch);
        if (r.isError) { speech = said(r).replace(/\s*Next step:.*$/, ''); return out(); }
        let d = sc(r);
        speech = intent.kind === 'settings_keep' ? tr(locale, 'onb_ok') : said(r);
        // first run: the next question, or done when every question was answered
        if (session.onboarding && !d.settings?.onboarded) {
          if (d.onboarding_step) speech += ' ' + tr(locale, 'ask_' + d.onboarding_step, askVars(d.settings, locale));
          else { r = await call('update_settings', { onboarded: true }); d = sc(r); speech += ' ' + said(r); }
        }
        // the first run is finished ("that's all"): the card closes, the household can start right away
        const finished = !!session.onboarding && !!d.settings?.onboarded;
        s = { ...s, settingsOpen: !finished, onboarding: d.settings?.onboarded ? null : d.onboarding_step ? { step: d.onboarding_step } : null };
        if (finished) speech += ' ' + tr(locale, 'settings_ready');
        return out(finished ? { settings_closed: true } : {});
      }
      default: return null;
    }
  } finally {
    await client.close().catch(() => {});
  }
}
