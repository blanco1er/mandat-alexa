// Simulated model provider: the merchant agents answer deterministically from each merchant's terms.
// Zero network, zero cost: used by every test, by `npm run demo` without AWS keys, and as the judges' replay mode.
import { DAY_NAMES, listPrice, parseWhen } from '../core/merchants.mjs';
import { current } from '../core/context.mjs';
import * as I from '../core/i18n.mjs';

const money = (n) => '$' + (Math.round(n * 100) / 100).toFixed(Number.isInteger(n) ? 0 : 2);

// What the merchant's agent says, in the household's language (the booking system's numbers never change).
// Times stay "19:30" here: English replies become "7:30 PM" in providers/index.mjs, French ones "19 h 30".
const DAY = (d, loc) => I.dayName(DAY_NAMES[d], loc);
const TIME = (hhmm, loc) => { const [h, m] = hhmm.split(':').map(Number); return I.langOf(loc) === 'fr' ? `${h} h${m ? ' ' + String(m).padStart(2, '0') : ''}` : hhmm; };
const SAY = {
  en: {
    quote: (v) => `${v.list} for ${v.what}${v.why ? `, down to ${v.total} for ${v.why}` : ''}. ${v.day} at ${v.slot} works for us.`,
    guests: (n) => `${n} guests`,
    closed: (v) => `Sorry, we are closed on ${v.day}. The closest we can do is ${v.alt}.`,
    best: (v) => `${v.total} is the best we can do.`,
    moved: (v) => `Done, moved to ${v.day} at ${v.slot}. Same price.`,
    too_close: () => 'Sorry, we cannot move a booking this close to the date.',
    closed_move: (v) => `Sorry, we are closed on ${v.day}, so we cannot move your booking.`,
    which_day: () => 'Which day would you like instead?',
  },
  fr: {
    quote: (v) => `${v.list} pour ${v.what}${v.why ? `, ramené à ${v.total} pour ${v.why}` : ''}. ${v.day} à ${v.slot}, c’est possible pour nous.`,
    guests: (n) => `${n} personnes`,
    closed: (v) => `Désolé, nous sommes fermés le ${v.day}. Au plus tôt, ce serait ${v.alt}.`,
    best: (v) => `${v.total}, c’est notre meilleur prix.`,
    moved: (v) => `C’est fait, déplacé au ${v.day} à ${v.slot}. Même prix.`,
    too_close: () => 'Désolé, nous ne pouvons pas déplacer une réservation si près de la date.',
    closed_move: (v) => `Désolé, nous sommes fermés le ${v.day}, nous ne pouvons pas déplacer votre réservation.`,
    which_day: () => 'Quel jour préférez-vous ?',
  },
  es: {
    quote: (v) => `${v.list} por ${v.what}${v.why ? `, ${v.total} con ${v.why}` : ''}. El ${v.day} a las ${v.slot} nos viene bien.`,
    guests: (n) => `${n} personas`,
    closed: (v) => `Lo siento, cerramos los ${v.day}. Lo más cercano sería el ${v.alt}.`,
    best: (v) => `${v.total} es lo mejor que podemos hacer.`,
    moved: (v) => `Hecho, cambiado al ${v.day} a las ${v.slot}. Mismo precio.`,
    too_close: () => 'Lo siento, no podemos cambiar una reserva tan cerca de la fecha.',
    closed_move: (v) => `Lo siento, cerramos los ${v.day}, así que no podemos cambiar su reserva.`,
    which_day: () => '¿Qué día prefiere?',
  },
};
export function merchantSay(loc, key, v = {}) { const l = I.langOf(loc); return (SAY[l][key] || SAY.en[key])(v); }
const here = () => current().locale || 'en-US';

function nextOpen(m, from) {
  const order = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const i = order.indexOf(from);
  for (let k = 1; k <= 7; k++) { const d = order[(i + k) % 7]; if (m.open.includes(d)) return d; }
  return m.open[0];
}

// Pick the day/slot, apply every deal that matches, cap at the merchant's floor.
export function quoteFor(m, { when = '', ask = '', guests = null } = {}, locale = 'en-US') {
  const asked = parseWhen(`${when} ${ask}`);
  const day = asked.day || m.open[0];
  if (!m.open.includes(day)) {
    const alt = nextOpen(m, day);
    return { quote: null, reply: merchantSay(locale, 'closed', { day: DAY(day, locale), alt: DAY(alt, locale) }), closed: true };
  }
  const part = asked.part && m.slots[asked.part] ? asked.part : Object.keys(m.slots)[0];
  const slot = m.slots[part];
  const hour = Number(slot.slice(0, 2));
  const list = listPrice(m, guests);
  const applied = (m.deals || []).filter((d) =>
    (d.any || d.days || d.before || d.minGuests) &&
    (!d.days || d.days.includes(day)) &&
    (!d.before || hour < d.before) &&
    (!d.minGuests || (guests || 0) >= d.minGuests));
  const off = Math.min(m.maxOff || 0, applied.reduce((s, d) => s + d.off, 0));
  const total = list - off;
  const why = applied.map((d) => d.why).join(' and ');
  const L = SAY[I.langOf(locale)] ? locale : 'en-US';
  const what = m.unit === 'guest' ? merchantSay(L, 'guests', guests || 1) : I.phrase(m.label, L).toLowerCase();
  const reply = merchantSay(L, 'quote', { list: I.langOf(L) === 'en' ? money(list) : I.money(list, L), total: I.langOf(L) === 'en' ? money(total) : I.money(total, L), what, why: off ? I.list(applied.map((d) => I.phrase(d.why, L)), L) : '', day: DAY(day, L), slot: TIME(slot, L) });
  return { quote: { total, day, slot, slotLabel: `${DAY_NAMES[day]} ${slot}`, guests: m.unit === 'guest' ? guests || 1 : null, conditions: why ? `Includes ${why}.` : '' }, reply };
}

export class SimulatedProvider {
  constructor() { this.name = 'simulated'; this.model = 'simulated'; }
  // One negotiation turn with a merchant's agent.
  async merchantAgent({ merchant, when, ask, guests }) {
    const loc = here();
    const r = quoteFor(merchant, { when, ask, guests }, loc);
    // A counter-offer below the floor gets the floor, politely.
    const asked = /\$\s?(\d+(?:\.\d+)?)|(\d+(?:[.,]\d+)?)\s?(?:\$|dollars?|dólares)/i.exec(ask || '');
    const askedAmt = asked ? Number(String(asked[1] || asked[2]).replace(',', '.')) : null;
    if (r.quote && askedAmt != null && askedAmt < r.quote.total) r.reply += ` ${merchantSay(loc, 'best', { total: I.langOf(loc) === 'en' ? money(r.quote.total) : I.money(r.quote.total, loc) })}`;
    return r;
  }
  // The merchant's answer to a change on a confirmed booking. The agreed price is honoured on an accepted move.
  async merchantChange({ merchant, order, change }) {
    if (change.field === 'date') {
      const day = parseWhen(change.value).day;
      const loc = here();
      if (!day) return { accepted: false, reply: merchantSay(loc, 'which_day') };
      if (merchant.moves === 'declines' || !merchant.open.includes(day)) {
        return { accepted: false, reply: merchant.open.includes(day) ? merchantSay(loc, 'too_close') : merchantSay(loc, 'closed_move', { day: DAY(day, loc) }) };
      }
      const slot = merchant.slots[parseWhen(order.slotLabel || '').part] || Object.values(merchant.slots)[0];
      return { accepted: true, reply: merchantSay(loc, 'moved', { day: DAY(day, loc), slot: TIME(slot, loc) }), slotLabel: `${DAY_NAMES[day]} ${slot}`, total: order.amount };
    }
    if (change.field === 'time') {
      const w = parseWhen(change.value);
      const slot = (w.part && merchant.slots[w.part]) || null;
      if (!slot) return { accepted: false, reply: `We only have ${Object.values(merchant.slots).join(', ')}.` };
      const day = (order.slotLabel || '').split(' ')[0];
      return { accepted: true, reply: `Sure, ${day} at ${slot}.`, slotLabel: `${day} ${slot}`, total: order.amount };
    }
    if (change.field === 'quantity') {
      const n = Number(String(change.value).match(/\d+/)?.[0]);
      if (!(n > 0)) return { accepted: false, reply: 'How many?' };
      if (merchant.unit !== 'guest') return { accepted: false, reply: 'This booking is a fixed job; the quantity cannot change.' };
      const per = order.amount / (order.guests || 1);
      return { accepted: true, reply: `Updated to ${n} guests.`, guests: n, total: Math.round(per * n * 100) / 100 };
    }
    return { accepted: false, reply: 'We can change the date, the time or the number of guests.' };
  }
}
