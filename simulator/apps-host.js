// MCP Apps host (spec 2026-01-26) for one inline view: a sandboxed iframe (allow-scripts only, opaque origin)
// talking JSON-RPC over postMessage. Handles ui/initialize, ui/notifications/initialized (then sends tool-input and
// tool-result), tools/call (forwarded to the MCP server), ui/update-model-context, ui/request-display-mode,
// ui/open-link, ui/message and ui/notifications/size-changed; sends ui/resource-teardown before replacing a view.
export class AppsHost {
  constructor({ container, mcp, hostContext, onLog = () => {}, onMessage = () => {}, onModelContext = () => {}, onDisplayMode = () => {}, onToolResult = () => {} }) {
    Object.assign(this, { container, mcp, hostContext, onLog, onMessage, onModelContext, onDisplayMode, onToolResult });
    this.frame = null;
    this.pending = null;
    this.reqId = 0;
    this.waiters = new Map();
    window.addEventListener('message', (e) => this.receive(e));
  }
  setContext(patch) {
    const same = Object.entries(patch).every(([k, v]) => JSON.stringify(this.hostContext[k]) === JSON.stringify(v));
    if (same) return; // only real changes reach the view (and the drawer)
    this.hostContext = { ...this.hostContext, ...patch };
    if (this.frame) this.send({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: patch });
  }
  send(msg) { this.frame?.contentWindow?.postMessage(msg, '*'); this.onLog('host→view', msg); }
  async teardown() {
    if (!this.frame) return;
    const id = 'td' + ++this.reqId;
    const done = new Promise((r) => { this.waiters.set(id, r); setTimeout(r, 300); });
    this.send({ jsonrpc: '2.0', id, method: 'ui/resource-teardown', params: { reason: 'replaced' } });
    await done;
    this.frame.remove();
    this.frame = null;
  }
  // Show a view for one tool call: html from resources/read, then tool-input + tool-result once it is initialized.
  async show({ html, toolName, args, result }) {
    await this.teardown();
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('title', `Mandat ${toolName} card`);
    f.className = 'app-frame';
    f.srcdoc = html;
    this.pending = { toolName, args, result };
    this.frame = f;
    this.container.replaceChildren(f);
    setTimeout(() => f.classList.add('in'), 900); // shown even if the view never initializes
  }
  async receive(e) {
    if (!this.frame || e.source !== this.frame.contentWindow) return;
    const m = e.data;
    if (!m || m.jsonrpc !== '2.0') return;
    this.onLog('view→host', m);
    if (m.id !== undefined && !m.method) { const w = this.waiters.get(m.id); if (w) { this.waiters.delete(m.id); w(m.result); } return; }
    const reply = (result) => this.send({ jsonrpc: '2.0', id: m.id, result });
    const fail = (message, code = -32603) => this.send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    switch (m.method) {
      case 'ui/initialize':
        return reply({
          protocolVersion: '2026-01-26',
          hostInfo: { name: 'alexa-plus-web-simulator', version: '0.1.0' },
          hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {}, logging: {} },
          hostContext: this.hostContext,
        });
      case 'ui/notifications/initialized':
        requestAnimationFrame(() => this.frame?.classList.add('in'));
        if (this.pending) {
          this.send({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: this.pending.args || {} } });
          this.send({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: this.pending.result });
        }
        return;
      case 'ui/notifications/size-changed':
        if (m.params?.height) this.frame.style.height = Math.min(Math.max(120, m.params.height), 2000) + 'px';
        return;
      case 'tools/call':
        try {
          const r = await this.mcp.callTool(m.params.name, m.params.arguments || {});
          this.onToolResult(m.params.name, m.params.arguments || {}, r);
          return reply(r);
        } catch (err) { return fail(err.message); }
      case 'resources/read':
        try { return reply(await this.mcp.readResource(m.params.uri)); } catch (err) { return fail(err.message); }
      case 'ui/update-model-context':
        this.onModelContext(m.params);
        return reply({});
      case 'ui/request-display-mode': {
        const mode = ['inline', 'fullscreen'].includes(m.params?.mode) ? m.params.mode : 'inline';
        this.onDisplayMode(mode);
        this.setContext({ displayMode: mode });
        return reply({ mode });
      }
      case 'ui/open-link':
        if (/^https?:\/\//.test(m.params?.url || '')) window.open(m.params.url, '_blank', 'noopener');
        return reply({});
      case 'ui/message': {
        const text = (m.params?.content || []).map((c) => c.text).join(' ');
        reply({});
        return this.onMessage(text);
      }
      case 'ping': return reply({});
      default:
        if (m.id !== undefined) return fail('Method not found', -32601);
    }
  }
}
