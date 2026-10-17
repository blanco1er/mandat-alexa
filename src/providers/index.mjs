// Model provider interface for the merchant agents (the household's own assistant brain lives in src/brain and
// orchestrator/). Every provider implements:
//   merchantAgent({ merchant, when, ask, guests, thread })  -> { reply, quote: { total, day, slot, slotLabel, conditions } | null }
//   merchantChange({ merchant, order, change })             -> { accepted, reply, slotLabel?, guests?, total? }
// MANDAT_MODEL: "simulated" (default; tests, replay) | "bedrock" (AWS). Nebius / OpenAI-compatible providers were removed.
import { SimulatedProvider } from './simulated.mjs';
import { BedrockProvider } from './bedrock.mjs';

export function createProvider(kind = process.env.MANDAT_MODEL || 'simulated') {
  if (kind === 'simulated' || kind === 'replay') return new SimulatedProvider();
  if (kind === 'bedrock') return new BedrockProvider();
  throw new Error(`Unknown MANDAT_MODEL "${kind}" (simulated | bedrock)`);
}
