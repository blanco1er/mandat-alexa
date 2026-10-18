// Live activity feed: what Mandat is doing during one voice turn, step by step, as it really happens.
// The voice stays short; the screen shows the detail ("BrightNest Cleaning: $95 → $85", "Holding $85, not charged").
// Events are written to the household's store as they happen (tool started, each merchant agent's answer, each
// payment hold), keyed by the turn id the host sent (X-Mandat-Turn). The Alexa+ host reads them back while the turn
// runs (GET /activity), so the list fills in real time on any Lambda container. Nothing is invented on the screen:
// every line comes from a real tool call or a real merchant answer.
//
// Event: { step, state: running | done | failed | info, text, detail?, from?, to?, image_url?, tool?, at }
// A later event with the same `step` replaces the earlier one (running -> done).
import { pkOf } from '../store/index.mjs';
import { current, TURN_RE } from './context.mjs';

let seq = 0;
const KEEP_MS = 2 * 60 * 60 * 1000; // a turn's feed is only read while it runs; old rows are skipped on read

export async function note(store, ev) {
  const { household, turn } = current();
  if (!store || !household || !turn || !TURN_RE.test(turn)) return;
  const now = Date.now();
  const sk = `ACT#${turn}#${String(now).padStart(14, '0')}${(++seq % 1e6).toString(36).padStart(4, '0')}`;
  try { await store.put(pkOf(household), sk, { ...ev, at: new Date(now).toISOString() }); } catch { /* the feed never breaks a tool */ }
}

export async function readFeed(store, household, turn) {
  if (!TURN_RE.test(turn || '')) return [];
  const rows = (await store.query(pkOf(household), `ACT#${turn}#`)).map((r) => r.value);
  const fresh = rows.filter((e) => Date.now() - Date.parse(e.at) < KEEP_MS);
  // collapse by step: the latest state of each step, in the order the steps started
  const order = [];
  const last = new Map();
  for (const e of fresh) { if (!last.has(e.step)) order.push(e.step); last.set(e.step, e); }
  return order.map((s) => last.get(s));
}
