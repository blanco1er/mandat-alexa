// Alexa+ web simulator: voice in (Web Speech), the orchestrator decides (/turn), cards render as MCP Apps,
// voice out (Polly via /tts when the server has it, else the browser voice). The page is itself an MCP client:
// it sends initialize, tools/list, resources/list, resources/read and tools/call (status at boot, card buttons).
import { McpHttpClient } from './mcp-client.js';
import { AppsHost } from './apps-host.js';

const $ = (s) => document.querySelector(s);
const store = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const params = new URLSearchParams(location.search);
let household = params.get('household') || store.get('mandat.household', 'demo');
let session = store.get(`mandat.session.${household}`, {});
let device = store.get('mandat.device', 'show15');
const resourceCache = new Map();

const CHIPS = [
  'Set a weekly household budget of $150, and buy on your own under $40.',
  'Remember that Max, our dog, is allergic to chicken.',
  'Remember we drink Northbeam medium roast.',
  'Alexa, my in-laws land Saturday. Get the guest room ready: a cleaner Friday, fresh bedding, and dinner for six at home Saturday. Keep it under $400.',
  'Yes, book it.',
  "We're almost out of dog food and coffee.",
  'Their flight moved to Sunday.',
  'Everything went well. Settle up: Olive billed $180, and refund the $28 pillowcases.',
  'How much is left?',
];

// ---------- dev drawer ----------
const log = (kind, label, payload) => {
  const li = document.createElement('li');
  li.className = kind;
  const t = new Date().toLocaleTimeString([], { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0');
  const method = payload?.method || (payload?.result ? 'result' : payload?.error ? 'error' : '');
  li.innerHTML = `<details><summary><span class="dir">${label}</span> ${t} ${method}${payload?.params?.name ? ' · ' + payload.params.name : ''}</summary></details>`;
  li.querySelector('details').append(Object.assign(document.createElement('div'), { textContent: JSON.stringify(payload, null, 2).slice(0, 6000) }));
  $('#log').append(li);
  li.scrollIntoView({ block: 'end' });
};
const mcp = new McpHttpClient(new URL('/mcp', location.href).href, {
  headers: { 'x-mandat-household': household },
  onLog: (dir, msg) => log(dir === 'out' ? 'out' : 'in', dir === 'out' ? 'page → server' : 'server → page', msg),
});
const showSession = () => { $('#sessionInfo').textContent = `protocol ${mcp.protocolVersion || '…'} · MCP-Session-Id ${mcp.sessionId || 'none (stateless server)'} · household ${household}`; };

// ---------- MCP Apps host ----------
const theme = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const host = new AppsHost({
  container: $('#cardSlot'), mcp,
  hostContext: { theme: theme(), displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], locale: 'en-US', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, platform: 'web', userAgent: 'alexa-plus-web-simulator', deviceCapabilities: { touch: true, hover: false, deviceClass: device }, containerDimensions: { maxHeight: 800 } },
  onLog: (dir, msg) => log('view', dir, msg),
  onMessage: (text) => turn(text),
  onModelContext: (p) => { session = { ...session, modelContext: p.structuredContent || null }; },
  onDisplayMode: (mode) => document.body.classList.toggle('fullscreen', mode === 'fullscreen'),
  onToolResult: (name, args, result) => { absorbResult(name, result); updateGauge(result); },
});

async function render(name, args, result) {
  const uri = result?._meta?.ui?.resourceUri;
  if (!uri || result.isError || device === 'dot') return;
  if (!resourceCache.has(uri)) {
    const r = await mcp.readResource(uri);
    resourceCache.set(uri, r.contents[0].text);
  }
  document.body.classList.remove('fullscreen');
  await host.show({ html: resourceCache.get(uri), toolName: name, args, result });
}

// Close tokens and pending plans from card actions are kept like the orchestrator's own.
function absorbResult(name, result) {
  const orders = result?.structuredContent?.receipt?.orders || [];
  if (orders.length) session.closeTokens = { ...(session.closeTokens || {}), ...Object.fromEntries(orders.filter((o) => o.close_token).map((o) => [o.id, o.close_token])) };
  if (name === 'confirm_plan' && !result.isError) session.pending = null;
  store.set(`mandat.session.${household}`, session);
}

function updateGauge(result) {
  const d = result?.structuredContent || {};
  const env = d.receipt?.envelope || d.envelope || (d.envelopes || [])[0];
  if (!env) return;
  const pct = (x) => Math.max(0, Math.min(100, (x / env.budget) * 100)) + '%';
  $('#gauge').hidden = false;
  $('.gspent').style.width = pct(env.spent);
  $('.gheld').style.width = pct(env.held);
  const usd = (n) => '$' + (Math.round(n * 100) / 100).toLocaleString('en-US');
  $('#gaugeText').innerHTML = `<b>${usd(env.held + env.spent)}</b> of ${usd(env.budget)} committed · ${env.purpose} · ${usd(env.remaining)} left`;
}

// ---------- voice out ----------
let ttsServer = true;
async function speak(text) {
  setState('speaking');
  try {
    if (ttsServer) {
      const r = await fetch('/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      if (r.ok) { const a = new Audio(URL.createObjectURL(await r.blob())); await a.play(); await new Promise((res) => (a.onended = res)); return; }
      ttsServer = false; // 501: the browser speaks from now on
    }
    if ('speechSynthesis' in window) {
      await new Promise((res) => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'en-US'; u.rate = 1.03;
        const v = speechSynthesis.getVoices().find((x) => /en-US/.test(x.lang) && /Samantha|Google US English|Jenny|Aria/.test(x.name));
        if (v) u.voice = v;
        u.onend = res; u.onerror = res;
        speechSynthesis.cancel(); speechSynthesis.speak(u);
      });
    }
  } finally { setState('idle'); }
}

// ---------- voice in ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function listen() {
  if (!SR) { $('#typeInput').focus(); $('#micLabel').textContent = 'Voice input needs Chrome; type instead'; return; }
  if (rec) { rec.stop(); return; }
  rec = new SR();
  rec.lang = 'en-US'; rec.interimResults = true; rec.maxAlternatives = 1;
  let final = '';
  rec.onresult = (e) => { final = [...e.results].map((r) => r[0].transcript).join(' '); $('#caption').textContent = '“' + final + '”'; };
  rec.onend = () => { rec = null; setState('idle'); if (final.trim()) turn(final.trim()); };
  rec.onerror = () => { rec = null; setState('idle'); };
  setState('listening');
  rec.start();
}

// ---------- one turn ----------
function setState(s) { document.body.dataset.state = s; $('#micLabel').textContent = { idle: 'Tap and talk', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…' }[s]; }
let busy = false;
async function turn(text) {
  if (busy) return;
  busy = true;
  $('#caption').textContent = '“' + text + '”';
  $('#reply').textContent = '';
  $('#dotSub').textContent = '“' + text + '”';
  setState('thinking');
  try {
    log('orch', 'page → /turn', { text, device });
    const r = await fetch('/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, session, household, device: device === 'dot' ? 'dot' : 'show' }) });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || 'turn failed');
    for (const s of out.steps) log('orch', 'orchestrator tools/call', { method: 'tools/call', params: { name: s.name, arguments: s.args }, result: s.result });
    session = { ...out.session, modelContext: null };
    store.set(`mandat.session.${household}`, session);
    for (const s of out.steps) updateGauge(s.result);
    const shown = [...out.steps].reverse().find((s) => s.result?._meta?.ui?.resourceUri && !s.result.isError && s.name !== 'get_household_status') || [...out.steps].reverse().find((s) => s.result?._meta?.ui?.resourceUri && !s.result.isError);
    if (shown) await render(shown.name, shown.args, shown.result);
    $('#reply').textContent = out.speech;
    $('#dotSub').textContent = out.speech;
    busy = false;
    await speak(out.speech);
  } catch (e) {
    $('#reply').textContent = 'Sorry, something went wrong. ' + e.message;
    setState('idle');
  } finally { busy = false; }
}

// ---------- device, theme, boot ----------
function setDevice(d) {
  device = d; store.set('mandat.device', d);
  document.body.dataset.device = d;
  for (const b of document.querySelectorAll('[data-dev]')) b.setAttribute('aria-pressed', String(b.dataset.dev === d));
  host.setContext({ deviceCapabilities: { touch: d !== 'dot', hover: false, deviceClass: d } });
}
for (const b of document.querySelectorAll('[data-dev]')) b.onclick = () => setDevice(b.dataset.dev);
$('#theme').onclick = () => { const t = theme() === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; store.set('mandat.theme', t); host.setContext({ theme: t }); };
$('#devToggle').onclick = () => { $('#drawer').hidden = !$('#drawer').hidden; };
$('#clearLog').onclick = () => $('#log').replaceChildren();
$('#newHousehold').onclick = () => { household = 'h-' + Math.random().toString(36).slice(2, 8); store.set('mandat.household', household); location.search = '?household=' + household; };
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input')) return;
  if (e.key === 'd' || e.key === 'D') $('#devToggle').click();
  if (e.code === 'Space') { e.preventDefault(); listen(); }
});
$('#mic').onclick = listen;
$('#typeForm').onsubmit = (e) => { e.preventDefault(); const v = $('#typeInput').value.trim(); if (v) { $('#typeInput').value = ''; turn(v); } };
$('#chips').replaceChildren(...CHIPS.map((c) => Object.assign(document.createElement('button'), { textContent: c, onclick: () => turn(c) })));
const tick = () => { $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
tick(); setInterval(tick, 15000);
const savedTheme = store.get('mandat.theme', null); if (savedTheme) document.documentElement.dataset.theme = savedTheme;
setDevice(device);

(async () => {
  try {
    await mcp.initialize();
    showSession();
    const { tools } = await mcp.listTools();
    const { resources } = await mcp.listResources();
    log('orch', 'page', { method: 'ready', params: { tools: tools.map((t) => t.name), resources: resources.map((r) => r.uri) } });
    // The page's own tools/call: the envelope gauge at boot.
    const status = await mcp.callTool('get_household_status', { section: 'budget' });
    updateGauge(status);
  } catch (e) {
    $('#reply').textContent = 'Cannot reach the Mandat MCP server: ' + e.message;
  }
})();
