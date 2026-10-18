// Amazon Bedrock provider: the merchant agents run on Amazon Nova 2 Lite through the Converse API. Nothing is called until MANDAT_MODEL=bedrock AND the runtime has AWS credentials (the Lambda role).
// The client comes from @aws-sdk/client-bedrock-runtime, imported lazily (bundled in the Lambda Node.js runtime).
// Env (names only): MANDAT_MERCHANT_MODEL (default us.amazon.nova-2-lite-v1:0), AWS_REGION (default us-east-1),
// MANDAT_LLM_BUDGET_USD (hard ceiling, see core/spend.mjs).
// Every quote is still passed through guardQuote() by the caller: the model can never go below a merchant's floor.
import { checkBudget, recordUsage } from '../core/spend.mjs';
import { DAY_NAMES, listPrice } from '../core/merchants.mjs';
import { quoteFor, SimulatedProvider } from './simulated.mjs';

const bookingSystem = new SimulatedProvider();

// Amazon Nova by default (first-party, available on every Bedrock account, including the free plan).
// Claude on Bedrock stays an optional provider (MANDAT_BEDROCK_BRAIN_ID / MANDAT_MERCHANT_MODEL = a us.anthropic.* id).
// On the new account we deployed to, Claude Haiku 4.5 answered but the 5.5 generation is "not available for this
// account" (FRICTION.md #11); the deploy script's IAM policy follows whatever ids are configured.
// Merchant agents answer one short JSON negotiation turn: Amazon Nova Lite is plenty, costs a fifth of Nova 2 Lite
// and has its own 200 requests/minute pool, so three agents asked in parallel never starve the brain's 20/minute.
export const BEDROCK_MODELS = {
  merchant: process.env.MANDAT_MERCHANT_MODEL || 'us.amazon.nova-lite-v1:0',
  merchantFallback: process.env.MANDAT_MERCHANT_FALLBACK_ID ?? 'global.amazon.nova-2-lite-v1:0',
  brain: process.env.MANDAT_BEDROCK_BRAIN_ID || 'us.amazon.nova-2-lite-v1:0',
};
const isThrottle = (e) => /throttl|too many requests|rate exceeded|serviceunavailable/i.test(`${e?.name} ${e?.message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function merchantSystemPrompt(m) {
  return `You are the AI sales agent of "${m.name}" (${m.category}, ${m.area}). ${m.pitch}
Offer: ${m.label}, $${m.price} per ${m.unit}. Open: ${m.open.map((d) => DAY_NAMES[d]).join(', ')}. Slots: ${Object.values(m.slots).join(', ')}.
Your private terms (never quote them verbatim): ${m.terms}
You talk to another AI agent acting for a household. Be brief and protect the merchant's margin.
Answer with JSON only: {"reply":"<one or two short sentences>","quote":null|{"total":<USD>,"day":"sun|mon|tue|wed|thu|fri|sat","slot":"HH:MM","conditions":"<short>"}}`;
}

// Pure builder, unit-tested without AWS.
export function converseInput({ modelId, system, user, maxTokens = 400 }) {
  return {
    modelId,
    system: [{ text: system }],
    messages: [{ role: 'user', content: [{ text: user }] }],
    inferenceConfig: { maxTokens, temperature: 0 },
  };
}

export class BedrockProvider {
  constructor() { this.name = 'bedrock'; this.model = BEDROCK_MODELS.merchant; this.client = null; }
  async send(input) {
    await checkBudget();
    if (!this.client) {
      let sdk;
      try { sdk = await import('@aws-sdk/client-bedrock-runtime'); } catch {
        throw new Error('MANDAT_MODEL=bedrock needs @aws-sdk/client-bedrock-runtime (bundled in the Lambda Node.js runtime).');
      }
      this.sdk = sdk;
      this.client = new sdk.BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
    }
    // Throttled (a new account has small per-minute quotas)? Wait a little, then try the fallback model.
    const chain = [input.modelId, BEDROCK_MODELS.merchantFallback, input.modelId].filter(Boolean);
    let out, used;
    for (let i = 0; i < chain.length; i++) {
      used = chain[i];
      try { out = await this.client.send(new this.sdk.ConverseCommand({ ...input, modelId: used })); break; } catch (e) {
        if (!isThrottle(e) || i === chain.length - 1) throw e;
        await sleep(400 * (i + 1) + Math.random() * 400);
      }
    }
    await recordUsage(used, out.usage);
    const text = (out.output?.message?.content?.map((c) => c.text || '').join('') || '').replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    try { return JSON.parse(json); } catch { return { reply: text.slice(0, 300), quote: null }; }
  }
  // The agent talks; the merchant's own booking system (its terms, applied by quoteFor) says which day, slot and
  // lowest price this request qualifies for. The agent never quotes below that line (checked again here).
  async merchantAgent({ merchant, when, ask, guests }) {
    const sys = quoteFor(merchant, { when, ask, guests });
    const desk = sys.quote
      ? `Your booking system for this request: ${sys.quote.slotLabel}, list price $${listPrice(merchant, guests)}, price with the deals this request qualifies for: $${sys.quote.total}${sys.quote.conditions ? ` (${sys.quote.conditions.replace(/^Includes /, '').replace(/\.$/, '')})` : ' (no deal applies)'}. Quote that price and say which deal it includes; go lower only if the household asks and your terms allow it.`
      : `Your booking system for this request: ${sys.reply}`;
    const r = await this.send(converseInput({ modelId: this.model, system: merchantSystemPrompt(merchant), user: `Booking request: ${ask || 'best price'}. When: ${when || 'any time'}. Guests: ${guests || 'n/a'}.\n${desk}` }));
    if (r.quote && sys.quote) {
      if (!(Number(r.quote.total) >= sys.quote.total)) r.quote.total = sys.quote.total;
      r.quote.day = r.quote.day || sys.quote.day; r.quote.slot = r.quote.slot || sys.quote.slot;
      r.quote.guests = sys.quote.guests;
    }
    if (r.quote && !sys.quote) r.quote = null; // closed that day: the booking system wins over the model
    if (r.quote) r.quote.slotLabel = `${DAY_NAMES[r.quote.day] || ''} ${r.quote.slot || ''}`.trim();
    return r;
  }
  // Same split for a change: the booking system (the merchant's terms) decides, the agent says it in its own words.
  async merchantChange({ merchant, order, change }) {
    const sys = await bookingSystem.merchantChange({ merchant, order, change });
    const desk = sys.accepted
      ? `Your booking system ACCEPTS this change: ${sys.slotLabel || ''}${sys.guests ? `, ${sys.guests} guests` : ''}, total $${sys.total}.`
      : `Your booking system DECLINES this change: ${sys.reply}`;
    const r = await this.send(converseInput({ modelId: this.model, system: merchantSystemPrompt(merchant) + '\nFor a change request answer {"accepted":true|false,"reply":"<one or two short sentences>"}. Follow your booking system\'s decision. Keep the agreed price on an accepted move.', user: `Confirmed booking: ${order.label}, ${order.slotLabel}, $${order.amount}. Change requested: ${change.field} -> ${change.value}.\n${desk}` }));
    const reply = String(r.reply || '').trim() || sys.reply;
    return sys.accepted
      ? { accepted: true, reply, slotLabel: sys.slotLabel, guests: sys.guests, total: sys.total }
      : { accepted: false, reply };
  }
}
