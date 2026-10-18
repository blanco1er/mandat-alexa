// The "Alexa+ brain" on Strands Agents (TypeScript SDK @strands-agents/sdk 1.21.0):
//   Agent({ model: BedrockModel(us.amazon.nova-2-lite-v1:0), tools: [McpClient(Streamable HTTP -> /mcp)],
//           plugins: [AgentSkills(skill/mandat-household-errands)] })
// MANDAT_BRAIN_MODEL=scripted (default without AWS) swaps Bedrock for ScriptedModel: same agent, same MCP calls.
// Contract shared with src/brain/simulated.mjs:
//   runTurn({ text, session, household }) -> { speech, steps: [{ name, args, result }], session, protocolVersion }
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, BedrockModel, BeforeToolCallEvent, DefaultModelRetryStrategy, McpClient, ModelRouter, RoutingCandidate, SlidingWindowConversationManager } from '@strands-agents/sdk';
import { AgentSkills, Skill } from '@strands-agents/sdk/vended-plugins/skills';
import { ScriptedModel } from './scripted-model.mjs';
import { absorb, absorbTokens } from '../src/brain/policy.mjs';
import { checkBudget, recordUsage } from '../src/core/spend.mjs';
import { normLocale, tr } from '../src/core/i18n.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILLS_DIR = path.join(HERE, '..', 'skill');
export const BRAIN_MODEL = process.env.MANDAT_BRAIN_MODEL || 'scripted';
// Amazon Nova 2 Lite: first-party, fast, native parallel tool use; 33/33 demo turns on 3 runs (18 Oct 2026).
// Claude on Bedrock is optional (MANDAT_BEDROCK_BRAIN_ID=us.anthropic.claude-haiku-4-5-20251001-v1:0 or a newer id
// the account has access to).
export const BEDROCK_BRAIN_ID = process.env.MANDAT_BEDROCK_BRAIN_ID || 'us.amazon.nova-2-lite-v1:0';
// A new account gets 20 requests per minute per inference profile for Nova 2 Lite (US geo and global are separate
// pools, see FRICTION.md): the Strands ModelRouter falls back to the global profile when the US one is throttled.
// Empty string = no fallback.
export const BEDROCK_BRAIN_FALLBACK_ID = process.env.MANDAT_BRAIN_FALLBACK_ID ?? 'global.amazon.nova-2-lite-v1:0';

// Strands 1.21 retries only ModelThrottledError, which BedrockModel raises for throttling *inside* a stream. A
// ThrottlingException on the request itself (HTTP 429, "Too many requests") arrives as a plain ModelError and was
// never retried: retry it too, with backoff.
export const isThrottle = (e) => /throttl|too many requests|rate exceeded|serviceunavailable/i.test(`${e?.name} ${e?.message} ${e?.cause?.name} ${e?.cause?.message}`);
class ThrottleAwareRetry extends DefaultModelRetryStrategy {
  isRetryable(error) { return super.isRetryable(error) || isThrottle(error); }
}

// Host guardrails (money): a model may never put words in the user's mouth or move a budget on its own.
//  - confirm_plan: user_confirmation is overwritten with the user's exact words of this turn, so the server's
//    "explicit yes" check (src/mandat.mjs isExplicitYes) judges what the person really said, not what the model wrote.
//  - set_spending_mandate: refused unless the user said an amount in this turn.
export const STATES_AMOUNT = /\$\s?\d|\d\s?\$|\b\d+\s*(dollars?|bucks|usd|dólares)(?![\p{L}])/iu; // "$150", "150 $", "150 dollars", "150 dólares"
export function guardToolCall(name, input, utterance) {
  if (name === 'confirm_plan') return { input: { ...input, user_confirmation: String(utterance).slice(0, 120) } };
  if (name === 'set_spending_mandate' && !STATES_AMOUNT.test(utterance)) {
    return { cancel: 'Refused by the host: the user did not state a budget amount in this request. Never create or change a budget on your own; tell the user and ask.' };
  }
  return { input };
}

function bedrockBrain() {
  // MANDAT_BRAIN_REASONING=low|medium turns on Nova 2 extended reasoning (more tokens, steadier multi-step plans).
  const effort = process.env.MANDAT_BRAIN_REASONING;
  const opts = /^(low|medium|high)$/.test(effort || '')
    ? { region: process.env.AWS_REGION || 'us-east-1', maxTokens: 4000, additionalRequestFields: { reasoningConfig: { type: 'enabled', maxReasoningEffort: effort } } }
    : { region: process.env.AWS_REGION || 'us-east-1', temperature: 0, maxTokens: 1200 };
  const primary = new BedrockModel({ modelId: BEDROCK_BRAIN_ID, ...opts });
  if (!BEDROCK_BRAIN_FALLBACK_ID || BEDROCK_BRAIN_FALLBACK_ID === BEDROCK_BRAIN_ID) return { model: primary, plugins: [] };
  const router = new ModelRouter([
    new RoutingCandidate({ model: primary, name: 'primary' }),
    new RoutingCandidate({ model: new BedrockModel({ modelId: BEDROCK_BRAIN_FALLBACK_ID, ...opts }), name: 'fallback' }),
  ]);
  return { model: router, plugins: [] };
}
// Hard caps per user turn: model calls in the loop, and tokens (input + output, all calls).
export const TURN_LIMITS = { turns: 12, totalTokens: 250_000 };
const MAX_AGENTS = 200; // households kept warm in one process (oldest dropped first)

export const SYSTEM_PROMPT = `You are Alexa+, a voice assistant in a family home, using the Mandat add-on for household errands.
Follow the mandat-household-errands skill: activate it before the first Mandat tool call.
Each user message starts with a context line in square brackets: the device ([device: show] or [device: dot]) and,
when a plan is waiting for the user's yes, its plan_id and confirmation_token. Never read the context line aloud.
Your final answer is spoken aloud by a speaker: plain sentences only, no markdown, no lists, no ids, no tokens,
no thinking out loud. Two or three short sentences, ending with at most one question.
Build the answer from the first text block of each tool result (it is written to be spoken): keep the merchant
names, prices, negotiated savings and what is left of the budget exactly as given. After several searches, say how
many merchants you asked.
Never say something is booked, ordered or paid unless confirm_plan or close_order succeeded in this turn; a proposed
plan is only proposed ("X can do Sunday for $210. Want me to book them?").
If a tool returns an error, do not retry it with similar arguments: tell the user what happened and offer the one
next step the error gives.
Language: the context line gives the user's locale (for example [locale: fr-FR]). Always answer in that language,
naturally, as a native speaker would (French: "372 $", "samedi à 19 h 30"; Spanish: "372 $", "el sábado a las 19:30").
Tool results may already be in that language; keep their numbers, prices and names exactly. Prices are US dollars
whatever the language: never convert or rename the currency (Spanish and French write "85 $", never euros). Speak in
sentences, never a numbered or bulleted list. Keep tool arguments
need, when and query in English (weekday names in English, e.g. "Saturday evening"); give fact and purpose in the
user's words. A yes in the user's language ("oui", "sí") is a yes; pass their exact words in user_confirmation.`;

// The context line given to the model with each utterance. The session travels with the request (stateless
// server), so a "yes" works even when this turn lands on another Lambda container than the proposal.
export function contextLine(session = {}) {
  const parts = [`device: ${session.device === 'dot' ? 'dot' : 'show'}`, `locale: ${normLocale(session.locale)}`];
  if (session.pending?.plan_id) parts.push(`pending plan_id: ${session.pending.plan_id}, confirmation_token: ${session.pending.token}, total: $${session.pending.total}${session.pending.lines?.length ? `, lines (merchant: offer_id): ${session.pending.lines.map((l) => `${l.merchant}${l.kind === 'product' ? ` (${String(l.title).split(':')[0]})` : ''}: ${l.offer_id}`).join('; ')}` : ''}`);
  if (session.focus) parts.push(`last item shown: ${session.focus}`);
  const close = Object.entries(session.closeTokens || {});
  if (close.length) parts.push(`close tokens (order_id=close_token): ${close.slice(-12).map(([o, t]) => `${o}=${t}`).join(', ')}`);
  return `[${parts.join('; ')}]`;
}

// What the speaker says: the model's text without reasoning tags, markdown or leftover context brackets.
export function spoken(text) {
  // Host guards on what is said: the household's currency is USD (a model writing "85 €" is corrected to "85 $"),
  // and numbered lists ("1. BrightNest…") are read as plain sentences.
  return String(text || '')
    .replace(/(\d+(?:[.,]\d{1,2})?)\s?€/g, '$1 $').replace(/€\s?(\d+(?:[.,]\d{1,2})?)/g, '$1 $')
    .replace(/(^|[\s:])\d{1,2}\.\s+(?=\p{Lu})/gu, '$1')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<\/?(response|answer)>/gi, '')
    .replace(/\[device:[^\]]*\]/gi, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Records the raw MCP results (structuredContent + _meta.ui) that Strands does not hand to the model, so the
// simulator can render the cards.
class RecordingMcpClient extends McpClient {
  constructor(config, trace) { super(config); this.trace = trace; }
  async callTool(tool, args, options) {
    const result = await super.callTool(tool, args, options);
    this.trace.push({ name: tool.name, args, result });
    return result;
  }
}

// MCP Apps: a tool whose _meta.ui.visibility is ["app"] is for the cards only and MUST NOT reach the model.
// Strands 1.21 does not read _meta.ui.visibility, so the host filters it by name (see FRICTION.md).
export const APP_ONLY_TOOLS = ['refresh_card'];

// With Bedrock, the skill's instructions are pinned in the system prompt: on our runs Nova 2 Lite called the
// AgentSkills `skills` tool before acting in only 4 of 11 turns, and skipped the playbooks the rest of the time
// (see FRICTION.md). The AgentSkills plugin stays on the agent (skill listing + its reference files).
export function pinnedPrompt() {
  const [skill] = Skill.fromDirectory(SKILLS_DIR, { strict: true });
  return `${SYSTEM_PROMPT.replace('Follow the mandat-household-errands skill: activate it before the first Mandat tool call.', 'Follow the mandat-household-errands skill below (already active; the skills tool only adds its reference files).')}

<skill name="${skill.name}">
${skill.instructions}
</skill>`;
}

export async function createStrandsBrain({ mcpUrl, model = BRAIN_MODEL, headers = {} }) {
  const agents = new Map(); // household -> { agent, trace, model }
  async function agentFor(household) {
    if (agents.has(household)) { const e = agents.get(household); agents.delete(household); agents.set(household, e); return e; }
    if (agents.size >= MAX_AGENTS) { const [oldest, e] = agents.entries().next().value; agents.delete(oldest); e.mcp.disconnect().catch(() => {}); }
    const trace = [];
    // One headers object per household: the MCP transport re-reads it on every request, so the turn id and locale
    // set before each turn reach every tool call of that turn (live activity feed, spoken language).
    const hdrs = { 'X-Mandat-Household': household, ...headers };
    const mcp = new RecordingMcpClient({ url: mcpUrl, headers: hdrs, applicationName: 'mandat-alexa-brain', toolFilters: { rejected: APP_ONLY_TOOLS } }, trace);
    const llm = model === 'bedrock' ? bedrockBrain().model : new ScriptedModel({ trace });
    const skills = new AgentSkills({ skills: [path.join(SKILLS_DIR, 'mandat-household-errands')], strict: true });
    const agent = new Agent({
      model: llm, tools: [mcp], plugins: [skills], systemPrompt: model === 'bedrock' ? pinnedPrompt() : SYSTEM_PROMPT, printer: false,
      // The household's memory is the MCP server's store and the context line, not the chat: a short window keeps
      // every turn's input (and bill) flat on a warm Lambda container.
      ...(model === 'bedrock' ? { retryStrategy: new ThrottleAwareRetry({ maxAttempts: 4 }), conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }) } : {}),
    });
    const entry = { agent, trace, llm, mcp, skills, utterance: '', hdrs };
    agent.addHook(BeforeToolCallEvent, (ev) => {
      const g = guardToolCall(ev.toolUse.name, ev.toolUse.input || {}, entry.utterance);
      if (g.cancel) ev.cancel = g.cancel; else ev.toolUse.input = g.input;
    });
    agents.set(household, entry);
    return entry;
  }
  return {
    name: model === 'bedrock' ? `strands+bedrock(${BEDROCK_BRAIN_ID})` : 'strands+scripted',
    async runTurn({ text, session = {}, household = 'demo', turn, locale }) {
      const e = await agentFor(household);
      if (turn) e.hdrs['X-Mandat-Turn'] = turn; else delete e.hdrs['X-Mandat-Turn'];
      if (locale) e.hdrs['X-Mandat-Locale'] = locale; else delete e.hdrs['X-Mandat-Locale'];
      const start = e.trace.length;
      const scripted = e.llm instanceof ScriptedModel;  // e.llm is a BedrockModel or a ModelRouter otherwise
      e.utterance = text;
      if (scripted) e.llm.beginTurn(text, { ...session, locale });
      else await checkBudget(); // throws a clear sentence once the demo's model budget is used up
      const result = await e.agent.invoke(scripted ? `[device: ${session.device || 'show'}] ${text}` : `${contextLine({ ...session, locale })} ${text}`, scripted ? {} : { limits: TURN_LIMITS });
      const usage = result.metrics?.latestAgentInvocation?.usage;
      if (!scripted && usage) await recordUsage(BEDROCK_BRAIN_ID, usage);
      const steps = e.trace.slice(start);
      let s = { ...session };
      for (const st of steps) s = absorbTokens(absorb(s, st.name, st.result), st.result);
      let speech = spoken(String(result));
      if (result.stopReason === 'limitTurns' || result.stopReason === 'limitTotalTokens' || !speech) {
        // The loop hit its cap (or said nothing): be honest about what did and did not happen.
        const last = [...steps].reverse().find((x) => x.result?.content?.[0]?.text);
        const moved = steps.some((x) => ['confirm_plan', 'close_order', 'change_order'].includes(x.name) && !x.result?.isError);
        speech = last?.result?.isError
          ? `${last.result.content[0].text.replace(/ Next step:.*$/, '')} ${moved ? '' : tr(locale, 'b_nothing') + ' '}${tr(locale, 'b_next')}`.replace(/\s+/g, ' ').trim()
          : speech || (steps.length ? tr(locale, 'b_done') : tr(locale, 'b_repeat'));
      }
      // Alexa+ voice-only rule: on a screenless device a request for approval ends with the explicit prompt.
      const sayYes = tr(locale, 'p_say_yes');
      if (session.device === 'dot' && s.pending && !speech.trim().endsWith(sayYes) && !/say yes to confirm\.?$/i.test(speech)) speech = `${speech.replace(/\s*$/, '')} ${sayYes}`;
      return { speech, steps, session: s, protocolVersion: '2025-11-25', skills: e.skills.getActivatedSkills(e.agent), usage: usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : undefined, stopReason: result.stopReason };
    },
    async close() { for (const e of agents.values()) await e.mcp.disconnect().catch(() => {}); },
    agents,
  };
}
