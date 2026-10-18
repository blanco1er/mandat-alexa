// Alexa+ web simulator: voice in (Web Speech), the orchestrator decides (/turn), cards render as MCP Apps,
// voice out (Polly via /tts when the server has it, else the browser voice). The page is itself an MCP client:
// it sends initialize, tools/list, resources/list, resources/read and tools/call (status at boot, card buttons).
// Voice states shown on the device: idle, listening, thinking, speaking, confirming (waiting for an explicit yes).
import { McpHttpClient } from './mcp-client.js';
import { AppsHost } from './apps-host.js';
import UI from './design-system/motion.js';
import { createWallpaper } from './wallpaper.js';

const $ = (s) => document.querySelector(s);
const store = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const params = new URLSearchParams(location.search);
let household = params.get('household') || store.get('mandat.household', 'demo');
let session = store.get(`mandat.session.${household}`, {});
let device = params.get('device') || store.get('mandat.device', 'show15');
if (!['show15', 'show8', 'dot'].includes(device)) device = 'show15';
const resourceCache = new Map();
const wallpaper = createWallpaper(document.querySelector('#wall'), { start: params.get('wall') });
const usd = (n) => '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(Math.round(n * 100) / 100) ? 0 : 2, maximumFractionDigits: 2 });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 10 17 19 7"/></svg>';

// ---------- the demo script (the three stories of the video) ----------
const SCRIPT = [
  { act: 'Before the stories', title: 'Set up the household', lines: [
    'Set a weekly household budget of $150, and buy on your own under $40.',
    'Remember that Max, our dog, is allergic to chicken.',
    'Remember we drink Northbeam medium roast.'] },
  { act: 'Story 1', title: 'The in-laws are coming', lines: [
    'Alexa, my in-laws land Saturday. Get the guest room ready: a cleaner Friday, fresh bedding, and dinner for six at home Saturday. Keep it under $400.',
    'Show me the bed linen.',
    'Other options?',
    'Take the sateen set instead.',
    'Compare the two caterers.',
    'Yes, book it.'] },
  { act: 'Story 2', title: 'Four days later', lines: [
    "We're almost out of dog food and coffee.",
    'Yes.'] },
  { act: 'Story 3', title: 'Plans change', lines: [
    'Their flight moved to Sunday.',
    'Yes, go ahead.',
    'Everything went well. Settle up: Olive billed $180, and refund the $28 pillowcases.'] },
  { act: 'Anytime', title: 'Questions and one-offs', lines: ['How much is left?', 'My kitchen sink is leaking, find a plumber for Monday morning.'] },
];
let played = new Set(store.get(`mandat.played.${household}`, []));
// The next line is the first one not said yet after the last line said (stories can be played out of order).
function nextLine() {
  const all = SCRIPT.flatMap((a) => a.lines);
  let last = -1;
  all.forEach((l, i) => { if (played.has(l)) last = i; });
  return all.slice(last + 1).find((l) => !played.has(l)) || all.find((l) => !played.has(l));
}
function renderScript() {
  const next = nextLine();
  let n = 0;
  $('#script').replaceChildren(...SCRIPT.map((a) => {
    const g = document.createElement('section');
    g.className = 'act';
    g.innerHTML = `<h3><b>${esc(a.title)}</b><span>${esc(a.act)}</span></h3>`;
    for (const l of a.lines) {
      const b = document.createElement('button');
      b.type = 'button';
      const done = played.has(l);
      b.className = 'line' + (done ? ' done' : '') + (l === next ? ' next' : '');
      if (l === next) b.setAttribute('aria-current', 'step');
      b.innerHTML = `<span class="n">${done ? CHECK_SVG : `<span>${++n}</span>`}</span><span class="t"></span>`;
      if (done) n++;
      b.querySelector('.t').textContent = l;
      b.setAttribute('aria-label', `${done ? 'Said: ' : l === next ? 'Next: ' : ''}${l}`);
      b.onclick = () => turn(l);
      g.append(b);
    }
    return g;
  }));
}

// ---------- MCP traffic drawer ----------
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

// The language the user speaks (en-US by default; the language selector sets it).
const speechLocale = () => document.documentElement.lang === 'en' ? 'en-US' : document.documentElement.lang;

// ---------- appearance: follows the system until the person picks one ----------
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const screenTheme = () => document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');
function syncThemeButton() {
  const dark = screenTheme() === 'dark';
  const b = $('#theme');
  b.setAttribute('aria-pressed', String(dark));
  b.setAttribute('aria-label', dark ? 'Light appearance' : 'Dark appearance');
  b.querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
}

// ---------- the device screen: fixed resolution, scaled to fit ----------
const DEVICES = { show15: { W: 1920, H: 1080, B: 30, u: 1.5 }, show8: { W: 1280, H: 800, B: 64, u: 1 } };
function fit() {
  const d = DEVICES[device];
  if (!d) return;
  const room = $('#room');
  const availW = room.clientWidth;
  const availH = Math.max(320, window.innerHeight - room.getBoundingClientRect().top - 72 + window.scrollY);
  const fullW = d.W + 2 * d.B, fullH = d.H + 2 * d.B;
  const s = Math.min(availW / fullW, (window.innerWidth > 1100 ? availH : Infinity) / fullH, 1);
  const show = $('#show');
  // device geometry set inline (not only through body[data-device]) so a live device switch always re-lays out
  for (const k of ['W', 'H', 'B']) show.style.setProperty('--' + k, d[k]);
  show.style.setProperty('--u', d.u + 'px');
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
      const yes = nextLine();
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
    resourceCache.set(uri, { html: r.contents[0].text, csp: r.contents[0]._meta?.ui?.csp || { connectDomains: [], resourceDomains: [] } });
  }
  document.body.classList.remove('fullscreen');
  document.body.dataset.screen = 'card';
  host.setContext({ displayMode: 'inline', containerDimensions: slotSize() });
  await host.show({ ...resourceCache.get(uri), toolName: name, args, result });
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

// The ambient home screen shows the household's real state (from get_household_status), not a slogan.
function renderHome(status) {
  const d = status?.structuredContent || {};
  const envs = d.envelopes || [];
  const e = envs.find((x) => x.period !== 'once') || envs[0];
  const w = $('#homeWidget');
  const pending = (d.pending_decisions || []).length;
  const open = (d.open_orders || []).length;
  if (!e) {
    w.innerHTML = '<p class="hw-context"><span>Mandat</span><span>No budget yet</span></p><p class="hw-title">Give Alexa a weekly budget and a rule for small buys.</p>';
    $('#homeHint').textContent = 'Try “Alexa, set a weekly household budget of $150, and buy on your own under $40.”';
    return;
  }
  const pct = (x) => Math.max(0, Math.min(100, (x / e.budget) * 100));
  const per = e.period === 'once' ? '' : ` this ${e.period === 'weekly' ? 'week' : e.period === 'monthly' ? 'month' : e.period}`;
  const note = pending ? `<b>${pending} plan${pending === 1 ? '' : 's'}</b> waiting for your yes` : open ? `<b>${open}</b> payment${open === 1 ? '' : 's'} on hold` : e.auto_approve_under ? `Buys on its own under <b>${usd(e.auto_approve_under)}</b>` : 'Always asks before paying';
  w.innerHTML = `<p class="hw-context"><span>Mandat · ${esc(e.purpose)}</span><span>${usd(e.budget)}${per}</span></p>
    <p class="hw-num">${usd(e.remaining)}<small>left</small></p>
    <div class="hw-bar" aria-hidden="true"><span class="spent" style="width:${pct(e.spent)}%"></span><span class="held" style="width:${pct(e.held)}%"></span></div>
    <p class="hw-line">${note}</p>`;
  const prefs = (d.preferences || []).slice(-2).reverse();
  const mem = $('#homeMemory');
  mem.hidden = !prefs.length;
  if (prefs.length) mem.innerHTML = `<p class="hw-context"><span>Household memory</span><span>${(d.preferences || []).length} ${(d.preferences || []).length === 1 ? 'fact' : 'facts'}</span></p>
    <ul class="hw-list">${prefs.map((p) => `<li><b>${esc(p.subject)}</b><span>${esc(p.fact)}</span></li>`).join('')}</ul>`;
  $('#homeHint').textContent = played.size ? 'Try “Alexa, how much is left?”' : 'Try “Alexa, my in-laws land Saturday…”';
}

// One card per turn: when several calls of this turn ended on a receipt (settling five orders, say), the host shows
// them together on one receipt card, each order in its latest state.
const RECEIPT_TOOLS = ['confirm_plan', 'change_order', 'close_order'];
function mergeReceipts(shown, steps) {
  if (shown.name === 'propose_plan') {
    // Story 2: what Alexa already bought on her own this turn (within the rule) is shown on the plan that still needs a yes.
    const auto = steps.filter((s) => s.name === 'confirm_plan' && !s.result?.isError).flatMap((s) => s.result?.structuredContent?.receipt?.orders || []);
    if (!auto.length) return shown.result;
    return { ...shown.result, structuredContent: { ...shown.result.structuredContent, also_bought: auto.map((o) => ({ merchant: o.merchant, label: o.label, amount: o.amount })) } };
  }
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
    case 'get_offer_details': return d.offer ? `Opened ${d.offer.kind === 'service' ? d.offer.merchant : d.offer.title.split(':')[0]}` : 'Details';
    case 'list_alternatives': return `${Math.max(0, (d.offers?.length || 1) - 1)} other options`;
    case 'compare_offers': return `Compared ${d.offers?.length || 2}`;
    case 'revise_plan': return d.plan ? `Plan now ${usd(d.plan.breakdown.total)}` : 'Plan updated';
    case 'review_plan': return 'Plan';
    case 'propose_plan': return d.plan ? `Plan ${usd(d.plan.breakdown.total)}${d.auto_approved ? ' · auto' : ''}` : 'Plan';
    case 'confirm_plan': { const n = d.receipt?.orders?.length || 0; return `${n} payment hold${n === 1 ? '' : 's'}`; }
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
  $('#trail').replaceChildren(...labels.map((l, i) => {
    const li = document.createElement('li');
    li.innerHTML = CHECK_SVG;
    li.append(l);
    li.style.animationDelay = `${i * 90}ms`;
    return li;
  }));
  // when the steps do not fit next to the prompt, keep the latest ones and fade the oldest
  const t = $('#trail');
  requestAnimationFrame(() => t.classList.toggle('over', t.scrollWidth > t.clientWidth + 1));
}

// ---------- live activity: what Alexa is doing right now (real tool calls and merchant answers) ----------
// The page sends a turn id with /turn; Mandat writes each step of that turn to its store as it happens and the page
// reads it back (GET /activity) while the turn runs. With a real model a turn takes seconds and the list fills in as
// merchants answer; with the scripted demo brain everything is already done, so the same real lines are revealed
// one after the other.
const LIVE_ICONS = { done: '<path d="M5 12.5 10 17 19 7"/>', failed: '<path d="M7 7l10 10M17 7 7 17"/>' };
const liveShown = new Map();
function liveRow(e) {
  const li = document.createElement('li');
  li.dataset.step = e.step;
  fillLive(li, e);
  return li;
}
function fillLive(li, e) {
  li.className = e.state;
  const st = `<span class="st ${esc(e.state)}" aria-hidden="true">${e.state === 'running' ? '' : `<svg viewBox="0 0 24 24">${LIVE_ICONS[e.state] || LIVE_ICONS.done}</svg>`}</span>`;
  const amt = e.to != null ? `<span class="live-amt">${e.from != null && e.from !== e.to ? `<s>${usd(e.from)}</s><i>→</i>` : ''}${usd(e.to)}</span>` : '<span></span>';
  li.innerHTML = `<span class="live-ico">${e.image_url ? `<img src="${esc(e.image_url)}" alt="">` : ''}${st}</span>
    <span class="live-text"><b>${esc(e.text)}</b>${e.detail ? `<span>${esc(e.detail)}</span>` : ''}</span>${amt}`;
  li.setAttribute('aria-label', `${e.text}${e.detail ? ', ' + e.detail : ''}${e.to != null ? ', ' + usd(e.to) : ''}${e.state === 'running' ? ', in progress' : e.state === 'failed' ? ', not possible' : ''}`);
}
function renderLive(events) {
  const list = $('#liveList');
  for (const e of events) {
    const prev = liveShown.get(e.step);
    if (!prev) { const li = liveRow(e); list.append(li); liveShown.set(e.step, { e, li }); }
    else if (prev.e.state !== e.state || prev.e.text !== e.text) { fillLive(prev.li, e); prev.e = e; }
  }
  // keep the newest steps on screen: drop the oldest rows that no longer fit
  while (list.children.length > 1 && list.scrollHeight > list.clientHeight + 2) list.firstElementChild.remove();
}
function startLive(turnId) {
  liveShown.clear();
  $('#liveList').replaceChildren();
  $('#live').removeAttribute('data-done');
  $('#liveTitle').textContent = 'Working on it';
  if (device === 'dot') return () => {};
  $('#live').hidden = false;
  document.body.dataset.live = 'on';
  let stop = false, timer = 0;
  const tick = async () => {
    if (stop) return;
    try {
      const r = await fetch(`/activity?household=${encodeURIComponent(household)}&turn=${turnId}`);
      if (r.ok && !stop) renderLive((await r.json()).events || []);
    } catch {}
    if (!stop) timer = setTimeout(tick, 650);
  };
  timer = setTimeout(tick, 250);
  return () => { stop = true; clearTimeout(timer); };
}
// The turn is over: show every real step (revealed one by one if they all finished at once), then the card.
async function finishLive(turnId) {
  if (device === 'dot') return;
  let events = [];
  try { events = (await (await fetch(`/activity?household=${encodeURIComponent(household)}&turn=${turnId}`)).json()).events || []; } catch {}
  const fresh = events.filter((e) => !liveShown.has(e.step) || liveShown.get(e.step).e.state !== e.state);
  const quick = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (fresh.length > 1 && !quick) for (const e of events) { renderLive([e]); if (fresh.includes(e)) await new Promise((r) => setTimeout(r, 170)); }
  else renderLive(events);
  $('#live').dataset.done = '';
  $('#liveTitle').textContent = 'Done';
  if (events.length) await new Promise((r) => setTimeout(r, quick ? 200 : 650));
}
function endLive() { $('#live').hidden = true; delete document.body.dataset.live; }

// ---------- voice level: real microphone level while listening, word timing while speaking ----------
const BARS = 14;
$('#wave').innerHTML = Array.from({ length: BARS }, (_, i) => `<i style="--i:${i}"></i>`).join('');
const bars = [...$('#wave').children];
let lvl = 0, target = 0, analyser = null, micStream = null, raf = 0;
function levelLoop() {
  const s = document.body.dataset.state;
  if (analyser) {
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0; for (const v of buf) sum += ((v - 128) / 128) ** 2;
    target = Math.min(1, Math.sqrt(sum / buf.length) * 5);
  } else if (s === 'speaking') target *= 0.9; // decays between word boundaries
  else target = 0;
  lvl += (target - lvl) * 0.25;
  document.body.style.setProperty('--lvl', lvl.toFixed(3));
  const t = performance.now() / 1000;
  bars.forEach((b, i) => { const c = Math.exp(-(((i - BARS / 2) / (BARS / 3)) ** 2)); b.style.setProperty('--l', Math.max(0, Math.min(1, lvl * c * (0.6 + 0.4 * Math.sin(t * 9 + i * 1.3)))).toFixed(3)); });
  if (s === 'listening' || s === 'speaking' || lvl > 0.01) raf = requestAnimationFrame(levelLoop); else { raf = 0; document.body.style.setProperty('--lvl', '0'); bars.forEach((b) => b.style.setProperty('--l', '0')); }
}
const kickLevel = () => { if (!raf) raf = requestAnimationFrame(levelLoop); };
async function openMicLevel() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = ctx.createAnalyser(); analyser.fftSize = 512;
    ctx.createMediaStreamSource(micStream).connect(analyser);
    analyser._ctx = ctx;
  } catch { analyser = null; }
}
function closeMicLevel() {
  micStream?.getTracks().forEach((t) => t.stop()); micStream = null;
  analyser?._ctx?.close?.(); analyser = null;
}

// ---------- voice out ----------
let ttsServer = false;
function setReply(text, { error = false } = {}) {
  const el = $('#reply');
  el.classList.toggle('long', text.length > 150);
  el.classList.toggle('err', error);
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
  kickLevel();
  const words = text.split(/\s+/).length;
  try {
    if (ttsServer) {
      const r = await fetch('/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      if (r.ok) {
        const a = new Audio(URL.createObjectURL(await r.blob()));
        a.ontimeupdate = () => { if (a.duration) { markSaid((a.currentTime / a.duration) * text.length); target = 0.8; } };
        await a.play();
        await new Promise((res) => (a.onended = res));
        return;
      }
      ttsServer = false;
    }
    if (window.speechSynthesis && window.SpeechSynthesisUtterance) {
      await new Promise((res) => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'en-US'; u.rate = 1.04;
        const v = speechSynthesis.getVoices().find((x) => /en-US/.test(x.lang) && /Samantha|Ava|Google US English|Jenny|Aria/.test(x.name));
        if (v) u.voice = v;
        u.onboundary = (e) => { markSaid(e.charIndex); target = 0.65 + Math.random() * 0.35; };
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
  if (!SR) { $('#typeInput').focus(); const h = $('#micHint'); h.textContent = 'This browser cannot hear you. Type instead, or open the page in Chrome.'; h.classList.add('err'); return; }
  if (rec) { rec.stop(); return; }
  speechSynthesis?.cancel?.();
  rec = new SR();
  rec.lang = 'en-US'; rec.interimResults = true; rec.maxAlternatives = 1;
  let final = '';
  rec.onresult = (e) => { final = [...e.results].map((r) => r[0].transcript).join(' '); showHeard(final); };
  rec.onend = () => { rec = null; closeMicLevel(); setState(session.pending ? 'confirming' : 'idle'); if (final.trim()) turn(final.trim()); };
  rec.onerror = (e) => {
    rec = null; closeMicLevel(); setState('idle');
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { const h = $('#micHint'); h.textContent = 'Microphone blocked. Allow it in the address bar, or type below.'; h.classList.add('err'); }
  };
  setState('listening');
  openMicLevel().then(kickLevel);
  rec.start();
}

// ---------- one turn ----------
const LABELS = { idle: 'Tap to talk', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Alexa is speaking', confirming: 'Waiting for your yes' };
function setState(s) {
  document.body.dataset.state = s;
  $('#voice').dataset.state = s;
  $('#micLabel').textContent = LABELS[s];
  $('#mic').setAttribute('aria-label', s === 'listening' ? 'Stop listening' : 'Talk to Alexa');
}
function showHeard(text) {
  const el = $('#caption');
  el.textContent = `“${text}”`;
  el.classList.add('on');
  $('#dotYou').textContent = text ? `“${text}”` : '';
}
function setAsk(pending) {
  $('#ask').hidden = !pending;
  if (pending) $('#askText').textContent = `Say “yes” to confirm ${usd(pending.total)}`;
}
let busy = false;
function setBusy(on) {
  busy = on;
  const b = $('#send');
  if (on) { b.disabled = true; b.setAttribute('aria-busy', 'true'); b.setAttribute('aria-label', 'Sending'); b.innerHTML = '<span class="spin" aria-hidden="true"></span>'; }
  else { b.removeAttribute('aria-busy'); b.setAttribute('aria-label', 'Send'); b.innerHTML = '<svg class="ui-icon"><use href="#i-up"/></svg>'; b.disabled = !$('#typeInput').value.trim(); }
  for (const l of document.querySelectorAll('.line')) l.toggleAttribute('aria-disabled', on);
}
async function turn(text) {
  if (busy) return;
  setBusy(true);
  speechSynthesis?.cancel?.();
  played.add(text); store.set(`mandat.played.${household}`, [...played]); renderScript();
  showHeard(text);
  $('#reply').textContent = '';
  $('#dotSub').textContent = '';
  $('#trail').replaceChildren();
  setAsk(null);
  setState('thinking');
  if (document.body.dataset.screen === 'home' && device !== 'dot') document.body.dataset.screen = 'card';
  const turnId = (crypto.randomUUID?.() || `t-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`).toLowerCase();
  const stopLive = startLive(turnId);
  try {
    log('orch', 'page → /turn', { method: 'turn', params: { text, device, turn: turnId } });
    const r = await fetch('/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, session, household, device: device === 'dot' ? 'dot' : 'show', turn: turnId, locale: speechLocale() }) });
    const out = await r.json();
    stopLive();
    if (r.ok) await finishLive(turnId);
    endLive();
    if (!r.ok) throw Object.assign(new Error(out.error || 'turn failed'), { spoken: out.speech });
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
    setBusy(false);
    await speak(out.speech);
  } catch (e) {
    // Honest error: what happened, what did not, and the way out.
    stopLive(); endLive();
    played.delete(text); store.set(`mandat.played.${household}`, [...played]); renderScript();
    if (document.body.dataset.screen === 'home') document.body.dataset.screen = 'card';
    setReply(e.spoken || 'I could not reach Mandat, so nothing was booked or charged. Try again in a moment.', { error: true });
    markAll();
    setState('idle');
    log('orch', 'page ✕ /turn', { method: 'error', error: { message: String(e.message || e) } });
  } finally { if (busy) setBusy(false); }
}

// ---------- device, theme, boot ----------
function setDevice(d) {
  device = d; store.set('mandat.device', d);
  document.body.dataset.device = d;
  const r = document.querySelector(`input[name="device"][value="${d}"]`);
  if (r && !r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
  host.setContext({ deviceCapabilities: { touch: d !== 'dot', hover: false, deviceClass: d } });
  wallpaper.setDevice(d);
  requestAnimationFrame(fit);
}
for (const r of document.querySelectorAll('input[name="device"]')) r.addEventListener('change', () => { if (r.checked && r.value !== device) setDevice(r.value); });
$('#theme').onclick = () => {
  const t = screenTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t; store.set('mandat.theme', t);
  host.setContext({ theme: t }); syncThemeButton();
};
darkQuery.addEventListener('change', () => { host.setContext({ theme: screenTheme() }); syncThemeButton(); });
const toggleDrawer = (open = $('#drawer').hidden) => {
  $('#drawer').hidden = !open;
  $('#devToggle').setAttribute('aria-expanded', String(open));
  if (open) { $('#log').lastElementChild?.scrollIntoView({ block: 'end' }); $('#closeDrawer').focus({ preventScroll: true }); }
};
$('#devToggle').onclick = () => toggleDrawer();
$('#closeDrawer').onclick = () => { toggleDrawer(false); $('#devToggle').focus({ preventScroll: true }); };
$('#clearLog').onclick = () => $('#log').replaceChildren();
$('#newHousehold').onclick = () => { household = 'h-' + Math.random().toString(36).slice(2, 8); store.set('mandat.household', household); location.search = '?household=' + household; };
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea')) return;
  if (e.key === 'd' || e.key === 'D') toggleDrawer();
  if (e.key === 'Escape') toggleDrawer(false);
  if (e.code === 'Space' && !e.target.closest('button')) { e.preventDefault(); listen(); }
});
$('#mic').onclick = listen;
$('#typeInput').addEventListener('input', () => { if (!busy) $('#send').disabled = !$('#typeInput').value.trim(); });
$('#typeForm').onsubmit = (e) => { e.preventDefault(); const v = $('#typeInput').value.trim(); if (v && !busy) { $('#typeInput').value = ''; turn(v); } };
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
UI.init();
syncThemeButton();
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
    // Say honestly what runs behind this page: real model or not, sandbox payments or simulated ones.
    const brain = /nova-2-lite/.test(health.brain || '') ? 'Amazon Nova 2 Lite on Bedrock' : /bedrock/.test(health.brain || '') ? 'Amazon Bedrock' : 'a scripted demo brain';
    const pay = health.paypal === 'offline' ? 'payments are simulated (PayPal sandbox not connected)' : 'PayPal sandbox';
    if (health.ok) $('#fine').textContent = `Unofficial Alexa+ simulator. Brain: ${brain}; ${pay}. No real money.`;
    await mcp.initialize();
    showSession();
    const { tools } = await mcp.listTools();
    const { resources } = await mcp.listResources();
    log('orch', 'page', { method: 'ready', params: { tools: tools.map((t) => t.name), resources: resources.map((r) => r.uri) } });
    // The page's own tools/call: the household at boot (envelope gauge + the ambient home widget).
    const status = await mcp.callTool('get_household_status', {});
    updateGauge(status);
    renderHome(status);
    if (session.pending) { setAsk(session.pending); setState('confirming'); }
  } catch (e) {
    $('#homeWidget').innerHTML = '<p class="hw-context"><span>Mandat</span><span>Offline</span></p><p class="hw-title">Cannot reach the Mandat MCP server.</p>';
    $('#homeHint').textContent = 'Start it with “npm run demo”, then reload this page.';
  }
})();
