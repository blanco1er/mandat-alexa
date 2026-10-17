// Simulated model provider: the merchant agents answer deterministically from each merchant's terms.
// Zero network, zero cost: used by every test, by `npm run demo` without AWS keys, and as the judges' replay mode.
import { DAY_NAMES, listPrice, parseWhen } from '../core/merchants.mjs';

const money = (n) => '$' + (Math.round(n * 100) / 100).toFixed(Number.isInteger(n) ? 0 : 2);

function nextOpen(m, from) {
  const order = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const i = order.indexOf(from);
  for (let k = 1; k <= 7; k++) { const d = order[(i + k) % 7]; if (m.open.includes(d)) return d; }
  return m.open[0];
}

// Pick the day/slot, apply every deal that matches, cap at the merchant's floor.
export function quoteFor(m, { when = '', ask = '', guests = null } = {}) {
  const asked = parseWhen(`${when} ${ask}`);
  const day = asked.day || m.open[0];
  if (!m.open.includes(day)) {
    const alt = nextOpen(m, day);
    return { quote: null, reply: `Sorry, we are closed on ${DAY_NAMES[day]}. The closest we can do is ${DAY_NAMES[alt]}.`, closed: true };
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
  const what = m.unit === 'guest' ? `${guests || 1} guests` : m.label.toLowerCase();
  const reply = off
    ? `${money(list)} for ${what}, down to ${money(total)} for ${why}. ${DAY_NAMES[day]} at ${slot} works for us.`
    : `${money(list)} for ${what}. ${DAY_NAMES[day]} at ${slot} works for us.`;
  return { quote: { total, day, slot, slotLabel: `${DAY_NAMES[day]} ${slot}`, guests: m.unit === 'guest' ? guests || 1 : null, conditions: why ? `Includes ${why}.` : '' }, reply };
}

export class SimulatedProvider {
  constructor() { this.name = 'simulated'; this.model = 'simulated'; }
  // One negotiation turn with a merchant's agent.
  async merchantAgent({ merchant, when, ask, guests }) {
    const r = quoteFor(merchant, { when, ask, guests });
    // A counter-offer below the floor gets the floor, politely.
    const asked = /\$\s?(\d+(?:\.\d+)?)/.exec(ask || '');
    if (r.quote && asked && Number(asked[1]) < r.quote.total) r.reply += ` ${money(r.quote.total)} is the best we can do.`;
    return r;
  }
  // The merchant's answer to a change on a confirmed booking. The agreed price is honoured on an accepted move.
  async merchantChange({ merchant, order, change }) {
    if (change.field === 'date') {
      const day = parseWhen(change.value).day;
      if (!day) return { accepted: false, reply: 'Which day would you like instead?' };
      if (merchant.moves === 'declines' || !merchant.open.includes(day)) {
        return { accepted: false, reply: merchant.open.includes(day) ? `Sorry, we cannot move a booking this close to the date.` : `Sorry, we are closed on ${DAY_NAMES[day]}, so we cannot move your booking.` };
      }
      const slot = merchant.slots[parseWhen(order.slotLabel || '').part] || Object.values(merchant.slots)[0];
      return { accepted: true, reply: `Done, moved to ${DAY_NAMES[day]} at ${slot}. Same price.`, slotLabel: `${DAY_NAMES[day]} ${slot}`, total: order.amount };
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
