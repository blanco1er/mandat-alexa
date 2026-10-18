// Test harness: a real server on a random port, in-memory store, simulated model, simulated PayPal. No network
// beyond 127.0.0.1, no AWS, no paid API.
process.env.MANDAT_STORE = 'memory';
process.env.MANDAT_MODEL = 'simulated';
process.env.MANDAT_PAYPAL = 'offline';
process.env.MANDAT_SHOP = 'off';
process.env.MANDAT_TTS = 'browser';
delete process.env.MANDAT_DEMO_TOKEN;

const { start } = await import('../src/server.mjs');
const { connectMcp, SimulatedBrain } = await import('../src/brain/simulated.mjs');

export async function boot() {
  const srv = await start({ port: 0, storeKind: 'memory', modelKind: 'simulated', brainKind: 'simulated' });
  return { ...srv, mcpUrl: `${srv.url}/mcp` };
}
export async function client(mcpUrl, household = 'test-' + Math.random().toString(36).slice(2, 8)) {
  const { client } = await connectMcp(mcpUrl, { household, name: 'mandat-tests' });
  client.household = household;
  return client;
}
export const sc = (r) => r.structuredContent || {};
export const text = (r) => r.content?.[0]?.text || '';
export function rpc(url, body, headers = {}) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
}
// A brain that keeps the session between turns, like the simulator page does.
export function talker(mcpUrl, household, device = 'show', locale) {
  const brain = new SimulatedBrain({ mcpUrl });
  let session = { device };
  return async (t) => {
    const out = await brain.runTurn({ text: t, session: { ...session, device }, household, locale });
    session = out.session;
    return out;
  };
}
// Book the in-laws plan: returns the client and the ids along the way.
export async function inLawsPlan(c) {
  const m = await c.callTool({ name: 'set_spending_mandate', arguments: { budget: 400, period: 'once', purpose: 'In-laws visit', auto_approve_under: 0 } });
  const clean = await c.callTool({ name: 'find_home_services', arguments: { need: 'deep clean of the guest room', category: 'cleaning', when: 'Friday morning' } });
  const bed = await c.callTool({ name: 'find_products', arguments: { query: 'queen bedding sheets for the guest room' } });
  const food = await c.callTool({ name: 'find_home_services', arguments: { need: 'dinner for six at home', category: 'catering', when: 'Saturday evening' } });
  const plan = await c.callTool({ name: 'propose_plan', arguments: { item_ids: [sc(clean).offers[0].id, sc(bed).offers[0].id, sc(food).offers[0].id], mandate_id: sc(m).mandate.id } });
  return { m, clean, bed, food, plan };
}
