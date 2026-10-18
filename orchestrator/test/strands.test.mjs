// The Strands agent loop, locally: Agent + McpClient (Streamable HTTP) + AgentSkills, with ScriptedModel instead
// of Bedrock. No AWS credentials are needed to import or run this.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.MANDAT_STORE = 'memory';
process.env.MANDAT_PAYPAL = 'offline';
process.env.MANDAT_MODEL = 'simulated';
const { start } = await import('../../src/server.mjs');
const { createStrandsBrain } = await import('../brain.mjs');
const { Skill } = await import('@strands-agents/sdk/vended-plugins/skills');

const srv = await start({ port: 0, storeKind: 'memory', modelKind: 'simulated', brainKind: 'none' });
const brain = await createStrandsBrain({ mcpUrl: `${srv.url}/mcp`, model: 'scripted' });
test.after(async () => { await brain.close(); await srv.close(); });

test('the Agent Skill passes the Strands strict validator (agentskills.io rules)', () => {
  const [skill] = Skill.fromDirectory(fileURLToPath(new URL('../../skill', import.meta.url)), { strict: true });
  assert.equal(skill.name, 'mandat-household-errands');
  assert.ok(skill.description.length <= 1024);
});

test('scenario 1 through Strands: Agent -> McpClient -> Mandat MCP server, then yes -> 3 holds', async () => {
  let session = { device: 'show' };
  const out = await brain.runTurn({ text: 'Alexa, my in-laws land Saturday. Get the guest room ready: a cleaner Friday, fresh bedding, and dinner for six at home Saturday. Keep it under $400.', session, household: 'strands' });
  assert.deepEqual(out.steps.map((s) => s.name), ['set_spending_mandate', 'find_home_services', 'find_products', 'find_home_services', 'propose_plan']);
  assert.match(out.speech, /Total \$372.*Should I book it\?/);
  assert.ok(out.steps.every((s) => s.result._meta?.ui?.resourceUri), 'raw MCP results kept for the cards');
  session = out.session;
  const yes = await brain.runTurn({ text: 'Yes, book it.', session, household: 'strands' });
  assert.deepEqual(yes.steps.map((s) => s.name), ['confirm_plan']);
  assert.equal(yes.steps[0].result.structuredContent.receipt.orders.length, 3);
  assert.match(yes.speech, /Booked\. 3 payment holds for \$372/);
});

test('the AgentSkills plugin is loaded on the agent and exposes the skill to the model', async () => {
  const e = brain.agents.get('strands');
  const names = (await e.skills.getAvailableSkills(e.agent)).map((s) => s.name);
  assert.deepEqual(names, ['mandat-household-errands']);
});

test('app-only tools (MCP Apps visibility ["app"]) never reach the model', async () => {
  const e = brain.agents.get('strands');
  const names = (await e.mcp.listTools()).map((t) => t.name);
  assert.ok(names.includes('confirm_plan'));
  assert.ok(!names.includes('refresh_card'), 'refresh_card is for the cards only');
});

// ---------- Bedrock (Amazon Nova) brain: host guardrails and helpers, no AWS call ----------
const { guardToolCall, contextLine, spoken, isThrottle, pinnedPrompt, BEDROCK_BRAIN_ID, BEDROCK_BRAIN_FALLBACK_ID } = await import('../brain.mjs');

test('Amazon Nova 2 Lite is the default brain, with the global profile as throttling fallback', () => {
  assert.equal(BEDROCK_BRAIN_ID, 'us.amazon.nova-2-lite-v1:0');
  assert.equal(BEDROCK_BRAIN_FALLBACK_ID, 'global.amazon.nova-2-lite-v1:0');
});

test('host guardrail: confirm_plan always carries the user\'s own words, never the model\'s', () => {
  const g = guardToolCall('confirm_plan', { plan_id: 'p', confirmation_token: 't', user_confirmation: 'Yes, buy it' }, "We're almost out of dog food and coffee.");
  assert.equal(g.input.user_confirmation, "We're almost out of dog food and coffee.", 'the server then refuses a plan that needs a yes');
  assert.equal(g.input.plan_id, 'p');
});

test('host guardrail: no budget is created or changed unless the user said an amount', () => {
  assert.ok(guardToolCall('set_spending_mandate', { budget: 200 }, 'Yes, go ahead.').cancel);
  assert.ok(!guardToolCall('set_spending_mandate', { budget: 400 }, 'Keep it under $400.').cancel);
  assert.ok(!guardToolCall('set_spending_mandate', { budget: 150 }, 'a weekly budget of 150 dollars').cancel);
  assert.ok(!guardToolCall('find_products', { query: 'coffee' }, 'coffee').cancel);
});

test('host guardrail: settings amounts only when said, only the user lifts an emergency stop, delete only when asked', () => {
  assert.ok(guardToolCall('update_settings', { weekly_budget: 500 }, 'Balanced please').cancel);
  assert.ok(!guardToolCall('update_settings', { weekly_budget: 200 }, 'Make it 200 a week').cancel);
  assert.ok(!guardToolCall('update_settings', { autonomy: 'ask' }, 'Ask me first from now on').cancel);
  assert.ok(guardToolCall('resume_spending', {}, 'OK thanks').cancel, 'a model never resumes on its own');
  assert.ok(!guardToolCall('resume_spending', {}, 'Réactive Mandat').cancel);
  assert.ok(guardToolCall('delete_my_data', { user_confirmation: 'yes' }, 'Yes').cancel);
  const d = guardToolCall('delete_my_data', { user_confirmation: 'Yes' }, 'Yes, delete it.');
  assert.equal(d.input.user_confirmation, 'Yes, delete it.');
  assert.ok(!guardToolCall('pause_spending', {}, 'stop everything').cancel, 'the emergency stop is never blocked');
  // seen live: Nova answered a repeated "Yes, book it" by capturing two held orders
  assert.ok(guardToolCall('close_order', { order_id: 'o', action: 'capture' }, 'Yes, book it.').cancel);
  assert.ok(!guardToolCall('close_order', { order_id: 'o', action: 'capture' }, 'Everything went well. Settle up: Olive billed $180, and refund the $28 pillowcases.').cancel);
  assert.ok(!guardToolCall('close_order', { order_id: 'o', action: 'refund' }, 'Tout s’est bien passé. On solde : Olive a facturé 180 $, et rembourse les 28 $ des taies d’oreiller.').cancel);
  assert.ok(!guardToolCall('close_order', { order_id: 'o', action: 'capture' }, 'Todo salió bien. Liquida: Olive cobró 180 dólares.').cancel);
  assert.ok(!guardToolCall('close_order', { order_id: 'o', action: 'cancel' }, 'Cancel the cleaner.').cancel);
});

test('context line: device, pending plan and close tokens travel with the request (stateless server)', () => {
  const l = contextLine({ device: 'dot', pending: { plan_id: 'plan_1', token: 'tok', total: 210 }, closeTokens: { ord_1: 'c1' } });
  assert.match(l, /^\[device: dot; locale: en-US; pending plan_id: plan_1, confirmation_token: tok, total: \$210; close tokens \(order_id=close_token\): ord_1=c1\]$/);
  assert.equal(contextLine({}), '[device: show; locale: en-US]');
  assert.match(contextLine({ locale: 'fr' }), /locale: fr-FR/);
});

test('spoken(): what the speaker says has no reasoning tags, markdown or context line', () => {
  assert.equal(spoken('<thinking>plan</thinking>**Booked.** [device: show]\n- $372 on hold'), 'Booked. $372 on hold');
});

test('throttling is recognised whether Bedrock raised it inside the stream or on the request', () => {
  assert.ok(isThrottle(Object.assign(new Error('Too many requests, please wait before trying again.'), { name: 'ModelError' })));
  assert.ok(isThrottle({ name: 'ModelError', message: 'x', cause: { name: 'ThrottlingException' } }));
  assert.ok(!isThrottle(new Error('ValidationException: bad input')));
});

test('with Bedrock, the skill instructions are pinned in the system prompt', () => {
  const p = pinnedPrompt();
  assert.match(p, /<skill name="mandat-household-errands">/);
  assert.match(p, /One product per plan/);
});

test('host guard: a budget needs an amount the user said, in English, French or Spanish', () => {
  for (const u of ['Keep it under $400.', 'Ne dépasse pas 400 $.', 'Un budget de 150 dollars', 'Que no pase de 400 dólares.']) assert.ok(!guardToolCall('set_spending_mandate', { budget: 400 }, u).cancel, u);
  for (const u of ['Augmente le budget.', 'Sube el presupuesto.', 'Raise the budget.']) assert.ok(guardToolCall('set_spending_mandate', { budget: 999 }, u).cancel, u);
  assert.equal(guardToolCall('confirm_plan', { user_confirmation: 'yes' }, 'Oui, réserve.').input.user_confirmation, 'Oui, réserve.');
});

test('spoken(): the currency stays USD and numbered lists are read as sentences', () => {
  assert.equal(spoken('He encontrado tres opciones: 1. BrightNest Cleaning - 85 € (antes 95 €) 2. TidyHive - 105 €'), 'He encontrado tres opciones: BrightNest Cleaning - 85 $ (antes 95 $) TidyHive - 105 $');
  assert.equal(spoken('Total 372 $, it leaves $28.'), 'Total 372 $, it leaves $28.');
});
