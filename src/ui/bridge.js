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
    if (m.method === 'ui/notifications/host-context-changed') { hostContext = { ...hostContext, ...m.params }; applyContext(); (handlers.context || (() => {}))(hostContext); autoFit(); return; }
    const short = { 'ui/notifications/tool-input': 'input', 'ui/notifications/tool-input-partial': 'partial', 'ui/notifications/tool-result': 'result', 'ui/notifications/tool-cancelled': 'cancelled' }[m.method];
    if (short && handlers[short]) { handlers[short](m.params); if (short === 'result') autoFit(); }
    else if (m.id !== undefined) post({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
  });

  function applyContext() {
    const root = document.documentElement;
    if (hostContext.theme) root.dataset.theme = hostContext.theme;
    if (hostContext.locale) root.lang = hostContext.locale;
    const vars = hostContext.styles && hostContext.styles.variables;
    if (vars) for (const [k, v] of Object.entries(vars)) if (v) root.style.setProperty(k, v);
    const dm = hostContext.displayMode || 'inline';
    root.dataset.display = dm;
    const p = hostContext.platform || '';
    root.dataset.device = (hostContext.deviceCapabilities && hostContext.deviceCapabilities.deviceClass) || (p === 'mobile' ? 'phone' : 'show');
  }

  // Glanceable means no scrolling: when the host gives a maxHeight (hostContext.containerDimensions) and the card is
  // taller, the whole type scale shrinks a little (--k), down to 72%, in inline and fullscreen alike.
  function autoFit() {
    const root = document.documentElement;
    const max = hostContext.containerDimensions && hostContext.containerDimensions.maxHeight;
    root.style.setProperty('--k', '1');
    if (!max) return;
    // measure the card itself: the iframe viewport may still be taller than the content
    const h = () => { const c = document.querySelector('main'); return c ? c.getBoundingClientRect().height : root.scrollHeight; };
    let k = 1;
    while (h() > max + 1 && k > 0.73) { k = Math.round((k - 0.03) * 100) / 100; root.style.setProperty('--k', String(k)); }
  }
  window.mcpAutoFit = autoFit;

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
      // the loading words were written before the host said which language: say them again in it
      if (window.__loading && document.querySelector('main.card.loading')) showLoading(window.__loading);
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
// Language: hostContext.locale (en-US default). Card strings and catalogue names come from I18N (inlined at build).
const LOC = () => (window.mcpApp && window.mcpApp.hostContext && window.mcpApp.hostContext.locale) || 'en-US';
const LANG = () => { const l = String(LOC()).slice(0, 2).toLowerCase(); return I18N.cards[l] ? l : 'en'; };
function tx(s, v = {}) { const tpl = (LANG() !== 'en' && I18N.cards[LANG()][s]) || s; return tpl.replace(/\{(\w+)\}/g, (_, k) => (v[k] ?? '')); }
const P = (x) => (x != null && LANG() !== 'en' && I18N.phrases[LANG()][x]) || x;
const usd = (n, cur = 'USD') => new Intl.NumberFormat(LOC(), { style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol', minimumFractionDigits: Number.isInteger(Math.round(n * 100) / 100) ? 0 : 2, maximumFractionDigits: 2 }).format(n || 0).replace(/\u202f|\u00a0/g, ' ');
const DAYS = { en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], fr: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'], es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'] };
// "Friday 10 AM" -> "vendredi 10 h" / "viernes 10:00"; "Delivery in 2 days" -> its translation
function slotL(label) {
  const l = LANG();
  if (l === 'en' || !label) return label || '';
  const x = /^(\w+day)\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(String(label).trim());
  if (!x) return P(label);
  const h = (Number(x[2]) % 12) + (x[4].toUpperCase() === 'PM' ? 12 : 0), m = Number(x[3] || 0);
  const d = DAYS[l][DAYS.en.findIndex((n) => n.toLowerCase() === x[1].toLowerCase())] || x[1];
  return `${d} ${l === 'fr' ? `${h} h${m ? ' ' + String(m).padStart(2, '0') : ''}` : `${h}:${String(m).padStart(2, '0')}`}`;
}
const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const ICONS = {
  cleaning: '<path d="M14 3 9 13M7 13h6l3 8H4l3-8Z"/><path d="M18 4v3M16.5 5.5h3"/>',
  catering: '<path d="M4 16h16M5 16a7 7 0 0 1 14 0M12 7V5.5M10.5 5.5h3M3 19h18"/>',
  plumbing: '<path d="M4 10h8a3 3 0 0 1 3 3v2h3v-5h2v9h-2v-2h-5v-2a1 1 0 0 0-1-1H4Z"/><path d="M8 10V6M6 6h4"/>',
  handyman: '<path d="M14.5 6.5a4 4 0 0 0 4.9 4.9L21 13l-8 8-3-3 8-8-1.6-1.6a4 4 0 0 0-4.9-4.9l2.5 2.5-1.4 1.4Z"/><path d="M3 21l6-6"/>',
  product: '<path d="M4 8 12 4l8 4v8l-8 4-8-4Z"/><path d="M4 8l8 4 8-4M12 12v8"/>',
  memory: '<path d="M12 21s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.6-7 10-7 10Z"/>',
  check: '<path d="M5 12.5 10 17 19 7"/>',
};
const icon = (k) => `<span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS[k] || ICONS.product}</svg></span>`;
const kindIcon = (o) => icon(o.kind === 'product' ? 'product' : o.category || guessCategory(o));
const status = (tone, text) => `<span class="status ${tone}">${esc(text)}</span>`;
// Item photo (served from Mandat's own origin, the only domain in the card's CSP), else the category icon.
// The box has a fixed size, so the card never jumps when the photo arrives; a photo that fails keeps a quiet tile.
const thumb = (o, cls = '') => o && o.image_url
  ? `<span class="thumb ${cls}"><img src="${esc(o.image_url)}" alt="${esc(o.image_alt || o.title || o.label || '')}" loading="lazy" decoding="async"></span>`
  : kindIcon(o);
document.addEventListener('error', (e) => { if (e.target && e.target.tagName === 'IMG') e.target.closest('.thumb, .ph')?.classList.add('broken'); }, true);
function guessCategory(o) {
  const t = `${o.merchant || ''} ${o.title || o.label || ''}`.toLowerCase();
  if (/clean|maid|tidy|nest/.test(t)) return 'cleaning';
  if (/cater|dinner|kitchen|table|chef|olive/.test(t)) return 'catering';
  if (/plumb|leak|pipe/.test(t)) return 'plumbing';
  if (/handy|fix|mount/.test(t)) return 'handyman';
  return 'product';
}
// Budget gauge: spent, held, and (optional) what this plan would add. `grow` starts the new segment at zero so it
// springs to its real width once painted (a state change made visible, not decoration).
function gauge(env, { adding = 0, after = null, grow = false } = {}) {
  if (!env || !env.budget) return '';
  const pct = (x) => Math.max(0, Math.min(100, (x / env.budget) * 100));
  const left = after ?? env.remaining;
  const per = env.period && env.period !== 'once' ? tx(env.period === 'monthly' ? ' this month' : ' this week') : '';
  return `<div class="gauge" role="img" aria-label="${esc(tx('{left} left of {budget}', { left: usd(left), budget: usd(env.budget) }))}${after !== null ? esc(tx(' after this')) : ''}">
    <div class="bar"><span class="spent" style="width:${pct(env.spent)}%"></span><span class="held" style="width:${pct(env.held)}%"></span>${adding ? `<span class="next" data-w="${pct(adding)}" style="width:${grow ? 0 : pct(adding)}%"></span>` : ''}</div>
    <div class="gauge-text"><span>${tx(after !== null ? '{amt} left after this' : '{amt} left', { amt: `<b>${usd(left)}</b>` })}</span><span>${esc(env.purpose || '')} · ${usd(env.budget)}${per}</span></div>
  </div>`;
}
function growGauges() {
  requestAnimationFrame(() => requestAnimationFrame(() => { for (const s of document.querySelectorAll('.bar .next[data-w]')) s.style.width = s.dataset.w + '%'; }));
}
// Loading: the card's real shape, plus words that say what is happening.
function skeleton(words) {
  return `<div class="head"><p class="context">${esc(words)}</p></div>
    <div class="hero"><span class="sk sk-title"></span><span class="sk sk-num"></span></div>
    <div class="stack"><span class="sk sk-row"></span><span class="sk sk-row short"></span><span class="sk sk-row"></span></div>`;
}
function showLoading(words) { window.__loading = words; words = tx(words); const a = document.querySelector('main.card'); if (a) { a.classList.add('loading'); a.setAttribute('aria-busy', 'true'); a.innerHTML = skeleton(words); } }
// Error: the cause as the title, then the one next step the server gave (Alexa+ guide: errors offer one action).
function showError(result) {
  const text = (result.content || []).map((c) => c.text).join(' ');
  const [cause, next] = text.split(/\s*Next step:\s*/);
  const a = document.querySelector('main.card');
  a.classList.remove('loading'); a.removeAttribute('aria-busy');
  a.innerHTML = `<div class="head"><p class="context">${esc(tx('Mandat needs a change'))}</p>${status('wait', tx('Not done'))}</div>
    <h1>${esc(cause)}</h1>${next ? `<p class="lead">${esc(next)}</p>` : ''}`;
}
function ready() { const a = document.querySelector('main.card'); if (a) { a.classList.remove('loading'); a.removeAttribute('aria-busy'); } }
