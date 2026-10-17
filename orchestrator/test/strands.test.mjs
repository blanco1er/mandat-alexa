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
