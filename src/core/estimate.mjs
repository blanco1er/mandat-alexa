// Estimated prices for REAL local businesses. Mandat has no agent and no price list for them, so it never pretends
// to know their price: it shows an ESTIMATE, computed by one transparent rule per trade, and says so everywhere
// (card, voice, plan, receipt). The business sets the real price. Rules (US, 2026, rounded to whole dollars):
//   cleaning  $50 per cleaner-hour x hours. 2 hours for a room or two (a guest room and its bathroom), 4 hours for a
//             whole home or a move-out. Sources: Housecall Pro 2026 guide ($35-75 per cleaner-hour), Seattle cleaning
//             companies ($50-90 per cleaner-hour, NW Maids 2026). The low end of Seattle company rates.
//   catering  $45 per guest. Sources: US plated full-service dinners $40-80 per guest, staffed buffets $25-45 (2026
//             vendor guides, no transparent methodology): the meeting point of the two.
//   plumbing  $150 for a visit (call-out and first hour), typical US first-hour range $100-200 [rough, not verified].
//   handyman  $75 per hour x 2 hours [rough, not verified].
// Demo partners (simulated merchant agents) are not estimated: they quote and negotiate (src/core/merchants.mjs).
export const RULES = {
  cleaning: { per: 'hour', rate: 50, hours: (need = '') => (/\b(whole|entire|full|move[- ]?out|apartment|condo)\b/i.test(need) && !/\bguest\b/i.test(need) ? 4 : 2) },
  catering: { per: 'guest', rate: 45 },
  plumbing: { per: 'visit', rate: 150 },
  handyman: { per: 'hour', rate: 75, hours: () => 2 },
};

// { total, rate, qty, per } for one booking request; null for an unknown trade.
export function estimateFor(category, { need = '', guests = null } = {}) {
  const r = RULES[category];
  if (!r) return null;
  const qty = r.per === 'guest' ? Math.max(1, Number(guests) || 1) : r.per === 'hour' ? r.hours(need) : 1;
  return { total: Math.round(r.rate * qty), rate: r.rate, qty, per: r.per };
}
