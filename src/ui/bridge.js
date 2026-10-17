// MCP Apps view bridge (spec 2026-01-26, io.modelcontextprotocol/ui), dependency-free.
// View -> Host requests: ui/initialize, tools/call, ui/update-model-context, ui/request-display-mode, ui/open-link, ui/message
// View -> Host notifications: ui/notifications/initialized, ui/notifications/size-changed
// Host -> View: ui/notifications/tool-input, tool-input-partial, tool-result, tool-cancelled, host-context-changed,
//               ui/resource-teardown (request: answered with {})
(function () {
  const pending = new Map();
  const handlers = {};
  let nextId = 1;
  let hostContext = {};
  const post = (msg) => window.parent.postMessage(msg, '*');
  function request(method, params) {
    const id = nextId++;
    post({ jsonrpc: '2.0', id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => { if (pending.delete(id)) reject(new Error(method + ' timed out')); }, 30000);
    });
  }
  const notify = (method, params) => post({ jsonrpc: '2.0', method, params: params || {} });

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return; // only the host that embeds us
    const m = e.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id !== undefined && !m.method) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      return m.error ? p.reject(Object.assign(new Error(m.error.message), { code: m.error.code })) : p.resolve(m.result);
    }
    if (m.method === 'ui/resource-teardown') { (handlers.teardown || (() => {}))(m.params); return post({ jsonrpc: '2.0', id: m.id, result: {} }); }
    if (m.method === 'ui/notifications/host-context-changed') { hostContext = { ...hostContext, ...m.params }; applyContext(); (handlers.context || (() => {}))(hostContext); return; }
    const short = { 'ui/notifications/tool-input': 'input', 'ui/notifications/tool-input-partial': 'partial', 'ui/notifications/tool-result': 'result', 'ui/notifications/tool-cancelled': 'cancelled' }[m.method];
    if (short && handlers[short]) handlers[short](m.params);
    else if (m.id !== undefined) post({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
  });

  function applyContext() {
    const root = document.documentElement;
    if (hostContext.theme) root.dataset.theme = hostContext.theme;
    const vars = hostContext.styles && hostContext.styles.variables;
    if (vars) for (const [k, v] of Object.entries(vars)) if (v) root.style.setProperty(k, v);
    const dm = hostContext.displayMode || 'inline';
    root.dataset.display = dm;
    const p = hostContext.platform || '';
    root.dataset.device = (hostContext.deviceCapabilities && hostContext.deviceCapabilities.deviceClass) || (p === 'mobile' ? 'phone' : 'show');
  }

  // Tell the host our size whenever it changes (inline cards grow with their content).
  let last = '';
  const ro = new ResizeObserver(() => {
    const r = document.documentElement.getBoundingClientRect();
    const key = Math.ceil(r.width) + 'x' + Math.ceil(r.height);
    if (key !== last) { last = key; notify('ui/notifications/size-changed', { width: Math.ceil(r.width), height: Math.ceil(document.body.scrollHeight) }); }
  });

  window.mcpApp = {
    on(event, fn) { handlers[event] = fn; },
    get hostContext() { return hostContext; },
    async connect(name) {
      try {
        const r = await request('ui/initialize', {
          protocolVersion: '2026-01-26',
          clientInfo: { name, version: '1.0.0' },
          appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
        });
        hostContext = (r && r.hostContext) || {};
      } catch (e) { hostContext = {}; }
      applyContext();
      notify('ui/notifications/initialized', {});
      ro.observe(document.body);
      return hostContext;
    },
    callTool(name, args) { return request('tools/call', { name, arguments: args || {} }); },
    updateModelContext(content, structuredContent) { return request('ui/update-model-context', { content, structuredContent }); },
    requestDisplayMode(mode) { return request('ui/request-display-mode', { mode }); },
    openLink(url) { return request('ui/open-link', { url }); },
    say(text) { return request('ui/message', { role: 'user', content: [{ type: 'text', text }] }); },
  };
})();

// Small shared helpers for the cards.
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (n, cur = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: Number.isInteger(Math.round(n * 100) / 100) ? 0 : 2 }).format(n || 0);
function gauge(env) {
  if (!env) return '';
  const pct = (x) => Math.max(0, Math.min(100, (x / env.budget) * 100));
  return `<div class="gauge" role="img" aria-label="${esc(usd(env.remaining))} left of ${esc(usd(env.budget))}">
    <div class="bar"><span class="spent" style="width:${pct(env.spent)}%"></span><span class="held" style="width:${pct(env.held)}%"></span></div>
    <div class="gauge-text"><b>${usd(env.remaining)}</b> left of ${usd(env.budget)} · ${esc(env.purpose || '')}${env.held ? ` · ${usd(env.held)} on hold` : ''}</div>
  </div>`;
}
function showError(result) {
  const text = (result.content || []).map((c) => c.text).join(' ');
  document.body.innerHTML = `<main class="card"><p class="eyebrow">Mandat</p><h1>Not done</h1><p class="lead">${esc(text)}</p></main>`;
}
