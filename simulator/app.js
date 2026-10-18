// Alexa+ web simulator: voice in (Web Speech), the orchestrator decides (/turn), cards render as MCP Apps,
// voice out (Polly via /tts when the server has it, else the browser voice). The page is itself an MCP client:
// it sends initialize, tools/list, resources/list, resources/read and tools/call (status at boot, card buttons).
// Voice states shown on the device: idle, listening, thinking, speaking, confirming (waiting for an explicit yes).
import { McpHttpClient } from './mcp-client.js';
import { AppsHost } from './apps-host.js';

const $ = (s) => document.querySelector(s);
const store = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const params = new URLSearchParams(location.search);
let household = params.get('household') || store.get('mandat.household', 'demo');
let session = store.get(`mandat.session.${household}`, {});
let device = params.get('device') || store.get('mandat.device', 'show15');
if (!['show15', 'show8', 'dot'].includes(device)) device = 'show15';
const resourceCache = new Map();
const usd = (n) => '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(Math.round(n * 100) / 100) ? 0 : 2, maximumFractionDigits: 2 });

// ---------- the demo script (the three stories of the video) ----------
const SCRIPT = [
  { act: 'Earlier', title: 'Set up the household', lines: [
    'Set a weekly household budget of $150, and buy on your own under $40.',
    'Remember that Max, our dog, is allergic to chicken.',
    'Remember we drink Northbeam medium roast.'] },
  { act: 'Story 1', title: 'The in-laws are coming', lines: [
    'Alexa, my in-laws land Saturday. Get the guest room ready: a cleaner Friday, fresh bedding, and dinner for six at home Saturday. Keep it under $400.',
    'Yes, book it.'] },
  { act: 'Story 2', title: 'Four days later', lines: [
    "We're almost out of dog food and coffee.",
    'Yes.'] },
  { act: 'Story 3', title: 'Plans change', lines: [
    'Their flight moved to Sunday.',
    'Yes, go ahead.',
    'Everything went well. Settle up: Olive billed $180, and refund the $28 pillowcases.'] },
  { act: 'Anytime', title: '', lines: ['How much is left?', 'My kitchen sink is leaking, find a plumber for Monday morning.'] },
];
let played = new Set(store.get(`mandat.played.${household}`, []));
function renderScript() {
  const all = SCRIPT.flatMap((a) => a.lines);
  const next = all.find((l) => !played.has(l));
  let n = 0;
  $('#script').replaceChildren(...SCRIPT.map((a) => {
    const g = document.createElement('section');
    g.className = 'act';
    g.innerHTML = `<h3>${a.act}${a.title ? ` <span>${a.title}</span>` : ''}</h3>`;
    for (const l of a.lines) {
      const b = document.createElement('button');
      b.className = 'line' + (played.has(l) ? ' done' : '') + (l === next ? ' next' : '');
      b.innerHTML = `<span class="n"><span>${++n}</span></span><span class="t"></span>`;
      b.querySelector('.t').textContent = l;
      b.onclick = () => turn(l);
      g.append(b);
    }
    return g;
  }));
}

// ---------- MCP traffic drawer ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const log = (kind, label, payload) => {
  const li = document.createElement('li');
  li.className = kind;
  const now = new Date();
  const t = now.toLocaleTimeString([], { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
  const method = payload?.method || (payload?.result ? 'result' : payload?.error ? 'error' : '');
  const name = payload?.params?.name ? ` <i>${esc(payload.params.name)}</i>` : '';
  li.innerHTML = `<details><summary><span class="dir">${esc(label)}</span><span class="t">${t}</span><span class="m">${esc(method)}${name}</span></summary></details>`;
  li.querySelector('details').append(Object.assign(document.createElement('pre'), { textContent: JSON.stringify(payload, null, 2).slice(0, 8000) }));
  $('#log').append(li);
  if (!$('#drawer').hidden) li.scrollIntoView({ block: 'end' });
};
const mcp = new McpHttpClient(new URL('/mcp', location.href).href, {
  headers: { 'x-mandat-household': household },
  onLog: (dir, msg) => log(dir === 'out' ? 'out' : 'in', dir === 'out' ? 'page → server' : 'server → page', msg),
});
const showSession = () => {
  $('#sessionInfo').innerHTML = `protocol <em>${esc(mcp.protocolVersion || '…')}</em> · Streamable HTTP · MCP-Session-Id <em>${esc(mcp.sessionId || 'none (stateless)')}</em> · household <em>${esc(household)}</em>`;
};

// ---------- the device screen: fixed resolution, scaled to fit ----------
const DEVICES = { show15: { W: 1920, H: 1080, B: 30 }, show8: { W: 1280, H: 800, B: 64 } };
function fit() {
  const d = DEVICES[device];
  if (!d) return;
  const room = $('#room');
  const availW = room.clientWidth;
  const availH = Math.max(320, window.innerHeight - room.getBoundingClientRect().top - 72 + window.scrollY);
  const fullW = d.W + 2 * d.B, fullH = d.H + 2 * d.B;
  const s = Math.min(availW / fullW, (window.innerWidth > 1100 ? availH : Infinity) / fullH, 1);
  const show = $('#show');
  show.style.setProperty('--s', s);
  show.style.width = fullW * s + 'px';
  show.style.height = fullH * s + 'px';
  host.setContext({ containerDimensions: slotSize() });
}
function slotSize() {
  const slot = $('#cardSlot');
  return { width: slot.clientWidth || undefined, maxHeight: slot.clientHeight || undefined };
}

// ---------- MCP Apps host ----------
const screenTheme = () => document.documentElement.dataset.theme || 'dark';
const host = new AppsHost({
  container: $('#cardSlot'), mcp,
  hostContext: { theme: screenTheme(), displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], locale: 'en-US', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, platform: 'web', userAgent: 'alexa-plus-web-simulator', deviceCapabilities: { touch: true, hover: false, deviceClass: device }, containerDimensions: {} },
  onLog: (dir, msg) => log('view', dir, msg),
  onMessage: (text) => turn(text),
  onModelContext: (p) => { session = { ...session, modelContext: p.structuredContent || null }; },
  onDisplayMode: (mode) => { document.body.classList.toggle('fullscreen', mode === 'fullscreen'); requestAnimationFrame(() => host.setContext({ containerDimensions: slotSize() })); },
  onToolResult: (name, args, result) => {
    absorbResult(name, result); updateGauge(result);
    if (name === 'confirm_plan' && !result.isError) {
      // a tap on Approve is the user's yes: Alexa confirms out loud, like after a spoken yes
      setAsk(null);
      const yes = SCRIPT.flatMap((a) => a.lines).find((l) => !played.has(l));
      if (yes && /^yes/i.test(yes)) { played.add(yes); store.set(`mandat.played.${household}`, [...played]); renderScript(); }
      const said = result.content?.[0]?.text || 'Booked.';
      showTrail([{ name, result }]); setReply(said); speak(said);
    }
  },
});

async function render(name, args, result) {
  const uri = result?._meta?.ui?.resourceUri;
  if (!uri || result.isError || device === 'dot') return;
  if (!resourceCache.has(uri)) {
    const r = await mcp.readResource(uri);
    resourceCache.set(uri, r.contents[0].text);
  }
  document.body.classList.remove('fullscreen');
  document.body.dataset.screen = 'card';
  host.setContext({ displayMode: 'inline', containerDimensions: slotSize() });
  await host.show({ html: resourceCache.get(uri), toolName: name, args, result });
}

// Close tokens and pending plans from card actions are kept like the orchestrator's own.
function absorbResult(name, result) {
  const orders = result?.structuredContent?.receipt?.orders || [];
  if (orders.length) session.closeTokens = { ...(session.closeTokens || {}), ...Object.fromEntries(orders.filter((o) => o.close_token).map((o) => [o.id, o.close_token])) };
  if (name === 'confirm_plan' && !result.isError) session.pending = null;
  store.set(`mandat.session.${household}`, session);
}

const C = 2 * Math.PI * 15;
function updateGauge(result) {
  const d = result?.structuredContent || {};
  const env = d.receipt?.envelope || d.envelope || (d.envelopes || [])[0];
  if (!env || !env.budget) return;
  const frac = (x) => Math.max(0, Math.min(1, x / env.budget));
  $('#gauge').hidden = false;
  $('#ringSpent').setAttribute('stroke-dasharray', `${frac(env.spent) * C} ${C}`);
  $('#ringHeld').setAttribute('stroke-dasharray', `${frac(env.spent + env.held) * C} ${C}`);
  $('#gaugeText').innerHTML = `<b>${usd(env.remaining)} left</b> of ${usd(env.budget)} · ${esc(env.purpose)}`;
}

// One card per turn: when several calls of this turn ended on a receipt (settling five orders, say), the host shows
// them together on one receipt card, each order in its latest state.
const RECEIPT_TOOLS = ['confirm_plan', 'change_order', 'close_order'];
function mergeReceipts(shown, steps) {
  if (!RECEIPT_TOOLS.includes(shown.name)) return shown.result;
  const mine = steps.filter((s) => RECEIPT_TOOLS.includes(s.name) && !s.result?.isError && s.result?.structuredContent?.receipt);
  if (mine.length < 2) return shown.result;
  const orders = new Map();
  for (const s of mine) for (const o of s.result.structuredContent.receipt.orders) orders.set(o.id, o);
  const last = shown.result.structuredContent;
  const list = [...orders.values()].sort((a, b) => b.timeline.length - a.timeline.length); // the most eventful first
  return { ...shown.result, structuredContent: { ...last, receipt: { ...last.receipt, orders: list } } };
}

// What Alexa did this turn, in a few words (shown under the card, from the real tool results).
function trailLabel(s) {
  const d = s.result?.structuredContent || {};
  if (s.result?.isError) return 'Stopped: needs a change';
  switch (s.name) {
    case 'set_spending_mandate': return `Budget ${usd(d.mandate?.budget || 0)}`;
    case 'remember_preference': return 'Saved to memory';
    case 'get_household_status': return 'Checked the budget';
    case 'find_home_services': return `${d.asked || ''} ${(d.asked === 1 ? { cleaning: 'cleaner', catering: 'caterer', plumbing: 'plumber', handyman: 'handyman' } : { cleaning: 'cleaners', catering: 'caterers', plumbing: 'plumbers', handyman: 'handymen' })[d.category] || 'pros'} asked`.trim();
    case 'find_products': return d.skipped?.length ? `Products · ${d.skipped.length} skipped` : 'Products checked';
    case 'negotiate_offer': return 'Negotiated';
    case 'propose_plan': return d.plan ? `Plan ${usd(d.plan.breakdown.total)}${d.auto_approved ? ' · auto' : ''}` : 'Plan';
    case 'confirm_plan': { const n = d.receipt?.orders?.length || 0; return `${n} PayPal hold${n === 1 ? '' : 's'}`; }
    case 'change_order': { const o = d.receipt?.orders?.[0]; return o?.state === 'released' ? `${o.merchant} declined · hold voided` : `${o?.merchant || 'Merchant'} moved`; }
    case 'close_order': {
      const o = d.receipt?.orders?.[0];
      const t = ['refunded', 'captured', 'released'].map((st) => [...(o?.timeline || [])].reverse().find((x) => x.state === st)).find(Boolean);
      return t ? `${{ refunded: 'Refunded', captured: 'Paid', released: 'Released' }[t.state]} ${usd(t.amount ?? o.amount)}` : 'Payment updated';
    }
    default: return s.result?._meta?.ui?.invoked || s.name;
  }
}
function showTrail(steps) {
  const labels = [];
  for (const s of steps) { const l = trailLabel(s); if (labels[labels.length - 1] !== l) labels.push(l); }
  $('#trail').replaceChildren(...labels.map((l, i) => Object.assign(document.createElement('li'), { textContent: l, style: `animation-delay:${i * 110}ms` })));
}

// ---------- voice out ----------
let ttsServer = false;
function setReply(text) {
  const el = $('#reply');
  el.classList.toggle('long', text.length > 150);
  el.replaceChildren(...text.split(/(\s+)/).map((w) => /\s+/.test(w) ? document.createTextNode(w) : Object.assign(document.createElement('span'), { className: 'w', textContent: w })));
  $('#dotSub').textContent = text;
}
function markSaid(charIndex) {
  let i = 0;
  for (const n of $('#reply').childNodes) {
    if (n.nodeType === 1 && i <= charIndex) n.classList.add('said');
    i += n.textContent.length;
  }
}
const markAll = () => markSaid(Infinity);
async function speak(text) {
  setState('speaking');
  const words = text.split(/\s+/).length;
  try {
    if (ttsServer) {
      const r = await fetch('/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      if (r.ok) {
        const a = new Audio(URL.createObjectURL(await r.blob()));
        a.ontimeupdate = () => { if (a.duration) markSaid((a.currentTime / a.duration) * text.length); };
        await a.play();
        await new Promise((res) => (a.onended = res));
        return;
      }
      ttsServer = false;
    }
    if ('speechSynthesis' in window) {
      await new Promise((res) => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'en-US'; u.rate = 1.04;
        const v = speechSynthesis.getVoices().find((x) => /en-US/.test(x.lang) && /Samantha|Ava|Google US English|Jenny|Aria/.test(x.name));
        if (v) u.voice = v;
        u.onboundary = (e) => markSaid(e.charIndex);
        u.onend = res; u.onerror = res;
        setTimeout(res, Math.max(4000, words * 480)); // never stay stuck in "speaking"
        speechSynthesis.cancel(); speechSynthesis.speak(u);
      });
    }
  } finally {
    markAll();
    setState(session.pending ? 'confirming' : 'idle');
  }
}

// ---------- voice in ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function listen() {
  if (!SR) { $('#typeInput').focus(); $('#micHint').textContent = 'Voice input needs Chrome. Type instead.'; return; }
  if (rec) { rec.stop(); return; }
  speechSynthesis?.cancel?.();
  rec = new SR();
  rec.lang = 'en-US'; rec.interimResults = true; rec.maxAlternatives = 1;
  let final = '';
  rec.onresult = (e) => { final = [...e.results].map((r) => r[0].transcript).join(' '); showHeard(final); };
  rec.onend = () => { rec = null; setState(session.pending ? 'confirming' : 'idle'); if (final.trim()) turn(final.trim()); };
  rec.onerror = () => { rec = null; setState('idle'); };
  setState('listening');
  rec.start();
}

// ---------- one turn ----------
const LABELS = { idle: 'Tap and talk', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…', confirming: 'Waiting for your yes' };
function setState(s) { document.body.dataset.state = s; $('#micLabel').textContent = LABELS[s]; }
function showHeard(text) {
  const el = $('#caption');
  el.innerHTML = `<span class="q">“</span>${esc(text)}<span class="q">”</span>`;
  el.classList.add('on');
  $('#dotYou').textContent = text ? `“${text}”` : '';
}
function setAsk(pending) {
  $('#ask').hidden = !pending;
  if (pending) $('#askText').textContent = `Say “yes” to confirm ${usd(pending.total)}`;
}
let busy = false;
async function turn(text) {
  if (busy) return;
  busy = true;
  speechSynthesis?.cancel?.();
  played.add(text); store.set(`mandat.played.${household}`, [...played]); renderScript();
  showHeard(text);
  $('#reply').textContent = '';
  $('#dotSub').textContent = '';
  $('#trail').replaceChildren();
  setAsk(null);
  setState('thinking');
  try {
    log('orch', 'page → /turn', { method: 'turn', params: { text, device } });
    const r = await fetch('/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, session, household, device: device === 'dot' ? 'dot' : 'show' }) });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || 'turn failed');
    for (const s of out.steps) log('orch', 'brain tools/call', { method: 'tools/call', params: { name: s.name, arguments: s.args }, result: s.result });
    session = { ...out.session, modelContext: null };
    store.set(`mandat.session.${household}`, session);
    for (const s of out.steps) updateGauge(s.result);
    const withCard = (s) => s.result?._meta?.ui?.resourceUri && !s.result.isError;
    const shown = [...out.steps].reverse().find((s) => withCard(s) && s.name !== 'get_household_status') || [...out.steps].reverse().find(withCard);
    showTrail(out.steps);
    setReply(out.speech);
    setAsk(session.pending);
    if (shown) await render(shown.name, shown.args, mergeReceipts(shown, out.steps));
    busy = false;
    await speak(out.speech);
  } catch (e) {
    setReply('Sorry, something went wrong. ' + e.message);
    markAll();
    setState('idle');
  } finally { busy = false; }
}

// ---------- device, theme, boot ----------
function setDevice(d) {
  device = d; store.set('mandat.device', d);
  document.body.dataset.device = d;
  for (const b of document.querySelectorAll('[data-dev]')) b.setAttribute('aria-pressed', String(b.dataset.dev === d));
  host.setContext({ deviceCapabilities: { touch: d !== 'dot', hover: false, deviceClass: d } });
  requestAnimationFrame(fit);
}
for (const b of document.querySelectorAll('[data-dev]')) b.onclick = () => setDevice(b.dataset.dev);
$('#theme').onclick = () => { const t = screenTheme() === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; store.set('mandat.theme', t); host.setContext({ theme: t }); };
const toggleDrawer = (open = $('#drawer').hidden) => { $('#drawer').hidden = !open; if (open) $('#log').lastElementChild?.scrollIntoView({ block: 'end' }); };
$('#devToggle').onclick = () => toggleDrawer();
$('#closeDrawer').onclick = () => toggleDrawer(false);
$('#clearLog').onclick = () => $('#log').replaceChildren();
$('#newHousehold').onclick = () => { household = 'h-' + Math.random().toString(36).slice(2, 8); store.set('mandat.household', household); location.search = '?household=' + household; };
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea')) return;
  if (e.key === 'd' || e.key === 'D') toggleDrawer();
  if (e.key === 'Escape') toggleDrawer(false);
  if (e.code === 'Space') { e.preventDefault(); listen(); }
});
$('#mic').onclick = listen;
$('#typeForm').onsubmit = (e) => { e.preventDefault(); const v = $('#typeInput').value.trim(); if (v) { $('#typeInput').value = ''; turn(v); } };
const tick = () => {
  const now = new Date();
  const hm = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/, '');
  $('#clock').textContent = hm;
  $('#homeTime').textContent = hm;
  $('#homeDate').textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
};
tick(); setInterval(tick, 15000);
const savedTheme = store.get('mandat.theme', null); if (savedTheme) document.documentElement.dataset.theme = savedTheme;
if (params.get('theme')) document.documentElement.dataset.theme = params.get('theme');
host.setContext({ theme: screenTheme() });
renderScript();
setDevice(device);
window.addEventListener('resize', fit);
new ResizeObserver(fit).observe($('#room'));
let slotRaf = 0;
new ResizeObserver(() => { cancelAnimationFrame(slotRaf); slotRaf = requestAnimationFrame(() => host.setContext({ containerDimensions: slotSize() })); }).observe($('#cardSlot'));

(async () => {
  try {
    const health = await fetch('/healthz').then((r) => r.json()).catch(() => ({}));
    ttsServer = health.tts === 'polly';
    await mcp.initialize();
    showSession();
    const { tools } = await mcp.listTools();
    const { resources } = await mcp.listResources();
    log('orch', 'page', { method: 'ready', params: { tools: tools.map((t) => t.name), resources: resources.map((r) => r.uri) } });
    // The page's own tools/call: the envelope gauge at boot.
    const status = await mcp.callTool('get_household_status', { section: 'budget' });
    updateGauge(status);
    if (session.pending) { setAsk(session.pending); setState('confirming'); }
  } catch (e) {
    document.body.dataset.screen = 'card';
    setReply('Cannot reach the Mandat MCP server: ' + e.message);
    markAll();
  }
})();
