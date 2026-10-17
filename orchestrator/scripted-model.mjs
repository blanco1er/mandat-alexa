// ScriptedModel: a Strands `Model` that needs no AWS. It replays the deterministic Mandat policy
// (../src/brain/policy.mjs) as model output (tool uses, then text), so the full Strands agent loop
// (Agent -> McpClient over Streamable HTTP -> Mandat MCP server, plus the AgentSkills plugin) runs locally and in tests.
// Simulation shortcut, stated plainly: Strands only gives a model the tool results' `content`; the policy needs the
// structured data, so it reads the raw MCP results recorded by RecordingMcpClient for the same calls, in order.
import { Model } from '@strands-agents/sdk';
import { decide } from '../src/brain/policy.mjs';

export class ScriptedModel extends Model {
  constructor({ trace, session = {} } = {}) {
    super();
    this.config = { modelId: 'mandat-scripted-policy' };
    this.trace = trace; // shared with RecordingMcpClient: [{ name, args, result }]
    this.session = session;
    this.turnStart = 0;
    this.utterance = '';
    this.n = 0;
  }
  updateConfig(c) { this.config = { ...this.config, ...c }; }
  getConfig() { return this.config; }
  beginTurn(utterance, session) { this.utterance = utterance; this.session = session; this.turnStart = this.trace.length; }
  async *stream(_messages, _options) {
    const steps = this.trace.slice(this.turnStart);
    const action = decide({ utterance: this.utterance, session: this.session, steps });
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (action.type === 'tool') {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: action.name, toolUseId: `tu_${++this.n}` } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(action.args) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    } else {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: action.text } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }
    yield { type: 'modelMetadataEvent', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }
}
