// Model provider interface for the merchant agents (the household's own assistant brain lives in src/brain and
// orchestrator/). Every provider implements:
//   merchantAgent({ merchant, when, ask, guests, thread })  -> { reply, quote: { total, day, slot, slotLabel, conditions } | null }
//   merchantChange({ merchant, order, change })             -> { accepted, reply, slotLabel?, guests?, total? }
// MANDAT_MODEL: "simulated" (default; tests, replay) | "bedrock" (AWS). Nebius / OpenAI-compatible providers were removed.
import { SimulatedProvider } from './simulated.mjs';
import { BedrockProvider } from './bedrock.mjs';
import { usTime } from '../core/merchants.mjs';

// Merchants keep 24-hour slots internally ("19:30"); whatever a merchant agent says reaches a US household as
// "7:30 PM" (Alexa+ en-US voice and cards), whichever provider produced it.
export function withUsTimes(p) {
  const fix = (r) => {
    if (!r) return r;
    if (typeof r.reply === 'string') r.reply = usTime(r.reply);
    if (typeof r.slotLabel === 'string') r.slotLabel = usTime(r.slotLabel);
    if (r.quote && typeof r.quote.slotLabel === 'string') r.quote.slotLabel = usTime(r.quote.slotLabel);
    return r;
  };
  return Object.assign(Object.create(p), {
    merchantAgent: async (args) => fix(await p.merchantAgent(args)),
    merchantChange: async (args) => fix(await p.merchantChange(args)),
  });
}

export function createProvider(kind = process.env.MANDAT_MODEL || 'simulated') {
  if (kind === 'simulated' || kind === 'replay') return withUsTimes(new SimulatedProvider());
  if (kind === 'bedrock') return withUsTimes(new BedrockProvider());
  throw new Error(`Unknown MANDAT_MODEL "${kind}" (simulated | bedrock)`);
}
