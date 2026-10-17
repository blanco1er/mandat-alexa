// Amazon Bedrock provider (stub, ready for the AWS account): the merchant agents run on a Bedrock model through the
// Converse API. Nothing is called until MANDAT_MODEL=bedrock AND the runtime has AWS credentials (the Lambda role).
// The client comes from @aws-sdk/client-bedrock-runtime, imported lazily (bundled in the Lambda Node.js runtime).
// Env (names only): MANDAT_MERCHANT_MODEL (default us.amazon.nova-2-lite-v1:0), AWS_REGION (default us-east-1),
// MANDAT_LLM_BUDGET_USD (hard ceiling, see core/spend.mjs).
// Every quote is still passed through guardQuote() by the caller: the model can never go below a merchant's floor.
import { addUsage, budgetError, exhausted } from '../core/spend.mjs';
import { DAY_NAMES } from '../core/merchants.mjs';

export const BEDROCK_MODELS = {
  merchant: process.env.MANDAT_MERCHANT_MODEL || 'us.amazon.nova-2-lite-v1:0',
  brain: process.env.MANDAT_BRAIN_MODEL || 'us.anthropic.claude-haiku-5-5',
  planner: process.env.MANDAT_PLANNER_MODEL || 'us.anthropic.claude-sonnet-5-5',
};

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
    inferenceConfig: { maxTokens, temperature: 0.3 },
  };
}

export class BedrockProvider {
  constructor() { this.name = 'bedrock'; this.model = BEDROCK_MODELS.merchant; this.client = null; }
  async send(input) {
    if (exhausted()) throw budgetError();
    if (!this.client) {
      let sdk;
      try { sdk = await import('@aws-sdk/client-bedrock-runtime'); } catch {
        throw new Error('MANDAT_MODEL=bedrock needs @aws-sdk/client-bedrock-runtime (bundled in the Lambda Node.js runtime).');
      }
      this.sdk = sdk;
      this.client = new sdk.BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
    }
    const out = await this.client.send(new this.sdk.ConverseCommand(input));
    addUsage(input.modelId, out.usage);
    const text = out.output?.message?.content?.map((c) => c.text || '').join('') || '';
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    try { return JSON.parse(json); } catch { return { reply: text.slice(0, 300), quote: null }; }
  }
  async merchantAgent({ merchant, when, ask, guests }) {
    const r = await this.send(converseInput({ modelId: this.model, system: merchantSystemPrompt(merchant), user: `Booking request: ${ask || 'best price'}. When: ${when || 'any time'}. Guests: ${guests || 'n/a'}.` }));
    if (r.quote) r.quote.slotLabel = `${DAY_NAMES[r.quote.day] || ''} ${r.quote.slot || ''}`.trim();
    return r;
  }
  async merchantChange({ merchant, order, change }) {
    const r = await this.send(converseInput({ modelId: this.model, system: merchantSystemPrompt(merchant) + '\nFor a change request answer {"accepted":true|false,"reply":"...","slotLabel":"<Day HH:MM>","guests":<n|null>,"total":<USD>}. Keep the agreed price on an accepted move.', user: `Confirmed booking: ${order.label}, ${order.slotLabel}, $${order.amount}. Change requested: ${change.field} -> ${change.value}.` }));
    return { accepted: !!r.accepted, reply: String(r.reply || ''), slotLabel: r.slotLabel, guests: r.guests, total: Number(r.total) || order.amount };
  }
}
