// The "Alexa+ brain" on Strands Agents (TypeScript SDK @strands-agents/sdk 1.21.0):
//   Agent({ model: BedrockModel(us.anthropic.claude-haiku-5-5), tools: [McpClient(Streamable HTTP -> /mcp)],
//           plugins: [AgentSkills(skill/mandat-household-errands)] })
// MANDAT_BRAIN_MODEL=scripted (default without AWS) swaps Bedrock for ScriptedModel: same agent, same MCP calls.
// Contract shared with src/brain/simulated.mjs:
//   runTurn({ text, session, household }) -> { speech, steps: [{ name, args, result }], session, protocolVersion }
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, BedrockModel, McpClient } from '@strands-agents/sdk';
import { AgentSkills } from '@strands-agents/sdk/vended-plugins/skills';
import { ScriptedModel } from './scripted-model.mjs';
import { absorb, absorbTokens } from '../src/brain/policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILLS_DIR = path.join(HERE, '..', 'skill');
export const BRAIN_MODEL = process.env.MANDAT_BRAIN_MODEL || 'scripted';
export const BEDROCK_BRAIN_ID = process.env.MANDAT_BEDROCK_BRAIN_ID || 'us.anthropic.claude-haiku-5-5';

export const SYSTEM_PROMPT = `You are Alexa+, a voice assistant in a family home, using the Mandat add-on for household errands.
Answer in one or two short spoken sentences. Follow the mandat-household-errands skill: activate it before the first Mandat tool call.
The device is given at the start of each user message as [device: show] or [device: dot].`;

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

export async function createStrandsBrain({ mcpUrl, model = BRAIN_MODEL, headers = {} }) {
  const agents = new Map(); // household -> { agent, trace, model }
  async function agentFor(household) {
    if (agents.has(household)) return agents.get(household);
    const trace = [];
    const mcp = new RecordingMcpClient({ url: mcpUrl, headers: { 'X-Mandat-Household': household, ...headers }, applicationName: 'mandat-alexa-brain' }, trace);
    const llm = model === 'bedrock'
      ? new BedrockModel({ modelId: BEDROCK_BRAIN_ID, region: process.env.AWS_REGION || 'us-east-1' })
      : new ScriptedModel({ trace });
    const skills = new AgentSkills({ skills: [path.join(SKILLS_DIR, 'mandat-household-errands')], strict: true });
    const agent = new Agent({ model: llm, tools: [mcp], plugins: [skills], systemPrompt: SYSTEM_PROMPT, printer: false });
    const entry = { agent, trace, llm, mcp, skills };
    agents.set(household, entry);
    return entry;
  }
  return {
    name: model === 'bedrock' ? `strands+bedrock(${BEDROCK_BRAIN_ID})` : 'strands+scripted',
    async runTurn({ text, session = {}, household = 'demo' }) {
      const e = await agentFor(household);
      const start = e.trace.length;
      if (e.llm instanceof ScriptedModel) e.llm.beginTurn(text, session);
      const result = await e.agent.invoke(`[device: ${session.device || 'show'}] ${text}`);
      const steps = e.trace.slice(start);
      let s = { ...session };
      for (const st of steps) s = absorbTokens(absorb(s, st.name, st.result), st.result);
      return { speech: String(result).trim(), steps, session: s, protocolVersion: '2025-11-25' };
    },
    async close() { for (const e of agents.values()) await e.mcp.disconnect().catch(() => {}); },
    agents,
  };
}
