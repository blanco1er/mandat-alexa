// Simulated orchestrator ("Alexa+ brain" without a model): a real MCP client (SDK 1.32.1, Streamable HTTP) that
// runs the tool loop with the deterministic policy. Same contract as the Strands/Bedrock orchestrator:
//   runTurn({ text, session }) -> { speech, steps: [{ name, args, result }], session, protocolVersion }
// The session (pending plan, close tokens, device) travels with the request: the server stays stateless.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { absorb, absorbTokens, decide } from './policy.mjs';
import { tr } from '../core/i18n.mjs';

export const UI_CLIENT_CAPABILITIES = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };

export async function connectMcp(url, { household = 'demo', name = 'mandat-alexa-brain', headers = {} } = {}) {
  const client = new Client({ name, version: '0.1.0' }, { capabilities: UI_CLIENT_CAPABILITIES });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { 'X-Mandat-Household': household, ...headers } } });
  await client.connect(transport);
  return { client, transport };
}

export class SimulatedBrain {
  constructor({ mcpUrl, headers = {} }) { this.mcpUrl = mcpUrl; this.headers = headers; this.name = 'simulated'; }
  async runTurn({ text, session = {}, household = 'demo', maxSteps = 12, turn, locale, authorization }) {
    // The turn id ties every tool call of this utterance to the live activity feed; the locale shapes the speech;
    // the household's access token (account linking) goes with every call.
    const extra = { ...(turn ? { 'X-Mandat-Turn': turn } : {}), ...(locale ? { 'X-Mandat-Locale': locale } : {}), ...(authorization ? { Authorization: authorization } : {}) };
    const { client, transport } = await connectMcp(this.mcpUrl, { household, headers: { ...this.headers, ...extra } });
    const steps = [];
    let s = { ...session };
    try {
      for (let i = 0; i < maxSteps; i++) {
        // the turn's intent is read with the session as it was when the user spoke
        const action = decide({ utterance: text, session: { ...session, closeTokens: s.closeTokens }, steps, locale });
        if (action.type === 'say') return { speech: action.text, steps, session: s, protocolVersion: transport.protocolVersion };
        const result = await client.callTool({ name: action.name, arguments: action.args });
        steps.push({ name: action.name, args: action.args, result });
        s = absorbTokens(absorb(s, action.name, result), result);
      }
      return { speech: tr(locale, 'p_too_many'), steps, session: s, protocolVersion: transport.protocolVersion };
    } finally {
      await client.close().catch(() => {});
    }
  }
}
