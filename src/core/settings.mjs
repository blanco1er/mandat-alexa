// Mandat's autonomy settings: how much Alexa may do on its own for this household. Set on first run (the settings
// card, by touch or by voice; question by question on an Echo Dot), changed anytime ("Alexa, open Mandat settings").
// Every rule here is enforced by the server, whatever the model or the card asks:
//   ask        "Ask me first": every payment waits for an explicit yes.
//   balanced   "Balanced": buys on its own up to the auto-buy amount, inside the daily limit; asks above.
//   hands_off  "Hands-off within limits": buys on its own whenever the plan fits the daily limit; asks above it.
// In every level: the weekly budget is never exceeded, a category that is off is never bought, and while Mandat is
// paused ("Alexa, pause Mandat" / "stop all spending") nothing is bought at all, not even with a yes.
export const LEVELS = ['ask', 'balanced', 'hands_off'];
export const CATEGORIES = ['cleaning', 'catering', 'repairs', 'home', 'pets', 'pantry'];
// Defaults a careful household would pick (and what the demo stories expect): $150 a week, buy alone under $40,
// at most $60 a day alone, Balanced, every category on.
export const DEFAULTS = Object.freeze({ weekly_budget: 150, auto_buy_under: 40, autonomy: 'balanced', categories: CATEGORIES, daily_cap: 60, paused: false, onboarded: false });
export const RANGE = { weekly_budget: [10, 2000], auto_buy_under: [0, 500], daily_cap: [0, 1000] };
// First-run questions, in the order a person thinks about it: how much, how free, then the limits that level uses.
export const ONBOARDING_STEPS = ['weekly_budget', 'autonomy', 'auto_buy_under', 'daily_cap'];

const r2 = (x) => Math.round(Number(x) * 100) / 100;

// Which settings category a plan line belongs to.
export function categoryOf(line = {}) {
  if (line.kind === 'service') return line.category === 'plumbing' || line.category === 'handyman' ? 'repairs' : line.category || 'repairs';
  return line.product_category || 'home';
}

// Apply a patch -> { next, changed: [field], error? }. Pure; amounts rounded to cents; the error says why in plain words.
export function applyPatch(current, patch = {}) {
  const cur = { ...DEFAULTS, ...(current || {}) };
  const next = { ...cur, categories: [...(cur.categories || CATEGORIES)] };
  const changed = [];
  for (const k of ['weekly_budget', 'auto_buy_under', 'daily_cap']) {
    if (patch[k] === undefined || patch[k] === null) continue;
    const v = r2(patch[k]);
    const [lo, hi] = RANGE[k];
    if (!(v >= lo && v <= hi)) return { error: { key: 'set_e_range', field: k, lo, hi } };
    if (v !== cur[k]) { next[k] = v; changed.push(k); }
  }
  if (patch.autonomy !== undefined) {
    if (!LEVELS.includes(patch.autonomy)) return { error: { key: 'set_e_level' } };
    if (patch.autonomy !== cur.autonomy) { next.autonomy = patch.autonomy; changed.push('autonomy'); }
  }
  let cats = next.categories;
  if (Array.isArray(patch.categories)) cats = [...new Set(patch.categories.filter((c) => CATEGORIES.includes(c)))];
  for (const c of patch.categories_on || []) if (CATEGORIES.includes(c) && !cats.includes(c)) cats = [...cats, c];
  for (const c of patch.categories_off || []) cats = cats.filter((x) => x !== c);
  cats = CATEGORIES.filter((c) => cats.includes(c)); // canonical order
  if (cats.join() !== next.categories.join()) { next.categories = cats; changed.push('categories'); }
  // the two amounts that let Mandat act alone must fit inside the weekly budget
  if (next.auto_buy_under > next.weekly_budget) return { error: { key: 'set_e_auto_over_week', field: 'auto_buy_under' } };
  if (next.daily_cap > next.weekly_budget) return { error: { key: 'set_e_cap_over_week', field: 'daily_cap' } };
  if (next.autonomy === 'balanced' && next.auto_buy_under > next.daily_cap) return { error: { key: 'set_e_auto_over_cap', field: changed.includes('daily_cap') ? 'daily_cap' : 'auto_buy_under' } };
  if (patch.onboarded === true && !cur.onboarded) { next.onboarded = true; changed.push('onboarded'); }
  return { next, changed };
}

// May Mandat pay this plan on its own? -> { auto, reason, left? }
//  settings: the household's settings (null = legacy household without settings: the budget's own rule applies)
//  threshold: the paying budget's auto-approve amount (the weekly budget mirrors settings.auto_buy_under)
//  autoSpentToday: what Mandat already bought on its own today (counts toward the daily limit)
export function autonomyVerdict({ settings, threshold = 0, total, autoSpentToday = 0 }) {
  if (!settings) return threshold > 0 && total <= threshold ? { auto: true, reason: 'rule' } : { auto: false, reason: 'rule' };
  if (settings.paused) return { auto: false, reason: 'paused' };
  if (settings.autonomy === 'ask') return { auto: false, reason: 'ask' };
  const left = r2(Math.max(0, settings.daily_cap - autoSpentToday));
  if (total > left) return { auto: false, reason: 'daily_cap', left };
  if (settings.autonomy === 'hands_off') return { auto: true, reason: 'hands_off', left };
  return threshold > 0 && total <= threshold ? { auto: true, reason: 'under_rule', left } : { auto: false, reason: 'above_rule', left };
}

// Lines whose category is turned off.
export const blockedLines = (settings, lines = []) => (settings ? lines.filter((l) => !(settings.categories || CATEGORIES).includes(categoryOf(l))) : []);

// The next onboarding question not answered yet (null when done).
// (the auto-buy amount only matters in Balanced, the daily limit in Balanced and Hands-off)
export function nextStep(answered = [], settings = {}) {
  const skip = (s) => (s === 'auto_buy_under' && settings.autonomy && settings.autonomy !== 'balanced') || (s === 'daily_cap' && settings.autonomy === 'ask');
  return ONBOARDING_STEPS.find((s) => !answered.includes(s) && !skip(s)) || null;
}
