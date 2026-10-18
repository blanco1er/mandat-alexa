// Languages: what Mandat says, in the user's language. English (en-US) is the default and the reference; French
// (fr-FR) and Spanish (es-ES, es-US) are complete for every spoken sentence of the three stories and of the
// look-closer / compare / swap flow. Pure module (no Node imports): used by the server, the simulated brain and the
// cards (the card strings and the phrasebook are inlined into each MCP App at build time).
//
// Data stays canonical (English catalogue titles, "Friday 10 AM" slots, USD amounts): only what is said or shown is
// translated, so ids, prices and slots never drift between languages. The household's currency is kept (USD in this
// sandbox); numbers, prices and times follow the locale ("372 $", "19 h 30", "las 19:30").

export const LOCALES = ['en-US', 'fr-FR', 'es-ES', 'es-US'];
export function normLocale(x) {
  const s = String(x || '').toLowerCase();
  if (s.startsWith('fr')) return 'fr-FR';
  if (s === 'es-us' || s === 'es-419' || s === 'es-mx') return 'es-US';
  if (s.startsWith('es')) return 'es-ES';
  return 'en-US';
}
export const langOf = (loc) => normLocale(loc).slice(0, 2);

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
export function money(n, loc = 'en-US', currency = 'USD') {
  const v = r2(n);
  return new Intl.NumberFormat(normLocale(loc), { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }).format(v).replace(/ | /g, ' ');
}
export function list(xs, loc = 'en-US') {
  const and = { en: 'and', fr: 'et', es: 'y' }[langOf(loc)];
  return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${and} ${xs[xs.length - 1]}`;
}

// ---- days and times ("Friday 10 AM" is the canonical slot label) ----
const EN_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAYS = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  fr: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
  es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
};
export const dayName = (enDay, loc) => { const i = EN_DAYS.indexOf(String(enDay).toLowerCase()); return i < 0 ? enDay : DAYS[langOf(loc)][i]; };
function hhmm(h, m, lang) { return lang === 'fr' ? `${h} h${m ? ' ' + String(m).padStart(2, '0') : ''}` : `${h}:${String(m).padStart(2, '0')}`; }
// "Friday 10 AM" -> { day: 'Friday', h: 10, m: 0 }
function parseSlot(label) {
  const x = /^(\w+day)\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(String(label || '').trim());
  if (!x) return null;
  const h12 = Number(x[2]) % 12;
  return { day: x[1], h: h12 + (x[4].toUpperCase() === 'PM' ? 12 : 0), m: Number(x[3] || 0) };
}
// What a card shows: "vendredi 10 h", "viernes 10:00", "Delivery in 2 days" -> "Livraison sous 2 jours".
export function slot(label, loc = 'en-US') {
  const lang = langOf(loc);
  if (lang === 'en' || !label) return label || '';
  const p = parseSlot(label);
  if (p) return `${dayName(p.day, loc)} ${hhmm(p.h, p.m, lang)}`;
  return phrase(label, loc);
}
// What the voice says: "Friday at 10 AM", "vendredi à 10 h", "el viernes a las 10:00".
export function spokenSlot(label, loc = 'en-US') {
  const lang = langOf(loc);
  const p = parseSlot(label);
  if (!p) return lang === 'en' ? String(label || '') : phrase(label, loc);
  if (lang === 'en') return String(label).replace(/^(\w+day) (\d)/, '$1 at $2');
  if (lang === 'fr') return `${dayName(p.day, loc)} à ${hhmm(p.h, p.m, lang)}`;
  return `el ${dayName(p.day, loc)} a ${p.h === 1 || p.h === 13 ? 'la' : 'las'} ${hhmm(p.h, p.m, lang)}`;
}

// ---- phrasebook: catalogue titles, service labels, deals, ingredients (shown on cards and said aloud) ----
export const PHRASES = {
  fr: {
    'Guest bed bundle: queen percale sheet set + 2 pillowcases': 'Parure d’invités : draps en percale 160 + 2 taies',
    'King sateen sheet set, white': 'Parure en satin de coton 180, blanche',
    'All-season queen duvet, hypoallergenic': 'Couette toutes saisons 160, hypoallergénique',
    'Guest towel set (2 bath, 2 hand)': 'Serviettes d’invités (2 grandes, 2 petites)',
    'Chicken & brown rice dry dog food, 24 lb': 'Croquettes poulet et riz complet, 11 kg',
    'Salmon & sweet potato dry dog food, 24 lb': 'Croquettes saumon et patate douce, 11 kg',
    'Lamb & oatmeal dry dog food, 24 lb': 'Croquettes agneau et avoine, 11 kg',
    'Turkey & chicken meal grain-free dog food, 22 lb': 'Croquettes dinde et poulet sans céréales, 10 kg',
    'Northbeam medium roast, whole bean, 2 × 2 lb': 'Northbeam torréfaction moyenne, en grains, 2 × 900 g',
    'House blend dark roast, ground, 2 lb': 'Mélange maison torréfaction foncée, moulu, 900 g',
    'Swiss-water decaf, whole bean, 2 lb': 'Décaféiné à l’eau, en grains, 900 g',
    'Guest room + bath deep clean': 'Grand ménage chambre d’amis + salle de bain',
    'Guest room refresh': 'Remise en ordre de la chambre d’amis',
    'Hotel-style guest room prep': 'Chambre d’amis préparée façon hôtel',
    'Family-style dinner at home': 'Dîner familial à la maison',
    'Mediterranean dinner at home': 'Dîner méditerranéen à la maison',
    'Comfort-food buffet at home': 'Buffet réconfortant à la maison',
    'Plumber visit (first hour)': 'Visite de plombier (première heure)',
    'Handyman, 2 hours': 'Bricoleur, 2 heures',
    'Delivery in 2 days': 'Livraison sous 2 jours',
    'a Friday slot before noon': 'un créneau le vendredi avant midi',
    'booking through an agent': 'une réservation par agent',
    'a table of six or more': 'une table de six ou plus',
    'a Sunday booking': 'une réservation le dimanche',
    'an early-week visit': 'une visite en début de semaine',
    'a morning slot': 'un créneau le matin',
    chicken: 'poulet', salmon: 'saumon', lamb: 'agneau', turkey: 'dinde', rice: 'riz', oats: 'avoine', 'sweet potato': 'patate douce', cotton: 'coton', polyester: 'polyester', coffee: 'café',
    'Two-person team, eco products, guest-room deep cleans.': 'Équipe de deux, produits écologiques, grands ménages de chambres d’amis.',
    'Same-week cleans, background-checked cleaners.': 'Ménage dans la semaine, personnel vérifié.',
    'Premium hotel-style turn-down of guest rooms.': 'Préparation haut de gamme façon hôtel.',
    'Family-style dinners cooked and served at home.': 'Dîners familiaux cuisinés et servis à domicile.',
    'Mediterranean dinners, delivered hot and plated at home.': 'Dîners méditerranéens livrés chauds et dressés à domicile.',
    'Classic American comfort food, buffet style.': 'Cuisine américaine réconfortante, en buffet.',
  },
  es: {
    'Guest bed bundle: queen percale sheet set + 2 pillowcases': 'Juego de invitados: sábanas de percal 150 + 2 fundas',
    'King sateen sheet set, white': 'Juego de sábanas de satén 180, blanco',
    'All-season queen duvet, hypoallergenic': 'Edredón nórdico 150 para todo el año, hipoalergénico',
    'Guest towel set (2 bath, 2 hand)': 'Toallas de invitados (2 de baño, 2 de manos)',
    'Chicken & brown rice dry dog food, 24 lb': 'Pienso de pollo y arroz integral, 11 kg',
    'Salmon & sweet potato dry dog food, 24 lb': 'Pienso de salmón y boniato, 11 kg',
    'Lamb & oatmeal dry dog food, 24 lb': 'Pienso de cordero y avena, 11 kg',
    'Turkey & chicken meal grain-free dog food, 22 lb': 'Pienso de pavo y pollo sin cereales, 10 kg',
    'Northbeam medium roast, whole bean, 2 × 2 lb': 'Northbeam tueste medio, en grano, 2 × 900 g',
    'House blend dark roast, ground, 2 lb': 'Mezcla de la casa tueste oscuro, molido, 900 g',
    'Swiss-water decaf, whole bean, 2 lb': 'Descafeinado al agua, en grano, 900 g',
    'Guest room + bath deep clean': 'Limpieza a fondo del cuarto de invitados y el baño',
    'Guest room refresh': 'Puesta a punto del cuarto de invitados',
    'Hotel-style guest room prep': 'Cuarto de invitados preparado como en un hotel',
    'Family-style dinner at home': 'Cena familiar en casa',
    'Mediterranean dinner at home': 'Cena mediterránea en casa',
    'Comfort-food buffet at home': 'Bufé casero en casa',
    'Plumber visit (first hour)': 'Visita de fontanero (primera hora)',
    'Handyman, 2 hours': 'Manitas, 2 horas',
    'Delivery in 2 days': 'Entrega en 2 días',
    'a Friday slot before noon': 'una cita el viernes antes del mediodía',
    'booking through an agent': 'reservar a través de un agente',
    'a table of six or more': 'una mesa de seis o más',
    'a Sunday booking': 'una reserva en domingo',
    'an early-week visit': 'una visita a principios de semana',
    'a morning slot': 'una cita por la mañana',
    chicken: 'pollo', salmon: 'salmón', lamb: 'cordero', turkey: 'pavo', rice: 'arroz', oats: 'avena', 'sweet potato': 'boniato', cotton: 'algodón', polyester: 'poliéster', coffee: 'café',
    'Two-person team, eco products, guest-room deep cleans.': 'Equipo de dos, productos ecológicos, limpiezas a fondo.',
    'Same-week cleans, background-checked cleaners.': 'Limpiezas en la misma semana, personal verificado.',
    'Premium hotel-style turn-down of guest rooms.': 'Preparación de cuarto de invitados al estilo hotel.',
    'Family-style dinners cooked and served at home.': 'Cenas familiares cocinadas y servidas en casa.',
    'Mediterranean dinners, delivered hot and plated at home.': 'Cenas mediterráneas servidas calientes en casa.',
    'Classic American comfort food, buffet style.': 'Comida casera americana, tipo bufé.',
  },
};
export function phrase(text, loc = 'en-US') {
  const lang = langOf(loc);
  if (lang === 'en' || text == null) return text;
  return PHRASES[lang]?.[text] ?? text;
}
// "Includes a Friday slot before noon." -> "un créneau le vendredi avant midi"
export const dealOf = (conditions, loc) => phrase(String(conditions || '').replace(/^Includes /, '').replace(/\.$/, '').split(' and ').map((x) => x.trim()).join(' and '), loc);

// ---- the explicit yes, per language (money rule: never looser than English) ----
export const YES_WORDS = {
  en: ['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'confirm', 'confirmed', 'approve', 'approved', 'go ahead', 'do it', 'book it', 'buy it', 'pay', 'sounds good'],
  fr: ['oui', 'ouais', 'd’accord', "d'accord", 'ok', 'okay', 'vas-y', 'vas y', 'allez-y', 'allez y', 'confirme', 'je confirme', 'réserve', 'achète', 'paie', 'c’est bon', "c'est bon", 'parfait'],
  es: ['sí', 'si', 'vale', 'ok', 'okay', 'claro', 'de acuerdo', 'adelante', 'confirmo', 'confírmalo', 'resérvalo', 'reserva', 'cómpralo', 'compra', 'paga', 'perfecto'],
};
export const NO_WORDS = {
  en: ['no', 'not', "don't", 'cancel', 'wait', 'stop'],
  fr: ['non', 'pas', 'annule', 'attends', 'stop', 'arrête'],
  es: ['no', 'cancela', 'espera', 'para', 'todavía no'],
};

// ---- spoken sentences: one function per message, same arguments in every language ----
const N = {
  en: { cleaning: ['cleaner', 'cleaners'], catering: ['caterer', 'caterers'], plumbing: ['plumber', 'plumbers'], handyman: ['handyman', 'handymen'], pros: ['pro', 'pros'], products: ['product', 'products'] },
  fr: { cleaning: ['entreprise de ménage', 'entreprises de ménage'], catering: ['traiteur', 'traiteurs'], plumbing: ['plombier', 'plombiers'], handyman: ['bricoleur', 'bricoleurs'], pros: ['professionnel', 'professionnels'], products: ['produit', 'produits'] },
  es: { cleaning: ['empresa de limpieza', 'empresas de limpieza'], catering: ['catering', 'caterings'], plumbing: ['fontanero', 'fontaneros'], handyman: ['manitas', 'manitas'], pros: ['profesional', 'profesionales'], products: ['producto', 'productos'] },
};
export const noun = (cat, n, loc) => { const t = N[langOf(loc)]; const w = t[cat] || t.pros; return n === 1 ? w[0] : w[1]; };
const per = { en: { weekly: 'week', monthly: 'month' }, fr: { weekly: 'semaine', monthly: 'mois' }, es: { weekly: 'semana', monthly: 'mes' } };

export const MSG = {
  en: {
    st_none: () => 'You have no spending budget set yet.',
    st_env: (v) => `${v.purpose || 'Your budget'}: ${v.left} left of ${v.budget}${v.period === 'once' ? '' : ' this ' + per.en[v.period]}${v.held ? `, ${v.held} on hold` : ''}.`,
    st_open: (v) => `${v.n} ${v.n === 1 ? 'order is' : 'orders are'} open: ${v.names}.`,
    st_noopen: () => 'No open orders.',
    st_prefs: (v) => `I remember: ${v.list}.`,
    st_noprefs: () => 'I have no household preferences saved yet.',
    st_pending: (v) => `${v.n === 1 ? 'One plan is' : v.n + ' plans are'} waiting for your yes.`,
    md_rule_auto: (v) => `I will buy on my own under ${v.amt} and ask you above that.`,
    md_rule_ask: () => 'I will ask you before every payment.',
    md_per: (v) => (v.period === 'once' ? '' : ` per ${per.en[v.period]}`),
    md_done: (v) => `Done. ${v.purpose}: ${v.budget}${v.per}. ${v.rule}`,
    md_pending: (v) => `I set ${v.budget}${v.per} for ${v.purpose}. To finish, approve it once with PayPal from the link on the screen or in your Alexa app. ${v.rule}`,
    rem_ok: (v) => `Got it. ${v.subject}: ${v.fact}. I will remember that.`,
    because: (v) => `${v.who} ${/^(is|are)\b/i.test(v.fact) ? '' : 'is '}${v.fact}`,
    svc_one: (v) => `I asked the one ${v.one} available.`,
    svc_many: (v) => `I asked ${v.n} ${v.label}.`,
    svc_line: (v) => `${v.n === 1 ? '' : v.i === 0 ? 'Best: ' : 'Then: '}${v.merchant}, ${v.total} ${v.slot}${v.base ? `, down from ${v.base}` : ''}`,
    prod_best: (v) => `${v.usual ? 'Your usual' : 'Best match'}: ${v.title}, ${v.total} from ${v.merchant}.${v.skip}`,
    prod_skip: (v) => ` I skipped ${v.n} with ${v.ingredients}, because ${v.because}.`,
    neg_says: (v) => `${v.m} says: ${v.reply}`,
    neg_agreed: (v) => `${v.m} agreed: ${v.total} instead of ${v.before}, ${v.slot}.`,
    plan_auto: (v) => `${v.items}. That is ${v.total}, under your ${v.auto} auto-approve rule, so I can buy it right away.`,
    plan_ask: (v) => `Here is the plan: ${v.items}. Total ${v.total}${v.discount ? `, after ${v.discount} negotiated off` : ''}. That leaves ${v.left} of your ${v.budget}. Should I book it?`,
    booked: (v) => `${v.auto ? 'Bought, under your auto-approve rule.' : 'Booked.'} ${v.n === 1 ? 'One payment hold' : `${v.n} payment holds`} for ${v.total}; nothing is charged until ${v.n === 1 ? 'it is' : 'each is'} delivered. ${v.left} left in ${v.purpose}.`,
    already: () => 'Already booked: nothing new was charged.',
    chg_agreed: (v) => `${v.m} agreed: ${v.slot}, same hold of ${v.amount}.`,
    chg_declined: (v) => `${v.m} can't do it: ${v.reply} I voided their ${v.amount} hold, nothing was charged.${v.alt ? ` ${v.alt} can do ${v.altSlot} for ${v.altTotal}. Want me to book them?` : ''}`,
    cap_partial: (v) => `${v.m} billed ${v.take}, ${v.diff} less than held. I captured ${v.take} and released the rest.`,
    cap_full: (v) => `Paid ${v.m} ${v.take}.`,
    cancelled: (v) => `Cancelled ${v.m}. The ${v.amount} hold is released; nothing was charged.`,
    settled_pre: (v) => `Paid ${v.m} ${v.take}, then: `,
    refund: (v) => `${v.settled}Refund of ${v.back} from ${v.m} is on its way.`,
    left_in: (v) => `${v.left} left in ${v.purpose}.`,
    // look closer / compare / swap
    det_svc: (v) => `${v.m}: ${v.total} for ${v.what}, ${v.slot}.`,
    det_prod: (v) => `${v.title}, ${v.total} from ${v.m}, delivered in 2 days.`,
    in_plan: () => 'It is in your plan.',
    why_cheapest: (v) => `Cheapest of the ${v.n} ${v.noun} I asked`,
    why_more: (v) => `${v.diff} more than the cheapest of ${v.n}`,
    why_off: (v) => `${v.amt} off${v.deal ? ': ' + v.deal : ''}`,
    why_rated: (v) => `Best rated, ${v.r}`,
    why_usual: () => 'Your usual brand',
    why_skipped: (v) => `Skipped ${v.n} with ${v.ing}: ${v.because}`,
    why_verified: () => 'Agent identity verified',
    rule_auto: (v) => `Buys on its own: under your ${v.amt} rule`,
    rule_above: (v) => `Needs your yes: above your ${v.amt} rule`,
    rule_always: () => 'Needs your yes before paying',
    spec_what: () => 'What', spec_when: () => 'When', spec_guests: () => 'Guests', spec_where: () => 'Where', spec_about: () => 'About', spec_delivery: () => 'Delivery', spec_made: () => 'Made with', spec_qty: () => 'Quantity',
    spec_per_guest: (v) => `${v.n} (${v.price} per guest)`, spec_area: (v) => `${v.area}, rated ${v.r}`, spec_fee: (v) => `${v.slot}, ${v.fee} delivery`, spec_free: (v) => `${v.slot}, free delivery`,
    alt_cheapest: (v) => `${v.name} is already the cheapest of the ${v.n} ${v.noun} I found.`,
    alt_none: () => 'There is no other option from that search. I can search again with another day or price.',
    alt_list: (v) => `${v.n === 1 ? 'One other option' : `${v.n} other options`}: ${v.items}.`,
    cmp_part: (v) => `${v.name}: ${v.total}${v.slot ? `, ${v.slot}, rated ${v.r}` : ''}${v.off ? `, ${v.off} off` : ''}`,
    cmp_cheaper: (v) => `${v.name} is ${v.diff} cheaper${v.best ? `; ${v.best} is rated higher` : ''}.`,
    cmp_same: () => 'Same price.',
    rev_swap: (v) => `Swapped ${v.out} for ${v.in}.`,
    rev_removed: (v) => `Removed ${v.out}.`,
    rev_added: (v) => `Added ${v.in}.`,
    rev_tail_auto: (v) => `New total ${v.total}, under your auto-approve rule.`,
    rev_tail: (v) => `New total ${v.total}, ${v.left} left of your ${v.budget}. Should I book it?`,
    review: (v) => `The plan: ${v.items}. Total ${v.total}, ${v.left} left of your ${v.budget}.${v.ask ? ' Should I book it?' : ''}`,
    // errors the user hears (the "Next step" for the assistant stays in English)
    e_over: (v) => `That plan costs ${v.total} but only ${v.left} is left in ${v.purpose}.`,
    e_need_yes: (v) => `I need your explicit yes before paying ${v.total}.`,
    e_changed: () => 'That plan was changed since, so I did not pay anything.',
    e_no_budget: () => 'There is no spending budget yet, so I cannot pay for anything.',
    e_no_plan: () => 'No plan is waiting for your yes right now.',
    e_two: () => 'I need two or three options to compare.',
    e_empty: () => 'Removing that leaves nothing in the plan.',
    e_same: () => 'That would not change the plan.',
    e_no_service: (v) => `No ${v.noun} can do ${v.day || 'that'}${v.max ? ` under ${v.max}` : ''}.`,
    e_guests: () => 'How many guests should the caterer plan for?',
    e_nothing: (v) => `I found nothing for ${v.q}${v.prefs ? ' that fits your household preferences' : ''}.`,
    e_expired_quote: (v) => `The quote from ${v.m} has expired.`,
    e_gone: () => 'I cannot find that option any more.',
    e_split: (v) => `Under your ${v.amt} rule each product is its own plan, so the small ones go through at once.`,
    e_left_now: (v) => `Only ${v.left} is left now, the plan costs ${v.total}.`,
    // live activity lines
    l_asking: (v) => `Asking ${v.m}…`, l_verified: () => 'verified agent', l_holding: (v) => `Holding ${v.amt} for ${v.m}`, l_not_charged: () => 'not charged until it is done',
    l_moved: (v) => `${v.m} moved it`, l_cant_move: (v) => `${v.m} can't move it`, l_released: (v) => `Released the ${v.amt} hold`, l_nothing: () => 'nothing was charged', l_negotiated: (v) => `Negotiated with ${v.m}`,
    ls_status: () => 'Checking your budget', ls_budget: (v) => `Setting a ${v.amt} budget`, ls_remember: (v) => `Remembering: ${v.s}`, ls_svc: (v) => `Asking ${v.noun} near you for ${v.when}`, ls_prod: () => 'Searching the shops',
    ls_negotiate: () => 'Negotiating', ls_propose: () => 'Building one plan', ls_confirm: () => 'Placing payment holds', ls_change: () => 'Asking the merchant to change it', ls_capture: () => 'Paying the merchant', ls_refund: () => 'Asking for a refund', ls_cancel: () => 'Cancelling',
    ls_details: () => 'Opening the details', ls_alts: () => 'Looking at other options', ls_cheaper: () => 'Looking for something cheaper', ls_compare: () => 'Comparing side by side', ls_revise: () => 'Updating the plan', ls_review: () => 'Opening the plan', ls_working: () => 'Working',
    le_svc: (v) => `${v.n} ${v.noun} asked · ${v.q} ${v.q === 1 ? 'quote' : 'quotes'}`, le_best: (v) => `best ${v.m}`, le_usual: (v) => `your usual: ${v.m}`, le_prod: (v) => `${v.n} ${v.n === 1 ? 'product' : 'products'} compared`, le_skipped: (v) => `${v.n} skipped: ${v.ing}`,
    le_plan: (v) => `Plan ${v.total}`, le_plan_auto: () => 'under your auto-buy rule', le_plan_left: (v) => `${v.left} left · needs your yes`, le_holds: (v) => `${v.n} payment ${v.n === 1 ? 'hold' : 'holds'} placed`, le_left_nc: (v) => `${v.left} left · nothing charged yet`,
    le_budget: (v) => `Budget ${v.amt} set`, le_budget_auto: (v) => `buys on its own under ${v.amt}`, le_budget_ask: () => 'asks before every payment', le_left: (v) => `${v.left} left`, le_nobudget: () => 'No budget yet', le_compared: (v) => `${v.n} options compared`, le_apart: (v) => `${v.amt} apart`, le_others: (v) => `${v.n} other ${v.n === 1 ? 'option' : 'options'}`, le_done: () => 'Done',
  },
  fr: {
    st_none: () => 'Vous n’avez pas encore de budget.',
    st_env: (v) => `${v.purpose || 'Votre budget'} : il reste ${v.left} sur ${v.budget}${v.period === 'once' ? '' : ' ce' + (v.period === 'weekly' ? 'tte semaine' : ' mois')}${v.held ? `, dont ${v.held} réservés` : ''}.`,
    st_open: (v) => `${v.n} ${v.n === 1 ? 'commande en cours' : 'commandes en cours'} : ${v.names}.`,
    st_noopen: () => 'Aucune commande en cours.',
    st_prefs: (v) => `Je retiens : ${v.list}.`,
    st_noprefs: () => 'Je n’ai encore aucune préférence pour la maison.',
    st_pending: (v) => `${v.n === 1 ? 'Un plan attend' : v.n + ' plans attendent'} votre accord.`,
    md_rule_auto: (v) => `J’achèterai seule en dessous de ${v.amt} et je vous demanderai au-dessus.`,
    md_rule_ask: () => 'Je vous demanderai avant chaque paiement.',
    md_per: (v) => (v.period === 'once' ? '' : ` par ${per.fr[v.period]}`),
    md_done: (v) => `C’est fait. ${v.purpose} : ${v.budget}${v.per}. ${v.rule}`,
    md_pending: (v) => `J’ai prévu ${v.budget}${v.per} pour ${v.purpose}. Pour finir, validez-le une fois avec PayPal depuis le lien à l’écran ou dans l’app Alexa. ${v.rule}`,
    rem_ok: (v) => `C’est noté. ${v.subject} : ${v.fact}. Je m’en souviendrai.`,
    because: (v) => `${v.who} ${/^(est|sont)\b/i.test(v.fact) ? '' : 'est '}${v.fact}`,
    svc_one: (v) => `J’ai demandé au seul ${v.one} disponible.`,
    svc_many: (v) => `J’ai demandé à ${v.n} ${v.label}.`,
    svc_line: (v) => `${v.n === 1 ? '' : v.i === 0 ? 'Le meilleur : ' : 'Ensuite : '}${v.merchant}, ${v.total} ${v.slot}${v.base ? `, au lieu de ${v.base}` : ''}`,
    prod_best: (v) => `${v.usual ? 'Votre habituel' : 'Le meilleur choix'} : ${v.title}, ${v.total} chez ${v.merchant}.${v.skip}`,
    prod_skip: (v) => ` J’en ai écarté ${v.n} avec du ${v.ingredients}, car ${v.because}.`,
    neg_says: (v) => `${v.m} répond : ${v.reply}`,
    neg_agreed: (v) => `${v.m} accepte : ${v.total} au lieu de ${v.before}, ${v.slot}.`,
    plan_auto: (v) => `${v.items}. Ça fait ${v.total}, sous votre règle des ${v.auto}, donc je peux l’acheter tout de suite.`,
    plan_ask: (v) => `Voici le plan : ${v.items}. Total ${v.total}${v.discount ? `, après ${v.discount} négociés` : ''}. Il restera ${v.left} sur vos ${v.budget}. Je réserve ?`,
    booked: (v) => `${v.auto ? 'Acheté, sous votre règle d’achat automatique.' : 'C’est réservé.'} ${v.n === 1 ? 'Un paiement réservé' : `${v.n} paiements réservés`} pour ${v.total} ; rien n’est débité avant la livraison. Il reste ${v.left} pour ${v.purpose}.`,
    already: () => 'Déjà réservé : rien de nouveau n’a été débité.',
    chg_agreed: (v) => `${v.m} accepte : ${v.slot}, même réservation de ${v.amount}.`,
    chg_declined: (v) => `${v.m} ne peut pas : ${v.reply} J’ai annulé leur réservation de ${v.amount}, rien n’a été débité.${v.alt ? ` ${v.alt} peut le faire ${v.altSlot} pour ${v.altTotal}. Je les réserve ?` : ''}`,
    cap_partial: (v) => `${v.m} a facturé ${v.take}, ${v.diff} de moins que prévu. J’ai payé ${v.take} et libéré le reste.`,
    cap_full: (v) => `${v.m} est payé : ${v.take}.`,
    cancelled: (v) => `${v.m} est annulé. La réservation de ${v.amount} est libérée ; rien n’a été débité.`,
    settled_pre: (v) => `${v.m} est payé ${v.take}, puis : `,
    refund: (v) => `${v.settled}${v.settled ? 'le' : 'Le'} remboursement de ${v.back} par ${v.m} est en route.`,
    left_in: (v) => `Il reste ${v.left} pour ${v.purpose}.`,
    det_svc: (v) => `${v.m} : ${v.total} pour ${v.what}, ${v.slot}.`,
    det_prod: (v) => `${v.title}, ${v.total} chez ${v.m}, livré sous 2 jours.`,
    in_plan: () => 'C’est dans votre plan.',
    why_cheapest: (v) => `Le moins cher des ${v.n} ${v.noun} contactés`,
    why_more: (v) => `${v.diff} de plus que le moins cher des ${v.n}`,
    why_off: (v) => `${v.amt} de remise${v.deal ? ' : ' + v.deal : ''}`,
    why_rated: (v) => `Le mieux noté, ${v.r}`,
    why_usual: () => 'Votre marque habituelle',
    why_skipped: (v) => `${v.n} écarté${v.n === 1 ? '' : 's'} (${v.ing}) : ${v.because}`,
    why_verified: () => 'Identité de l’agent vérifiée',
    rule_auto: (v) => `Achat automatique : sous votre règle des ${v.amt}`,
    rule_above: (v) => `Votre accord est nécessaire : au-dessus de ${v.amt}`,
    rule_always: () => 'Votre accord est nécessaire avant de payer',
    spec_what: () => 'Quoi', spec_when: () => 'Quand', spec_guests: () => 'Invités', spec_where: () => 'Où', spec_about: () => 'En bref', spec_delivery: () => 'Livraison', spec_made: () => 'Composition', spec_qty: () => 'Quantité',
    spec_per_guest: (v) => `${v.n} (${v.price} par personne)`, spec_area: (v) => `${v.area}, noté ${v.r}`, spec_fee: (v) => `${v.slot}, livraison ${v.fee}`, spec_free: (v) => `${v.slot}, livraison offerte`,
    alt_cheapest: (v) => `${v.name} est déjà le moins cher des ${v.n} ${v.noun} trouvés.`,
    alt_none: () => 'Cette recherche n’a pas d’autre option. Je peux chercher un autre jour ou un autre prix.',
    alt_list: (v) => `${v.n === 1 ? 'Une autre option' : `${v.n} autres options`} : ${v.items}.`,
    cmp_part: (v) => `${v.name} : ${v.total}${v.slot ? `, ${v.slot}, noté ${v.r}` : ''}${v.off ? `, ${v.off} de remise` : ''}`,
    cmp_cheaper: (v) => `${v.name} est ${v.diff} moins cher${v.best ? ` ; ${v.best} est mieux noté` : ''}.`,
    cmp_same: () => 'Même prix.',
    rev_swap: (v) => `J’ai remplacé ${v.out} par ${v.in}.`,
    rev_removed: (v) => `J’ai retiré ${v.out}.`,
    rev_added: (v) => `J’ai ajouté ${v.in}.`,
    rev_tail_auto: (v) => `Nouveau total ${v.total}, sous votre règle d’achat automatique.`,
    rev_tail: (v) => `Nouveau total ${v.total}, il restera ${v.left} sur vos ${v.budget}. Je réserve ?`,
    review: (v) => `Le plan : ${v.items}. Total ${v.total}, il restera ${v.left} sur vos ${v.budget}.${v.ask ? ' Je réserve ?' : ''}`,
    e_over: (v) => `Ce plan coûte ${v.total} mais il ne reste que ${v.left} pour ${v.purpose}.`,
    e_need_yes: (v) => `J’ai besoin de votre oui avant de payer ${v.total}.`,
    e_changed: () => 'Ce plan a changé depuis, je n’ai donc rien payé.',
    e_no_budget: () => 'Il n’y a pas encore de budget, je ne peux rien payer.',
    e_no_plan: () => 'Aucun plan n’attend votre accord pour l’instant.',
    e_two: () => 'Il me faut deux ou trois options à comparer.',
    e_empty: () => 'Sans cet article, le plan serait vide.',
    e_same: () => 'Ça ne changerait rien au plan.',
    e_no_service: (v) => `Aucun ${v.noun} n’est disponible ${v.day || 'à ce moment-là'}${v.max ? ` sous ${v.max}` : ''}.`,
    e_guests: () => 'Pour combien de personnes le traiteur doit-il prévoir ?',
    e_nothing: (v) => `Je n’ai rien trouvé pour ${v.q}${v.prefs ? ' qui respecte les préférences de la maison' : ''}.`,
    e_expired_quote: (v) => `Le devis de ${v.m} a expiré.`,
    e_gone: () => 'Je ne retrouve plus cette option.',
    e_split: (v) => `Avec votre règle des ${v.amt}, chaque produit a son propre plan, pour que les petits passent tout de suite.`,
    e_left_now: (v) => `Il ne reste plus que ${v.left}, le plan coûte ${v.total}.`,
    l_asking: (v) => `${v.m}…`, l_verified: () => 'agent vérifié', l_holding: (v) => `${v.amt} réservés pour ${v.m}`, l_not_charged: () => 'rien n’est débité avant la prestation',
    l_moved: (v) => `${v.m} a déplacé la date`, l_cant_move: (v) => `${v.m} ne peut pas déplacer`, l_released: (v) => `Réservation de ${v.amt} libérée`, l_nothing: () => 'rien n’a été débité', l_negotiated: (v) => `Négocié avec ${v.m}`,
    ls_status: () => 'Je vérifie votre budget', ls_budget: (v) => `Budget de ${v.amt}`, ls_remember: (v) => `Je retiens : ${v.s}`, ls_svc: (v) => `Je contacte des ${v.noun} près de chez vous`, ls_prod: () => 'Je compare les boutiques',
    ls_negotiate: () => 'Je négocie', ls_propose: () => 'Je prépare un seul plan', ls_confirm: () => 'Je réserve les paiements', ls_change: () => 'Je demande le changement au commerçant', ls_capture: () => 'Je paie le commerçant', ls_refund: () => 'Je demande un remboursement', ls_cancel: () => 'J’annule',
    ls_details: () => 'J’ouvre la fiche', ls_alts: () => 'Je regarde les autres options', ls_cheaper: () => 'Je cherche moins cher', ls_compare: () => 'Je compare côte à côte', ls_revise: () => 'Je mets le plan à jour', ls_review: () => 'J’ouvre le plan', ls_working: () => 'Je m’en occupe',
    le_svc: (v) => `${v.n} ${v.noun} contactés · ${v.q} devis`, le_best: (v) => `le meilleur : ${v.m}`, le_usual: (v) => `votre habituel : ${v.m}`, le_prod: (v) => `${v.n} produit${v.n === 1 ? '' : 's'} comparé${v.n === 1 ? '' : 's'}`, le_skipped: (v) => `${v.n} écarté${v.n === 1 ? '' : 's'} : ${v.ing}`,
    le_plan: (v) => `Plan à ${v.total}`, le_plan_auto: () => 'sous votre règle d’achat automatique', le_plan_left: (v) => `il restera ${v.left} · votre accord est nécessaire`, le_holds: (v) => `${v.n} paiement${v.n === 1 ? '' : 's'} réservé${v.n === 1 ? '' : 's'}`, le_left_nc: (v) => `il reste ${v.left} · rien n’est débité`,
    le_budget: (v) => `Budget de ${v.amt} prêt`, le_budget_auto: (v) => `achète seule sous ${v.amt}`, le_budget_ask: () => 'demande avant chaque paiement', le_left: (v) => `Il reste ${v.left}`, le_nobudget: () => 'Pas encore de budget', le_compared: (v) => `${v.n} options comparées`, le_apart: (v) => `${v.amt} d’écart`, le_others: (v) => `${v.n} autre${v.n === 1 ? '' : 's'} option${v.n === 1 ? '' : 's'}`, le_done: () => 'C’est fait',
  },
  es: {
    st_none: () => 'Todavía no tienes un presupuesto.',
    st_env: (v) => `${v.purpose || 'Tu presupuesto'}: quedan ${v.left} de ${v.budget}${v.period === 'once' ? '' : v.period === 'weekly' ? ' esta semana' : ' este mes'}${v.held ? `, ${v.held} retenidos` : ''}.`,
    st_open: (v) => `${v.n === 1 ? 'Hay un pedido abierto' : `Hay ${v.n} pedidos abiertos`}: ${v.names}.`,
    st_noopen: () => 'No hay pedidos abiertos.',
    st_prefs: (v) => `Recuerdo: ${v.list}.`,
    st_noprefs: () => 'Todavía no tengo preferencias de la casa.',
    st_pending: (v) => `${v.n === 1 ? 'Un plan espera' : v.n + ' planes esperan'} tu sí.`,
    md_rule_auto: (v) => `Compraré por mi cuenta por debajo de ${v.amt} y te preguntaré por encima.`,
    md_rule_ask: () => 'Te preguntaré antes de cada pago.',
    md_per: (v) => (v.period === 'once' ? '' : ` a la ${per.es[v.period]}`.replace('a la mes', 'al mes')),
    md_done: (v) => `Hecho. ${v.purpose}: ${v.budget}${v.per}. ${v.rule}`,
    md_pending: (v) => `He fijado ${v.budget}${v.per} para ${v.purpose}. Para terminar, apruébalo una vez con PayPal desde el enlace en pantalla o en la app de Alexa. ${v.rule}`,
    rem_ok: (v) => `Entendido. ${v.subject}: ${v.fact}. Lo recordaré.`,
    because: (v) => `${v.who} ${/^(es|son)\b/i.test(v.fact) ? '' : 'es '}${v.fact}`,
    svc_one: (v) => `Pregunté al único ${v.one} disponible.`,
    svc_many: (v) => `Pregunté a ${v.n} ${v.label}.`,
    svc_line: (v) => `${v.n === 1 ? '' : v.i === 0 ? 'El mejor: ' : 'Después: '}${v.merchant}, ${v.total} ${v.slot}${v.base ? `, antes ${v.base}` : ''}`,
    prod_best: (v) => `${v.usual ? 'Tu habitual' : 'La mejor opción'}: ${v.title}, ${v.total} en ${v.merchant}.${v.skip}`,
    prod_skip: (v) => ` Descarté ${v.n} con ${v.ingredients}, porque ${v.because}.`,
    neg_says: (v) => `${v.m} responde: ${v.reply}`,
    neg_agreed: (v) => `${v.m} acepta: ${v.total} en lugar de ${v.before}, ${v.slot}.`,
    plan_auto: (v) => `${v.items}. Son ${v.total}, por debajo de tu regla de ${v.auto}, así que puedo comprarlo ya.`,
    plan_ask: (v) => `Este es el plan: ${v.items}. Total ${v.total}${v.discount ? `, con ${v.discount} de descuento negociado` : ''}. Te quedarán ${v.left} de tus ${v.budget}. ¿Lo reservo?`,
    booked: (v) => `${v.auto ? 'Comprado, dentro de tu regla de compra automática.' : 'Reservado.'} ${v.n === 1 ? 'Un pago retenido' : `${v.n} pagos retenidos`} por ${v.total}; no se cobra nada hasta la entrega. Quedan ${v.left} para ${v.purpose}.`,
    already: () => 'Ya estaba reservado: no se ha cobrado nada nuevo.',
    chg_agreed: (v) => `${v.m} acepta: ${v.slot}, con la misma retención de ${v.amount}.`,
    chg_declined: (v) => `${v.m} no puede: ${v.reply} Anulé su retención de ${v.amount}, no se cobró nada.${v.alt ? ` ${v.alt} puede ${v.altSlot} por ${v.altTotal}. ¿Lo reservo?` : ''}`,
    cap_partial: (v) => `${v.m} cobró ${v.take}, ${v.diff} menos de lo retenido. Pagué ${v.take} y liberé el resto.`,
    cap_full: (v) => `Pagado a ${v.m}: ${v.take}.`,
    cancelled: (v) => `${v.m} cancelado. La retención de ${v.amount} queda liberada; no se cobró nada.`,
    settled_pre: (v) => `Pagado a ${v.m} ${v.take}, y después: `,
    refund: (v) => `${v.settled}${v.settled ? 'el' : 'El'} reembolso de ${v.back} de ${v.m} está en camino.`,
    left_in: (v) => `Quedan ${v.left} para ${v.purpose}.`,
    det_svc: (v) => `${v.m}: ${v.total} por ${v.what}, ${v.slot}.`,
    det_prod: (v) => `${v.title}, ${v.total} en ${v.m}, con entrega en 2 días.`,
    in_plan: () => 'Está en tu plan.',
    why_cheapest: (v) => `El más barato de los ${v.n} ${v.noun} consultados`,
    why_more: (v) => `${v.diff} más que el más barato de ${v.n}`,
    why_off: (v) => `${v.amt} de descuento${v.deal ? ': ' + v.deal : ''}`,
    why_rated: (v) => `El mejor valorado, ${v.r}`,
    why_usual: () => 'Tu marca de siempre',
    why_skipped: (v) => `${v.n} descartado${v.n === 1 ? '' : 's'} (${v.ing}): ${v.because}`,
    why_verified: () => 'Identidad del agente verificada',
    rule_auto: (v) => `Compra automática: por debajo de tu regla de ${v.amt}`,
    rule_above: (v) => `Necesita tu sí: por encima de ${v.amt}`,
    rule_always: () => 'Necesita tu sí antes de pagar',
    spec_what: () => 'Qué', spec_when: () => 'Cuándo', spec_guests: () => 'Invitados', spec_where: () => 'Dónde', spec_about: () => 'En breve', spec_delivery: () => 'Entrega', spec_made: () => 'Ingredientes', spec_qty: () => 'Cantidad',
    spec_per_guest: (v) => `${v.n} (${v.price} por persona)`, spec_area: (v) => `${v.area}, valoración ${v.r}`, spec_fee: (v) => `${v.slot}, envío ${v.fee}`, spec_free: (v) => `${v.slot}, envío gratis`,
    alt_cheapest: (v) => `${v.name} ya es el más barato de los ${v.n} ${v.noun} que encontré.`,
    alt_none: () => 'Esa búsqueda no tiene más opciones. Puedo buscar otro día u otro precio.',
    alt_list: (v) => `${v.n === 1 ? 'Otra opción' : `${v.n} opciones más`}: ${v.items}.`,
    cmp_part: (v) => `${v.name}: ${v.total}${v.slot ? `, ${v.slot}, valoración ${v.r}` : ''}${v.off ? `, ${v.off} de descuento` : ''}`,
    cmp_cheaper: (v) => `${v.name} es ${v.diff} más barato${v.best ? `; ${v.best} tiene mejor valoración` : ''}.`,
    cmp_same: () => 'El mismo precio.',
    rev_swap: (v) => `Cambié ${v.out} por ${v.in}.`,
    rev_removed: (v) => `Quité ${v.out}.`,
    rev_added: (v) => `Añadí ${v.in}.`,
    rev_tail_auto: (v) => `Nuevo total ${v.total}, dentro de tu regla de compra automática.`,
    rev_tail: (v) => `Nuevo total ${v.total}, te quedarán ${v.left} de tus ${v.budget}. ¿Lo reservo?`,
    review: (v) => `El plan: ${v.items}. Total ${v.total}, te quedarán ${v.left} de tus ${v.budget}.${v.ask ? ' ¿Lo reservo?' : ''}`,
    e_over: (v) => `Ese plan cuesta ${v.total} pero solo quedan ${v.left} para ${v.purpose}.`,
    e_need_yes: (v) => `Necesito tu sí antes de pagar ${v.total}.`,
    e_changed: () => 'Ese plan ha cambiado desde entonces, así que no pagué nada.',
    e_no_budget: () => 'Todavía no hay presupuesto, así que no puedo pagar nada.',
    e_no_plan: () => 'Ahora mismo ningún plan espera tu sí.',
    e_two: () => 'Necesito dos o tres opciones para comparar.',
    e_empty: () => 'Si quito eso, el plan queda vacío.',
    e_same: () => 'Eso no cambiaría el plan.',
    e_no_service: (v) => `Ningún ${v.noun} puede ${v.day || 'ese día'}${v.max ? ` por menos de ${v.max}` : ''}.`,
    e_guests: () => '¿Para cuántas personas debe preparar el catering?',
    e_nothing: (v) => `No encontré nada para ${v.q}${v.prefs ? ' que respete las preferencias de la casa' : ''}.`,
    e_expired_quote: (v) => `El presupuesto de ${v.m} ha caducado.`,
    e_gone: () => 'Ya no encuentro esa opción.',
    e_split: (v) => `Con tu regla de ${v.amt}, cada producto tiene su propio plan, para que los pequeños se compren enseguida.`,
    e_left_now: (v) => `Ahora solo quedan ${v.left}, y el plan cuesta ${v.total}.`,
    l_asking: (v) => `${v.m}…`, l_verified: () => 'agente verificado', l_holding: (v) => `${v.amt} retenidos para ${v.m}`, l_not_charged: () => 'no se cobra hasta el servicio',
    l_moved: (v) => `${v.m} cambió la fecha`, l_cant_move: (v) => `${v.m} no puede cambiarla`, l_released: (v) => `Retención de ${v.amt} liberada`, l_nothing: () => 'no se cobró nada', l_negotiated: (v) => `Negociado con ${v.m}`,
    ls_status: () => 'Revisando tu presupuesto', ls_budget: (v) => `Presupuesto de ${v.amt}`, ls_remember: (v) => `Recordando: ${v.s}`, ls_svc: (v) => `Consultando ${v.noun} cerca de ti`, ls_prod: () => 'Comparando tiendas',
    ls_negotiate: () => 'Negociando', ls_propose: () => 'Preparando un solo plan', ls_confirm: () => 'Reteniendo los pagos', ls_change: () => 'Pidiendo el cambio al comercio', ls_capture: () => 'Pagando al comercio', ls_refund: () => 'Pidiendo un reembolso', ls_cancel: () => 'Cancelando',
    ls_details: () => 'Abriendo la ficha', ls_alts: () => 'Mirando otras opciones', ls_cheaper: () => 'Buscando algo más barato', ls_compare: () => 'Comparando lado a lado', ls_revise: () => 'Actualizando el plan', ls_review: () => 'Abriendo el plan', ls_working: () => 'Trabajando',
    le_svc: (v) => `${v.n} ${v.noun} consultados · ${v.q} ${v.q === 1 ? 'presupuesto' : 'presupuestos'}`, le_best: (v) => `el mejor: ${v.m}`, le_usual: (v) => `tu habitual: ${v.m}`, le_prod: (v) => `${v.n} producto${v.n === 1 ? '' : 's'} comparado${v.n === 1 ? '' : 's'}`, le_skipped: (v) => `${v.n} descartado${v.n === 1 ? '' : 's'}: ${v.ing}`,
    le_plan: (v) => `Plan de ${v.total}`, le_plan_auto: () => 'dentro de tu regla de compra automática', le_plan_left: (v) => `quedarán ${v.left} · necesita tu sí`, le_holds: (v) => `${v.n} pago${v.n === 1 ? '' : 's'} retenido${v.n === 1 ? '' : 's'}`, le_left_nc: (v) => `quedan ${v.left} · no se cobró nada`,
    le_budget: (v) => `Presupuesto de ${v.amt} listo`, le_budget_auto: (v) => `compra sola por debajo de ${v.amt}`, le_budget_ask: () => 'pregunta antes de cada pago', le_left: (v) => `Quedan ${v.left}`, le_nobudget: () => 'Sin presupuesto todavía', le_compared: (v) => `${v.n} opciones comparadas`, le_apart: (v) => `${v.amt} de diferencia`, le_others: (v) => `${v.n} opcion${v.n === 1 ? '' : 'es'} más`, le_done: () => 'Hecho',
  },
};
export function tr(loc, key, v = {}) {
  const lang = langOf(loc);
  const f = MSG[lang]?.[key] ?? MSG.en[key];
  if (!f) return key;
  return f(v);
}

// ---- household facts in any of the three languages -> the catalogue's (English) ingredients ----
const ING = {
  poulet: 'chicken', saumon: 'salmon', agneau: 'lamb', dinde: 'turkey', riz: 'rice', avoine: 'oats', bœuf: 'beef', boeuf: 'beef', porc: 'pork', poisson: 'fish', céréales: 'grain', cereales: 'grain', blé: 'wheat',
  pollo: 'chicken', salmón: 'salmon', cordero: 'lamb', pavo: 'turkey', arroz: 'rice', avena: 'oats', ternera: 'beef', cerdo: 'pork', pescado: 'fish', trigo: 'wheat',
};
export function allergensOf(fact = '') {
  const t = String(fact).toLowerCase();
  const m = /allerg\w*\s+(?:to\s+)?([\p{L} ,&'’-]+)/iu.exec(t)
    || /al[ée]rgic[oa]s?\s+(?:a la|al|a)\s+([\p{L} ,&'’-]+)/iu.exec(t)
    || /(?:^|\s)(?:no|avoid|never|pas de|jamais de|sans|sin|nada de)\s+([\p{L} ,&'’-]+)/iu.exec(t);
  if (!m) return [];
  return m[1].split(/,|\band\b|\bet\b|\sy\s|&/)
    .map((w) => { let x = w.trim(), y; do { y = x; x = x.replace(/^(?:(?:à la|au|aux|à|du|de la|des|de|a la|al|a|el|la|los|las|le|les)\s+|(?:l)['’]\s*)/u, '').trim(); } while (x !== y); return x; })
    .filter(Boolean).map((w) => ING[w] || w);
}

// ---- the simulated brain's own sentences (src/brain/policy.mjs) ----
const POLICY = {
  en: {
    p_decline: () => 'Okay, I will not buy it. The plan stays unpaid.',
    p_asked: (v) => `I asked ${v.list}. `,
    p_restock_ask: (v) => `${v.usual ? 'Your usual ' : ''}${v.title} is ${v.total}, above your auto-approve limit, so I'm asking: should I buy it?`,
    p_restock_bought: (v) => `I ordered ${v.title}, ${v.total}, under your auto-approve rule${v.skip}.`,
    p_restock_skip: (v) => `, and skipped ${v.n} with ${v.ing} because ${v.because}`,
    p_say_yes: () => 'Say yes to confirm.',
    p_paid: (v) => `Paid ${v.n} ${v.n === 1 ? 'order' : 'orders'}.`,
    p_one_service: () => 'I can book cleaning, catering, plumbing and handyman services. Which one?',
    p_book_first: () => 'Want me to book the first one?',
    p_default: () => 'I can set a household budget, find home services and products, book them inside your budget, and change or cancel orders. What do you need?',
    p_which: () => 'Which one? You can say the cleaner, the caterer or the bedding.',
    p_alts_which: () => 'Other options for which one? The cleaner, the caterer or the bedding?',
    p_say_instead: () => 'Say which one you want instead.',
    p_compare_which: () => 'Compare which ones? For example, the two caterers.',
    p_only_one: () => 'I only have one option for that. Want me to search again?',
    p_no_plan: () => 'There is no plan waiting for your yes, so there is nothing to swap.',
    p_swap_which: () => 'Which option should I take instead? Say its name, or ask for other options.',
    p_remove_which: () => 'Which item should I take out of the plan?',
    p_choose_which: () => 'Which one should I plan?',
    p_too_many: () => 'That took too many steps; please try again with one request at a time.',
    pur_inlaws: () => 'In-laws visit', pur_guests: () => 'Guests visit', pur_plan: () => 'This plan', pur_house: () => 'Household essentials', pur_groceries: () => 'Groceries',
    sub_coffee: () => 'Coffee', sub_dog: () => 'dog',
  },
  fr: {
    p_decline: () => 'D’accord, je n’achète pas. Le plan reste impayé.',
    p_asked: (v) => `J’ai demandé à ${v.list}. `,
    p_restock_ask: (v) => `${v.usual ? 'Votre habituel, ' : ''}${v.title}, coûte ${v.total}, au-dessus de votre limite d’achat automatique, donc je vous demande : je l’achète ?`,
    p_restock_bought: (v) => `J’ai commandé ${v.title}, ${v.total}, sous votre règle d’achat automatique${v.skip}.`,
    p_restock_skip: (v) => `, et écarté ${v.n} avec du ${v.ing} car ${v.because}`,
    p_say_yes: () => 'Dites oui pour confirmer.',
    p_paid: (v) => `${v.n} ${v.n === 1 ? 'commande payée' : 'commandes payées'}.`,
    p_one_service: () => 'Je peux réserver du ménage, un traiteur, un plombier ou un bricoleur. Lequel ?',
    p_book_first: () => 'Je réserve le premier ?',
    p_default: () => 'Je peux fixer un budget pour la maison, trouver des services et des produits, les réserver dans votre budget, et modifier ou annuler des commandes. De quoi avez-vous besoin ?',
    p_which: () => 'Lequel ? Vous pouvez dire le ménage, le traiteur ou le linge de lit.',
    p_alts_which: () => 'D’autres options pour quoi ? Le ménage, le traiteur ou le linge de lit ?',
    p_say_instead: () => 'Dites-moi lequel vous préférez.',
    p_compare_which: () => 'Comparer lesquels ? Par exemple, les deux traiteurs.',
    p_only_one: () => 'Je n’ai qu’une seule option pour ça. Je cherche à nouveau ?',
    p_no_plan: () => 'Aucun plan n’attend votre accord, il n’y a rien à remplacer.',
    p_swap_which: () => 'Laquelle je prends à la place ? Dites son nom, ou demandez d’autres options.',
    p_remove_which: () => 'Quel article dois-je retirer du plan ?',
    p_choose_which: () => 'Lequel dois-je prévoir ?',
    p_too_many: () => 'Il a fallu trop d’étapes ; réessayez avec une demande à la fois.',
    pur_inlaws: () => 'Visite des beaux-parents', pur_guests: () => 'Visite d’invités', pur_plan: () => 'Ce plan', pur_house: () => 'Courant de la maison', pur_groceries: () => 'Courses',
    sub_coffee: () => 'Café', sub_dog: () => 'chien',
  },
  es: {
    p_decline: () => 'De acuerdo, no lo compro. El plan queda sin pagar.',
    p_asked: (v) => `Pregunté a ${v.list}. `,
    p_restock_ask: (v) => `${v.usual ? 'Tu habitual, ' : ''}${v.title}, cuesta ${v.total}, por encima de tu límite de compra automática, así que te pregunto: ¿lo compro?`,
    p_restock_bought: (v) => `Pedí ${v.title}, ${v.total}, dentro de tu regla de compra automática${v.skip}.`,
    p_restock_skip: (v) => `, y descarté ${v.n} con ${v.ing} porque ${v.because}`,
    p_say_yes: () => 'Di sí para confirmar.',
    p_paid: (v) => `${v.n} ${v.n === 1 ? 'pedido pagado' : 'pedidos pagados'}.`,
    p_one_service: () => 'Puedo reservar limpieza, catering, fontanero o manitas. ¿Cuál?',
    p_book_first: () => '¿Reservo el primero?',
    p_default: () => 'Puedo fijar un presupuesto para la casa, buscar servicios y productos, reservarlos dentro del presupuesto y cambiar o cancelar pedidos. ¿Qué necesitas?',
    p_which: () => '¿Cuál? Puedes decir la limpieza, el catering o la ropa de cama.',
    p_alts_which: () => '¿Otras opciones de qué? ¿La limpieza, el catering o la ropa de cama?',
    p_say_instead: () => 'Dime cuál prefieres.',
    p_compare_which: () => '¿Comparar cuáles? Por ejemplo, los dos caterings.',
    p_only_one: () => 'Solo tengo una opción para eso. ¿Busco otra vez?',
    p_no_plan: () => 'Ningún plan espera tu sí, así que no hay nada que cambiar.',
    p_swap_which: () => '¿Cuál elijo en su lugar? Di su nombre o pide otras opciones.',
    p_remove_which: () => '¿Qué quito del plan?',
    p_choose_which: () => '¿Cuál preparo?',
    p_too_many: () => 'Hicieron falta demasiados pasos; inténtalo con una petición a la vez.',
    pur_inlaws: () => 'Visita de los suegros', pur_guests: () => 'Visita de invitados', pur_plan: () => 'Este plan', pur_house: () => 'Gastos de la casa', pur_groceries: () => 'Compra',
    sub_coffee: () => 'Café', sub_dog: () => 'perro',
  },
};
POLICY.en.b_done = () => 'Done.'; POLICY.fr.b_done = () => 'C’est fait.'; POLICY.es.b_done = () => 'Hecho.';
POLICY.en.b_repeat = () => 'Sorry, I did not catch that. Could you say it again?'; POLICY.fr.b_repeat = () => 'Pardon, je n’ai pas compris. Vous pouvez répéter ?'; POLICY.es.b_repeat = () => 'Perdona, no te he entendido. ¿Puedes repetirlo?';
POLICY.en.b_nothing = () => 'Nothing was booked or charged.'; POLICY.fr.b_nothing = () => 'Rien n’a été réservé ni débité.'; POLICY.es.b_nothing = () => 'No se ha reservado ni cobrado nada.';
POLICY.en.b_next = () => 'What would you like to do?'; POLICY.fr.b_next = () => 'Que voulez-vous faire ?'; POLICY.es.b_next = () => '¿Qué quieres hacer?';
export const LANGUAGE_NAME = { en: 'English', fr: 'French', es: 'Spanish' };
for (const l of Object.keys(POLICY)) Object.assign(MSG[l], POLICY[l]);
// The end of a spoken receipt ("$59 left in In-laws visit."), and a partial capture, recognised in each language.
export const LEFT_IN_RE = { en: / \$[\d.,]+ left in .*$/, fr: / Il reste [^.]* pour .*$/, es: / Quedan [^.]* para .*$/ };
export const PARTIAL_RE = { en: /less than held/, fr: /de moins que prévu/, es: /menos de lo retenido/ };

// ---- the simulated brain hears French and Spanish: their phrasing mapped to the words its playbooks know ----
const CANON = {
  fr: [
    [/^\s*(oui|ouais|d['’]accord|ok|c['’]est bon|parfait)\b/i, 'yes'], [/^\s*(non|annule)\b/i, 'no'],
    [/\b(souviens-toi|rappelle-toi|retiens|n['’]oublie pas)\b/gi, 'remember'],
    [/\bhebdomadaire\b|\bpar semaine\b/gi, 'weekly'], [/\bmensuel\b|\bpar mois\b/gi, 'monthly'], [/\bbudget\b/gi, 'budget'],
    [/\b(tout seul|toute seule|toute seule|sans me demander)\b/gi, 'on your own'], [/\ben dessous de\b|\bsous\b/gi, 'under'],
    [/\bne dépasse pas\b|\bpas plus de\b|\breste sous\b/gi, 'keep it under'],
    [/\bmes beaux-parents arrivent\b/gi, 'my in-laws land'], [/\bbeaux-parents\b/gi, 'in-laws'],
    [/\bun ménage\b|\bune femme de ménage\b|\bménage\b|\bnettoyage\b/gi, 'a cleaner'], [/\bdu linge de lit propre\b|\bdes draps propres\b/gi, 'fresh bedding'],
    [/\blinge de lit\b|\bliterie\b/gi, 'bed linen'], [/\bparure en satin\b|\bdraps en satin\b/gi, 'sateen set'],
    [/\bun dîner\b|\bdîner\b|\bdiner\b|\brepas\b/gi, 'dinner'], [/\bpour six\b/gi, 'for six'], [/\bà la maison\b/gi, 'at home'],
    [/\btraiteurs?\b/gi, (m) => (/s$/i.test(m) ? 'caterers' : 'caterer')], [/\bplombier\b/gi, 'plumber'], [/\bbricoleur\b/gi, 'handyman'],
    [/\b(on n['’]a presque plus de|il n['’]y a presque plus de|presque plus de)\b/gi, 'almost out of'], [/\bcroquettes\b/gi, 'dog food'], [/\bcafé\b/gi, 'coffee'], [/\btorréfaction\b/gi, 'roast'],
    [/\b(a été |est |sont )?(déplacé|décalé|repoussé|avancé)e?s?\b/gi, 'moved'],
    [/\bs['’]est bien passé\b|\btout s['’]est bien passé\b/gi, 'went well'], [/\bon solde\b|\bsolde\b|\bon règle\b/gi, 'settle up'], [/\ba facturé\b|\bfacture\b/gi, 'billed'],
    [/\brembourse(?:r)? les\b/gi, 'refund the'], [/\bdes taies d['’]oreiller\b/gi, 'for the pillowcases'], [/\btaies d['’]oreiller\b/gi, 'pillowcases'],
    [/\bil reste combien\b|\bcombien il reste\b|\bcombien reste-t-il\b/gi, 'how much is left'],
    [/\bfuit\b|\bune fuite\b/gi, 'leaking'], [/\btrouve\b|\bcherche\b/gi, 'find'], [/\bmatin\b/gi, 'morning'], [/\bsoir\b/gi, 'evening'],
    [/\bmontre(?:-moi| moi)?\b|\bfais(?:-moi)? voir\b/gi, 'show me'], [/\bde plus près\b/gi, 'closer'], [/\bd['’]autres options\b|\bautres options\b|\bautre chose\b/gi, 'other options'],
    [/\bmoins cher\b/gi, 'cheaper'], [/\bplutôt\b|\bà la place\b/gi, 'instead'], [/\bremplace\b/gi, 'swap'], [/\bcompare\b/gi, 'compare'], [/\bdeux\b/gi, 'two'],
    [/\bretire\b|\benlève\b/gi, 'remove'], [/\bpourquoi\b/gi, 'why'], [/\bcelui-ci\b|\bcelle-ci\b/gi, 'this one'], [/\ble plan\b/gi, 'the plan'], [/\bprévois\b/gi, 'plan'], [/\bpour moi\b/gi, 'for me'],
  ],
  es: [
    [/^\s*[¡¿]?\s*(sí|si|vale|claro|de acuerdo|ok|perfecto)\b/i, 'yes'], [/^\s*(no|cancela)\b/i, 'no'],
    [/\b(recuerda|acuérdate de|no olvides)\b/gi, 'remember'],
    [/\bsemanal\b|\ba la semana\b|\bpor semana\b/gi, 'weekly'], [/\bmensual\b|\bal mes\b/gi, 'monthly'], [/\bpresupuesto\b/gi, 'budget'],
    [/\bpor tu cuenta\b|\bsin preguntar\b|\btú sola?\b/gi, 'on your own'], [/\bpor debajo de\b|\bmenos de\b/gi, 'under'],
    [/\bque no pase de\b|\bsin pasar de\b|\bno más de\b/gi, 'keep it under'],
    [/\bmis suegros llegan\b/gi, 'my in-laws land'], [/\bsuegros\b/gi, 'in-laws'],
    [/\buna limpieza\b|\blimpieza\b/gi, 'a cleaner'], [/\bropa de cama nueva\b|\bsábanas limpias\b/gi, 'fresh bedding'],
    [/\bropa de cama\b|\bjuego de cama\b/gi, 'bed linen'], [/\bjuego de satén\b|\bsábanas de satén\b/gi, 'sateen set'],
    [/\buna cena\b|\bcena\b/gi, 'dinner'], [/\bpara seis\b/gi, 'for six'], [/\ben casa\b/gi, 'at home'],
    [/\b(empresas de catering|caterings)\b/gi, 'caterers'], [/\bfontanero\b/gi, 'plumber'], [/\bmanitas\b/gi, 'handyman'],
    [/\b(casi no nos queda|casi no queda|se nos acaba)\b/gi, 'almost out of'], [/\bpienso(?: para el perro)?\b/gi, 'dog food'], [/\bcafé\b/gi, 'coffee'], [/\btueste\b/gi, 'roast'],
    [/\b(se ha |ha )?(cambiado|movido|retrasado|pasado)\b/gi, 'moved'],
    [/\b(todo )?salió bien\b/gi, 'went well'], [/\bliquida\b|\bpaga todo\b/gi, 'settle up'], [/\bcobró\b|\bfacturó\b/gi, 'billed'],
    [/\bdevuelve los\b|\breembolsa los\b/gi, 'refund the'], [/\bde las fundas de almohada\b/gi, 'for the pillowcases'], [/\bfundas de almohada\b/gi, 'pillowcases'],
    [/\b(cuánto queda|cuanto queda|cuánto nos queda)\b/gi, 'how much is left'],
    [/\bgotea\b|\bpierde agua\b/gi, 'leaking'], [/\bbusca\b|\bencuentra\b/gi, 'find'], [/\bpor la mañana\b/gi, 'morning'], [/\bpor la noche\b/gi, 'evening'],
    [/\b(enséñame|muéstrame|déjame ver)\b/gi, 'show me'], [/\bde cerca\b/gi, 'closer'], [/\botras opciones\b|\balgo más\b/gi, 'other options'],
    [/\bmás barato\b/gi, 'cheaper'], [/^\s*mejor\b|\ben su lugar\b|\bmejor\b/gi, 'instead'], [/\bcambia\b|\bsustituye\b/gi, 'swap'], [/\bcompara\b/gi, 'compare'], [/\bdos\b/gi, 'two'],
    [/\bquita\b|\belimina\b/gi, 'remove'], [/\bpor qué\b/gi, 'why'], [/\beste\b|\besta\b/gi, 'this one'], [/\bel plan\b/gi, 'the plan'], [/\bprepárame\b|\bplanifica\b/gi, 'plan'], [/\bpara mí\b/gi, 'for me'],
  ],
};
const DAY_MAP = { dimanche: 'Sunday', lundi: 'Monday', mardi: 'Tuesday', mercredi: 'Wednesday', jeudi: 'Thursday', vendredi: 'Friday', samedi: 'Saturday', domingo: 'Sunday', lunes: 'Monday', martes: 'Tuesday', miércoles: 'Wednesday', miercoles: 'Wednesday', jueves: 'Thursday', viernes: 'Friday', sábado: 'Saturday', sabado: 'Saturday' };
// \b knows only ASCII letters: "passé" or "à la maison" need a Unicode word boundary.
const UB = '(?:(?<![\\p{L}\\p{N}])(?=[\\p{L}\\p{N}])|(?<=[\\p{L}\\p{N}])(?![\\p{L}\\p{N}]))';
const UCANON = Object.fromEntries(Object.entries(CANON).map(([l, rules]) => [l, rules.map(([re, to]) => [new RegExp(re.source.replace(/\\b/g, UB), re.flags.includes('u') ? re.flags : re.flags + 'u'), to])]));
export function canon(text, loc) {
  const lang = langOf(loc);
  let t = String(text || '');
  if (lang !== 'en') {
    for (const [re, to] of UCANON[lang] || []) t = t.replace(re, to);
    t = t.replace(/(?<![\p{L}])(dimanche|lundi|mardi|mercredi|jeudi|vendredi|samedi|domingo|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado)(?![\p{L}])/giu, (d) => DAY_MAP[d.toLowerCase()]);
  }
  // "400 $", "400 dollars", "400 dólares" -> "$400" (the household's currency is USD in this sandbox)
  return t.replace(/(\d+(?:[.,]\d{1,2})?)\s?(?:\$|dollars?|dólares|usd)(?![\p{L}])/giu, (_, n) => `$${n.replace(',', '.')}`);
}

// ---- the cards (MCP Apps): English template -> French / Spanish, {placeholders} filled by the card ----
export const CARD_STRINGS = {
  fr: {
    '{amt} left': '{amt} restants', '{amt} left after this': '{amt} restants après ça', '{left} left of {budget}': '{left} restants sur {budget}', ' after this': ' après ça', ' this week': ' cette semaine', ' this month': ' ce mois-ci',
    'Mandat needs a change': 'Mandat a besoin d’un changement', 'Not done': 'Pas fait',
    'Checking your household…': 'Je vérifie la maison…', 'Household memory · {n} fact': 'Mémoire de la maison · {n} fait', 'Household memory · {n} facts': 'Mémoire de la maison · {n} faits', 'Remembered': 'Retenu',
    'Used in every search and every session from now on.': 'Utilisé dans chaque recherche et chaque session à partir de maintenant.',
    '{n} waiting for your yes': '{n} en attente de votre oui', '{n} on hold': '{n} en réserve', 'All settled': 'Tout est réglé', Household: 'Maison', 'No budget yet': 'Pas encore de budget',
    'Say “Set a weekly household budget of $150, and buy on your own under $40.”': 'Dites « Fixe un budget hebdomadaire de 150 $ pour la maison, et achète toute seule en dessous de 40 $. »',
    'Household · {n} budget': 'Maison · {n} budget', 'Household · {n} budgets': 'Maison · {n} budgets', left: 'restants',
    'Setting your budget…': 'Je prépare votre budget…', 'One-time budget': 'Budget ponctuel', 'Weekly budget': 'Budget hebdomadaire', 'Monthly budget': 'Budget mensuel', Active: 'Actif', 'Approve once with PayPal': 'À valider une fois avec PayPal',
    'Buys on its own': 'Achète seule', 'Under {amt}': 'Sous {amt}', Never: 'Jamais', 'Above that': 'Au-dessus', 'Asks for your yes': 'Demande votre oui', 'Pays with': 'Paie avec', 'Simulated payments': 'Paiements simulés', 'PayPal sandbox': 'PayPal sandbox', 'Approve with PayPal': 'Valider avec PayPal',
    'Asking the merchants’ agents…': 'Je contacte les agents des commerçants…', 'Your usual': 'Votre habituel', 'Verified agent': 'Agent vérifié', 'Unverified agent': 'Agent non vérifié',
    '{n} cleaner asked': '{n} entreprise de ménage contactée', '{n} cleaners asked': '{n} entreprises de ménage contactées', '{n} caterer asked': '{n} traiteur contacté', '{n} caterers asked': '{n} traiteurs contactés', '{n} plumber asked': '{n} plombier contacté', '{n} plumbers asked': '{n} plombiers contactés', '{n} handyman asked': '{n} bricoleur contacté', '{n} handymen asked': '{n} bricoleurs contactés', '{n} pros asked': '{n} professionnels contactés',
    Products: 'Produits', 'Updated quote': 'Devis mis à jour', 'Other options than {name}': 'Autres options que {name}', 'No match': 'Aucun résultat', 'No one can do it at that time': 'Personne n’est disponible à ce moment-là', 'Try another day, or a higher price limit.': 'Essayez un autre jour, ou un prix plus élevé.',
    '{n} skipped for your household': '{n} écarté(s) pour votre maison', '{n} quote': '{n} devis', '{n} quotes': '{n} devis', ' · agent card verified': ' · carte d’agent vérifiée', 'rated {r}': 'noté {r}', Was: 'Avant', Negotiated: 'Négocié', ' · every agent verified': ' · tous les agents vérifiés',
    'Now in your plan': 'Dans votre plan', 'Best quote': 'Meilleur devis', 'Best match': 'Meilleur choix', Options: 'Options', '. Tap to take it instead': '. Touchez pour la prendre à la place',
    'Take {name} instead.': 'Prends plutôt {name}.', 'Plan {name} for me.': 'Prévois {name} pour moi.', 'Other options than {name}?': 'D’autres options que {name} ?', 'Remove {name} from the plan.': 'Retire {name} du plan.', 'Show me the plan.': 'Montre-moi le plan.', 'Show me {name}.': 'Montre-moi {name}.', 'Yes, book it.': 'Oui, réserve.',
    'Preparing your plan…': 'Je prépare votre plan…', Booked: 'Réservé', 'Within your rule': 'Dans votre règle', 'Needs your yes': 'Votre oui est nécessaire', Plan: 'Plan', 'payment holds placed': 'paiements réservés', 'updated, was {amt}': 'mis à jour, avant {amt}', 'one item': 'un article', '{n} items in one plan': '{n} articles dans un plan',
    '{n} bookings, one approval': '{n} réservations, un seul accord', '{n} items, one yes': '{n} articles, un seul oui', '{n} guests': '{n} personnes', 'Already bought': 'Déjà acheté', 'within your {amt} rule': 'dans votre règle des {amt}', 'within your rule': 'dans votre règle',
    Base: 'Prix', Fees: 'Frais', Tax: 'Taxes', Total: 'Total', Booked_done: 'Réservé', 'Nothing is charged until it is done': 'Rien n’est débité avant la prestation', 'Buy now': 'Acheter', 'Approve {amt}': 'Valider {amt}', Details: 'Détails', Back: 'Retour',
    'Placing holds…': 'Réservation…', 'Try again': 'Réessayer', 'Mandat could not be reached. Nothing was booked.': 'Mandat est injoignable. Rien n’a été réservé.', '{m}, {amt}. Show details': '{m}, {amt}. Voir le détail', New: 'Nouveau',
    'Placing payment holds…': 'Je réserve les paiements…', Held: 'Réservé', Paid: 'Payé', Released: 'Libéré', Refunded: 'Remboursé', Moved: 'Déplacé', '{n} orders': '{n} commandes', 'Hold released': 'Réservation libérée', Settled: 'Réglé', '{amt} on hold': '{amt} réservés',
    'Receipt · Simulated payments': 'Reçu · Paiements simulés', 'Receipt · PayPal sandbox (test money)': 'Reçu · PayPal sandbox (argent de test)', 'PayPal sandbox (test money)': 'PayPal sandbox (argent de test)', 'Receipt · PayPal {mode}': 'Reçu · PayPal {mode}', paid: 'payé', held: 'réservé', 'Payment timeline': 'Historique du paiement', 'Replacement: {m}': 'Remplaçant : {m}', Book: 'Réserver', 'Asking…': 'Je demande…', 'Book {m} instead (offer {id}).': 'Réserve plutôt {m} (offre {id}).',
    'Opening the details…': 'J’ouvre la fiche…', Cleaning: 'Ménage', Catering: 'Traiteur', Plumbing: 'Plomberie', Handyman: 'Bricolage', Service: 'Service', 'agent verified': 'agent vérifié', 'agent not verified': 'agent non vérifié', ' · your usual': ' · votre habituel', 'In your plan': 'Dans votre plan',
    'Why Mandat picked it': 'Pourquoi Mandat l’a choisi', Choose: 'Choisir', 'Other options': 'Autres options', Remove: 'Retirer', 'Photos, {n}': 'Photos, {n}', 'Previous photo': 'Photo précédente', 'Next photo': 'Photo suivante',
    '{n} options side by side': '{n} options côte à côte', '{amt} apart': '{amt} d’écart', Cheapest: 'Le moins cher', 'Best rated': 'Le mieux noté', When: 'Quand', Rating: 'Note', Saved: 'Économie', '{name} is {amt} cheaper.': '{name} est {amt} moins cher.',
  },
  es: {
    '{amt} left': 'quedan {amt}', '{amt} left after this': 'quedarán {amt}', '{left} left of {budget}': 'quedan {left} de {budget}', ' after this': ' después', ' this week': ' esta semana', ' this month': ' este mes',
    'Mandat needs a change': 'Mandat necesita un cambio', 'Not done': 'No hecho',
    'Checking your household…': 'Revisando la casa…', 'Household memory · {n} fact': 'Memoria de la casa · {n} dato', 'Household memory · {n} facts': 'Memoria de la casa · {n} datos', Remembered: 'Recordado',
    'Used in every search and every session from now on.': 'Se usará en cada búsqueda y cada sesión a partir de ahora.',
    '{n} waiting for your yes': '{n} esperan tu sí', '{n} on hold': '{n} retenidos', 'All settled': 'Todo pagado', Household: 'Casa', 'No budget yet': 'Sin presupuesto todavía',
    'Say “Set a weekly household budget of $150, and buy on your own under $40.”': 'Di «Pon un presupuesto semanal de 150 dólares para la casa, y compra por tu cuenta por debajo de 40 dólares.»',
    'Household · {n} budget': 'Casa · {n} presupuesto', 'Household · {n} budgets': 'Casa · {n} presupuestos', left: 'quedan',
    'Setting your budget…': 'Preparando tu presupuesto…', 'One-time budget': 'Presupuesto puntual', 'Weekly budget': 'Presupuesto semanal', 'Monthly budget': 'Presupuesto mensual', Active: 'Activo', 'Approve once with PayPal': 'Apruébalo una vez con PayPal',
    'Buys on its own': 'Compra sola', 'Under {amt}': 'Por debajo de {amt}', Never: 'Nunca', 'Above that': 'Por encima', 'Asks for your yes': 'Pide tu sí', 'Pays with': 'Paga con', 'Simulated payments': 'Pagos simulados', 'PayPal sandbox': 'PayPal sandbox', 'Approve with PayPal': 'Aprobar con PayPal',
    'Asking the merchants’ agents…': 'Consultando a los agentes de los comercios…', 'Your usual': 'Tu habitual', 'Verified agent': 'Agente verificado', 'Unverified agent': 'Agente no verificado',
    '{n} cleaner asked': '{n} empresa de limpieza consultada', '{n} cleaners asked': '{n} empresas de limpieza consultadas', '{n} caterer asked': '{n} catering consultado', '{n} caterers asked': '{n} caterings consultados', '{n} plumber asked': '{n} fontanero consultado', '{n} plumbers asked': '{n} fontaneros consultados', '{n} handyman asked': '{n} manitas consultado', '{n} handymen asked': '{n} manitas consultados', '{n} pros asked': '{n} profesionales consultados',
    Products: 'Productos', 'Updated quote': 'Presupuesto actualizado', 'Other options than {name}': 'Otras opciones aparte de {name}', 'No match': 'Sin resultados', 'No one can do it at that time': 'Nadie puede a esa hora', 'Try another day, or a higher price limit.': 'Prueba otro día o un precio más alto.',
    '{n} skipped for your household': '{n} descartados por tu casa', '{n} quote': '{n} presupuesto', '{n} quotes': '{n} presupuestos', ' · agent card verified': ' · tarjeta de agente verificada', 'rated {r}': 'valoración {r}', Was: 'Antes', Negotiated: 'Negociado', ' · every agent verified': ' · todos los agentes verificados',
    'Now in your plan': 'En tu plan', 'Best quote': 'Mejor presupuesto', 'Best match': 'Mejor opción', Options: 'Opciones', '. Tap to take it instead': '. Toca para elegirla en su lugar',
    'Take {name} instead.': 'Mejor {name}.', 'Plan {name} for me.': 'Prepárame {name} para mí.', 'Other options than {name}?': '¿Otras opciones aparte de {name}?', 'Remove {name} from the plan.': 'Quita {name} del plan.', 'Show me the plan.': 'Enséñame el plan.', 'Show me {name}.': 'Enséñame {name}.', 'Yes, book it.': 'Sí, resérvalo.',
    'Preparing your plan…': 'Preparando tu plan…', Booked: 'Reservado', 'Within your rule': 'Dentro de tu regla', 'Needs your yes': 'Necesita tu sí', Plan: 'Plan', 'payment holds placed': 'pagos retenidos', 'updated, was {amt}': 'actualizado, antes {amt}', 'one item': 'un artículo', '{n} items in one plan': '{n} artículos en un plan',
    '{n} bookings, one approval': '{n} reservas, una sola aprobación', '{n} items, one yes': '{n} artículos, un solo sí', '{n} guests': '{n} personas', 'Already bought': 'Ya comprado', 'within your {amt} rule': 'dentro de tu regla de {amt}', 'within your rule': 'dentro de tu regla',
    Base: 'Precio', Fees: 'Gastos', Tax: 'Impuestos', Total: 'Total', 'Nothing is charged until it is done': 'No se cobra nada hasta el servicio', 'Buy now': 'Comprar', 'Approve {amt}': 'Aprobar {amt}', Details: 'Detalles', Back: 'Volver',
    'Placing holds…': 'Reteniendo…', 'Try again': 'Reintentar', 'Mandat could not be reached. Nothing was booked.': 'No se pudo contactar con Mandat. No se reservó nada.', '{m}, {amt}. Show details': '{m}, {amt}. Ver detalle', New: 'Nuevo',
    'Placing payment holds…': 'Reteniendo los pagos…', Held: 'Retenido', Paid: 'Pagado', Released: 'Liberado', Refunded: 'Reembolsado', Moved: 'Cambiado', '{n} orders': '{n} pedidos', 'Hold released': 'Retención liberada', Settled: 'Pagado', '{amt} on hold': '{amt} retenidos',
    'Receipt · Simulated payments': 'Recibo · Pagos simulados', 'Receipt · PayPal sandbox (test money)': 'Recibo · PayPal sandbox (dinero de prueba)', 'PayPal sandbox (test money)': 'PayPal sandbox (dinero de prueba)', 'Receipt · PayPal {mode}': 'Recibo · PayPal {mode}', paid: 'pagado', held: 'retenido', 'Payment timeline': 'Historial del pago', 'Replacement: {m}': 'Sustituto: {m}', Book: 'Reservar', 'Asking…': 'Preguntando…', 'Book {m} instead (offer {id}).': 'Reserva mejor {m} (oferta {id}).',
    'Opening the details…': 'Abriendo la ficha…', Cleaning: 'Limpieza', Catering: 'Catering', Plumbing: 'Fontanería', Handyman: 'Manitas', Service: 'Servicio', 'agent verified': 'agente verificado', 'agent not verified': 'agente no verificado', ' · your usual': ' · tu habitual', 'In your plan': 'En tu plan',
    'Why Mandat picked it': 'Por qué lo eligió Mandat', Choose: 'Elegir', 'Other options': 'Otras opciones', Remove: 'Quitar', 'Photos, {n}': 'Fotos, {n}', 'Previous photo': 'Foto anterior', 'Next photo': 'Foto siguiente',
    '{n} options side by side': '{n} opciones lado a lado', '{amt} apart': '{amt} de diferencia', Cheapest: 'El más barato', 'Best rated': 'El mejor valorado', When: 'Cuándo', Rating: 'Valoración', Saved: 'Ahorro', '{name} is {amt} cheaper.': '{name} es {amt} más barato.',
  },
};
