// What the models cost, call by call, and a hard ceiling for the hosted demo: once the budget set for it is
// used, no model call leaves the server and people get a clear sentence instead of a broken agent.
// MANDAT_LLM_BUDGET_USD: the ceiling for the whole demo (0 or empty: no ceiling).
// MANDAT_LLM_PRICES: JSON {"model id": [USD per million input tokens, USD per million output tokens]} to override.
// The running total lives in memory (and in data/llm-spend.json when a data dir is writable). On Lambda a shared
// ledger (one DynamoDB counter, see setSharedLedger) makes the ceiling global across every warm container.
import fs from 'node:fs';
import path from 'node:path';

// Bedrock on-demand prices, USD per million tokens (input / output).
// Amazon Nova: read from the AWS Price List API (service AmazonBedrock, us-east-1) on 18 Oct 2026, e.g.
// USE1-Nova2.0Lite-input-tokens $0.00033/1K and -output-tokens $0.00275/1K (in-region and US geo profile).
// Claude (optional provider): Haiku 4.5 list price; the 5.5 generation is "not available for this account" on the
// new account we deployed to (18 Oct 2026), its prices are UNVERIFIED upper-bound guesses.
const DEFAULT_PRICES = {
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': [1.0, 5.0],
  'us.amazon.nova-2-lite-v1:0': [0.33, 2.75],
  'global.amazon.nova-2-lite-v1:0': [0.3, 2.5],
  'us.amazon.nova-pro-v1:0': [0.8, 3.2],
  'us.amazon.nova-lite-v1:0': [0.06, 0.24],
  'us.anthropic.claude-haiku-5-5': [1.0, 5.0],
  'us.anthropic.claude-sonnet-5-5': [3.0, 15.0],
  simulated: [0, 0],
};
let PRICES = DEFAULT_PRICES;
try { if (process.env.MANDAT_LLM_PRICES) PRICES = { ...DEFAULT_PRICES, ...JSON.parse(process.env.MANDAT_LLM_PRICES) }; } catch { console.warn('[spend] MANDAT_LLM_PRICES is not valid JSON: list prices used'); }
// An unknown model is counted at the highest known price: the ceiling is never reached late.
const WORST = Object.values(PRICES).reduce((w, p) => [Math.max(w[0], p[0]), Math.max(w[1], p[1])], [0, 0]);

export const budget = () => Math.max(0, Number(process.env.MANDAT_LLM_BUDGET_USD) || 0);
const FILE = () => path.join(path.resolve(process.env.MANDAT_DATA || 'data'), 'llm-spend.json');
let state = null;
function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { state = null; }
  if (!state || typeof state.usd !== 'number') state = { usd: 0, calls: 0, since: new Date().toISOString(), byModel: {} };
  return state;
}
function save() {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(state, null, 2));
  } catch { /* read-only disk (Lambda): memory only */ }
}

export const costOf = (model, inTok = 0, outTok = 0) => {
  const [pi, po] = PRICES[model] || WORST;
  return ((Number(inTok) || 0) * pi + (Number(outTok) || 0) * po) / 1e6;
};

// After each call: count what it cost. usage = { inputTokens, outputTokens } (Bedrock Converse names).
export function addUsage(model, usage) {
  if (!usage) return 0;
  const s = load();
  const inTok = usage.inputTokens ?? usage.prompt_tokens ?? 0;
  const outTok = usage.outputTokens ?? usage.completion_tokens ?? 0;
  const usd = costOf(model, inTok, outTok);
  const m = (s.byModel[model] ||= { calls: 0, in: 0, out: 0, usd: 0 });
  m.calls++; m.in += inTok; m.out += outTok; m.usd = round(m.usd + usd);
  s.calls++; s.usd = round(s.usd + usd);
  const cap = budget();
  if (cap && !s.warned && s.usd >= cap * 0.8) { s.warned = true; console.warn(`[spend] 80% of the model budget used: $${s.usd.toFixed(2)} of $${cap}`); }
  save();
  return usd;
}
const round = (v) => Math.round(v * 1e6) / 1e6;

// Shared ledger (Lambda): { total(): Promise<usd>, add(usd): Promise<void> }. Every container adds what it spent
// and reads the account-wide total (cached SHARED_TTL ms) before it calls a model.
let ledger = null, shared = { usd: 0, at: 0 };
const SHARED_TTL = 10_000;
export function setSharedLedger(l) { ledger = l; shared = { usd: 0, at: 0 }; }
async function sharedTotal() {
  if (!ledger) return 0;
  if (Date.now() - shared.at > SHARED_TTL) {
    try { shared = { usd: Number(await ledger.total()) || 0, at: Date.now() }; } catch (e) { console.warn('[spend] shared ledger unreadable:', e.name); }
  }
  return shared.usd;
}
// Records a call's usage locally and in the shared ledger. Returns the call's cost.
export async function recordUsage(model, usage) {
  const usd = addUsage(model, usage);
  if (ledger && usd > 0) {
    shared.usd += usd;
    try { await ledger.add(usd); } catch (e) { console.warn('[spend] shared ledger write failed:', e.name); }
  }
  return usd;
}

// Before each call: is there budget left? exhausted() = this process only; checkBudget() also reads the ledger.
export const exhausted = () => { const cap = budget(); return cap > 0 && load().usd >= cap; };
export async function checkBudget() {
  const cap = budget();
  if (!cap) return;
  if (exhausted() || Math.max(load().usd, await sharedTotal()) >= cap) throw budgetError();
}
// The view with the shared ledger read first (health endpoint).
export async function spendViewShared() { await sharedTotal(); return spendView(); }
export function spendView() {
  const s = load(), cap = budget();
  const used = Math.max(s.usd, shared.usd);
  return { usd: round(used), calls: s.calls, since: s.since, budget: cap || null, left: cap ? Math.max(0, round(cap - used)) : null, paused: cap > 0 && used >= cap, byModel: s.byModel };
}
export function budgetError() {
  return Object.assign(new Error('The AI budget set for this demo is used up, so Mandat cannot think right now. Your budget, orders and payments are all still here.'), { code: 'LLM_BUDGET', status: 503 });
}
// Tests only: start from a clean slate.
export function _reset() { state = { usd: 0, calls: 0, since: new Date().toISOString(), byModel: {} }; ledger = null; shared = { usd: 0, at: 0 }; }
