// Minimal MCP client for the browser: JSON-RPC 2.0 over Streamable HTTP (spec 2025-11-25), no build step.
// Sends initialize (with the MCP Apps UI extension), notifications/initialized, then any request. Accepts both
// application/json and text/event-stream responses, keeps Mcp-Session-Id when the server issues one, and sends
// MCP-Protocol-Version on every request after initialize. Every message is reported to `onLog` for the dev drawer.
export class McpHttpClient {
  constructor(url, { headers = {}, onLog = () => {} } = {}) {
    Object.assign(this, { url, headers, onLog });
    this.id = 0;
    this.sessionId = null;
    this.protocolVersion = null;
    this.serverInfo = null;
    this.capabilities = null;
  }
  async post(message) {
    if (this.before) await this.before(); // e.g. refresh the account link's access token first
    const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...this.headers };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) h['mcp-protocol-version'] = this.protocolVersion;
    this.onLog('out', message);
    const res = await fetch(this.url, { method: 'POST', headers: h, body: JSON.stringify(message) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 202) return null;
    // Account linking: a tool call without a valid token answers HTTP 401 + WWW-Authenticate (resource_metadata=…).
    if (res.status === 401 || res.status === 403) {
      const body = await res.json().catch(() => ({}));
      this.onLog('in', { http: res.status, 'www-authenticate': res.headers.get('www-authenticate'), body });
      throw Object.assign(new Error(body.message || `HTTP ${res.status}`), { status: res.status, wwwAuthenticate: res.headers.get('www-authenticate') || '' });
    }
    const type = res.headers.get('content-type') || '';
    let reply = null;
    if (type.includes('text/event-stream')) {
      const text = await res.text();
      for (const block of text.split('\n\n')) {
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data) continue;
        const msg = JSON.parse(data);
        this.onLog('in', msg);
        if (msg.id === message.id) reply = msg;
      }
    } else if (type.includes('application/json')) {
      reply = await res.json();
      this.onLog('in', reply);
    } else if (!res.ok) {
      const err = { jsonrpc: '2.0', id: message.id ?? null, error: { code: res.status, message: `HTTP ${res.status}` } };
      this.onLog('in', err);
      return err;
    }
    return reply;
  }
  async request(method, params = {}) {
    const reply = await this.post({ jsonrpc: '2.0', id: ++this.id, method, params });
    if (!reply) throw new Error(`${method}: no response`);
    if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
    return reply.result;
  }
  notify(method, params = {}) { return this.post({ jsonrpc: '2.0', method, params }); }
  async initialize(clientInfo = { name: 'alexa-plus-web-simulator', version: '0.1.0' }) {
    const r = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {
        elicitation: { form: {}, url: {} },
        extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } },
      },
      clientInfo,
    });
    this.protocolVersion = r.protocolVersion;
    this.serverInfo = r.serverInfo;
    this.capabilities = r.capabilities;
    await this.notify('notifications/initialized');
    return r;
  }
  listTools() { return this.request('tools/list'); }
  listResources() { return this.request('resources/list'); }
  readResource(uri) { return this.request('resources/read', { uri }); }
  callTool(name, args) { return this.request('tools/call', { name, arguments: args }); }
}
