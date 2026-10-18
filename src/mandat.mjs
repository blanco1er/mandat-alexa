// Mandat for Alexa+: the household errands service behind the MCP tools.
// One method per user intent. Each returns { speech, data, card }: `speech` is what the assistant says (no ids, no
// pipes), `data` is the structured result (ids, tokens, prices) and `card` names the MCP Apps view that renders it.
// Money rules enforced here, whatever the model does:
//  - nothing is paid without confirm_plan, called with the confirmation token issued for that exact plan;
//  - a plan above the household's auto-approve threshold also needs the user's explicit yes (user_confirmation);
//  - a plan never exceeds what is left in its envelope (checked at proposal AND again at confirmation);
//  - confirm_plan is idempotent on plan_id: a retry returns the same receipt and never holds twice;
//  - a merchant agent (simulated or Bedrock) can never price below the merchant's floor (guardQuote).
import crypto from 'node:crypto';
import * as envelope from './core/envelope.mjs';
import * as defaultPaypal from './core/paypal.mjs';
import { searchProducts, shopEnabled } from './core/shop.mjs';
import { searchCatalog } from './core/catalog.mjs';
import { galleryFor, mediaFor } from './core/media.mjs';
import { note } from './core/activity.mjs';
import { current } from './core/context.mjs';
import * as I from './core/i18n.mjs';
import { DAY_NAMES, guardQuote, identityCard, merchant as merchantById, MERCHANTS, normalizeCategory, parseGuests, parseWhen, search, usTime, verifyCard } from './core/merchants.mjs';
import { pkOf } from './store/index.mjs';
import { merchantSay } from './providers/simulated.mjs';
import * as S from './core/settings.mjs';

export class ToolError extends Error {
  constructor(message, next) { super(message); this.next = next; }
}

const OFFER_TTL = 30 * 60 * 1000;
const PAYPAL_PK = 'SYSTEM#paypal'; // the demo buyer's sandbox payment token (shared by every household of the demo)
const PLAN_TTL = 15 * 60 * 1000;
const MAX_BUDGET = 5000; // sandbox demo cap
const round = (x) => Math.round(Number(x) * 100) / 100;
// What is said follows the user's locale (X-Mandat-Locale, see src/core/i18n.mjs); data stays canonical.
const loc = () => current().locale || 'en-US';
const T = (key, v) => I.tr(loc(), key, v);
const P = (text) => I.phrase(text, loc());
const usd = (n, currency = 'USD') => I.money(round(n), loc(), currency);
const id = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const spokenSlot = (slot) => I.spokenSlot(slot, loc());
const firstSentence = (t) => String(t || '').split(/(?<=[.!?])\s/)[0].slice(0, 90);
const listWords = (xs) => I.list(xs, loc());
const nounOf = (cat, n) => I.noun(cat, n, loc());
// An explicit yes: what the user said, or the Approve tap of the plan card.
// Same rule in every language: the sentence must START with a yes word of English, French or Spanish, and contain
// no "no" word of any of them ("oui mais attends" is not a yes). Never looser than English.
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ALL_YES = [...new Set([...Object.values(I.YES_WORDS).flat(), 'tap:approve'])].sort((a, b) => b.length - a.length).map(esc).join('|');
const ALL_NO = [...new Set(Object.values(I.NO_WORDS).flat())].map(esc).join('|');
const AFFIRMATIVE = new RegExp(`^[\\s¡¿"“«]*(${ALL_YES})(?![\\p{L}])`, 'iu');
const NEGATIVE = new RegExp(`(?<![\\p{L}])(${ALL_NO})(?![\\p{L}])`, 'iu');
export const isExplicitYes = (s) => typeof s === 'string' && AFFIRMATIVE.test(s.trim()) && !NEGATIVE.test(s);

function periodKey(period, now) {
  if (period === 'once') return 'once';
  const d = new Date(now);
  if (period === 'monthly') return d.toISOString().slice(0, 7);
  // ISO week
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

export class Mandat {
  constructor({ store, provider, paypal = defaultPaypal, publicUrl = process.env.MANDAT_PUBLIC_URL || 'http://localhost:8787', now = () => Date.now() }) {
    Object.assign(this, { store, provider, paypal, publicUrl, now });
    this.locks = new Map();
  }

  // Serialize writes per household (one warm Lambda handles one request at a time; this covers the local server).
  async locked(hid, fn) {
    const prev = this.locks.get(hid) || Promise.resolve();
    let release;
    const next = new Promise((r) => (release = r));
    this.locks.set(hid, prev.then(() => next));
    await prev;
    try { return await fn(); } finally { release(); if (this.locks.get(hid) === next) this.locks.delete(hid); }
  }
  // One line on the live activity screen (real progress of this voice turn; a no-op outside a turn).
  live(ev) { return note(this.store, ev); }
  async event(hid, type, detail = {}) {
    const at = new Date(this.now()).toISOString();
    await this.store.put(pkOf(hid), `EVENT#${at}#${crypto.randomBytes(3).toString('hex')}`, { type, at, ...detail });
  }

  // ---------- mandates & envelopes ----------
  async mandates(hid) { return (await this.store.query(pkOf(hid), 'MANDATE#')).map((r) => r.value); }
  async mandate(hid, mid) {
    const all = (await this.mandates(hid)).filter((m) => m.status === 'active');
    if (mid) {
      const m = all.find((x) => x.id === mid);
      if (!m) throw new ToolError('That budget does not exist or is not active.', 'Call get_household_status to see the active budgets, or set one with set_spending_mandate.');
      return m;
    }
    // Default: the household's recurring envelope, else the most recent one.
    const recurring = all.filter((m) => m.period !== 'once').sort((a, b) => b.created.localeCompare(a.created))[0];
    const latest = [...all].sort((a, b) => b.created.localeCompare(a.created))[0];
    const m = recurring || latest;
    if (!m) throw new ToolError(T('e_no_budget'), 'Ask the user for a budget and call set_spending_mandate.');
    return m;
  }
  envKey(m) { return `ENVELOPE#${m.id}#${periodKey(m.period, this.now())}`; }
  async envelopeOf(hid, m) {
    const key = this.envKey(m);
    let env = await this.store.get(pkOf(hid), key);
    if (!env) {
      env = envelope.createEnvelope({ total: m.budget, currency: m.currency, approveAbove: m.auto_approve_under, purpose: m.purpose });
      await this.store.put(pkOf(hid), key, env);
    }
    return env;
  }
  async saveEnvelope(hid, m, env) { await this.store.put(pkOf(hid), this.envKey(m), env); }
  envelopeView(m, env) {
    const t = envelope.totals(env);
    return { mandate_id: m.id, purpose: m.purpose, period: m.period, period_key: periodKey(m.period, this.now()), budget: t.total, held: t.held, spent: t.spent, remaining: t.remaining, currency: t.currency, auto_approve_under: m.auto_approve_under, paypal_mode: m.paypal?.mode || 'offline' };
  }

  // ---------- 1. get_household_status ----------
  async getHouseholdStatus(hid, { section } = {}) {
    const mandates = (await this.mandates(hid)).filter((m) => m.status !== 'replaced');
    const envelopes = [];
    for (const m of mandates.filter((x) => x.status === 'active')) envelopes.push(this.envelopeView(m, await this.envelopeOf(hid, m)));
    const orders = (await this.store.query(pkOf(hid), 'ORDER#')).map((r) => r.value);
    const open = orders.filter((o) => o.state === 'held');
    const preferences = (await this.store.query(pkOf(hid), 'PREF#')).map((r) => r.value);
    const pending = (await this.store.query(pkOf(hid), 'PLAN#')).map((r) => r.value).filter((p) => p.status === 'proposed' && Date.parse(p.expires) > this.now());
    const data = {
      household_id: hid,
      envelopes: section && section !== 'budget' ? undefined : envelopes,
      mandates: section && section !== 'budget' ? undefined : mandates.map(({ paypal, ...m }) => ({ ...m, paypal_mode: paypal?.mode })),
      open_orders: section && section !== 'orders' ? undefined : open.map((o) => ({ ...publicOrder(o), purpose: mandates.find((m) => m.id === o.mandate_id)?.purpose })),
      recent_orders: section && section !== 'orders' ? undefined : orders.filter((o) => o.state !== 'held').slice(-5).map(publicOrder),
      preferences: section && section !== 'preferences' ? undefined : preferences,
      pending_decisions: pending.map((p) => ({ plan_id: p.id, total: p.breakdown.total, lines: p.lines.map((l) => l.merchant) })),
    };
    // Autonomy at a glance (level, paused, what it may still buy alone today), who the household is, what it did last.
    const settings = await this.settings(hid);
    if (settings) data.settings = { ...this.settingsView(settings), auto_spent_today: await this.autoSpentToday(hid) };
    const profile = await this.profile(hid);
    if (profile) data.profile = publicProfile(profile);
    data.recent = await this.recentActions(hid);
    const parts = [];
    if (settings?.paused) parts.push(T('st_paused'));
    if (!section || section === 'budget') {
      if (!envelopes.length) parts.push(T('st_none'));
      for (const e of envelopes.slice(0, 2)) parts.push(T('st_env', { purpose: e.purpose, left: usd(e.remaining, e.currency), budget: usd(e.budget, e.currency), period: e.period, held: e.held ? usd(e.held, e.currency) : '' }));
    }
    if (!section || section === 'orders') parts.push(open.length ? T('st_open', { n: open.length, names: listWords(open.slice(0, 3).map((o) => o.merchant)) }) : T('st_noopen'));
    if (section === 'preferences') parts.push(preferences.length ? T('st_prefs', { list: listWords(preferences.slice(0, 5).map((p) => `${p.subject}, ${p.fact}`)) }) : T('st_noprefs'));
    if (pending.length) parts.push(T('st_pending', { n: pending.length }));
    return { speech: parts.join(' '), data, card: 'status' };
  }

  // ---------- 2. set_spending_mandate ----------
  async setSpendingMandate(hid, { budget, currency = 'USD', period, auto_approve_under = 0, purpose, fromSettings = false }) {
    budget = round(budget);
    auto_approve_under = round(auto_approve_under || 0);
    if (!(budget > 0) || budget > MAX_BUDGET) throw new ToolError(`The budget must be between $1 and ${usd(MAX_BUDGET)} in this sandbox.`, 'Ask the user for a smaller amount.');
    if (auto_approve_under < 0 || auto_approve_under > budget) throw new ToolError('The auto-approve limit must be between zero and the budget.', 'Ask the user under which amount Mandat may buy without asking.');
    return this.locked(hid, async () => {
      const mid = id('mdt');
      // No PayPal login for the household (nor for judges): with sandbox keys and the demo buyer the owner linked
      // once, the budget pays with that saved sandbox payment token (real sandbox holds, test money); otherwise
      // payments are simulated, and every card says which.
      const buyer = await this.demoBuyer();
      const paypal = buyer
        ? { mode: 'sandbox', paymentTokenId: buyer.paymentTokenId, demo_buyer: true }
        : { mode: 'offline', paymentTokenId: `PTOKEN-${crypto.randomBytes(6).toString('hex').toUpperCase()}` };
      const m = { id: mid, purpose, budget, currency, period, auto_approve_under, created: new Date(this.now()).toISOString(), status: 'active', paypal, ...(period === 'weekly' ? { settings_managed: true } : {}) };
      // One active budget per purpose: a new one replaces the old.
      for (const old of await this.mandates(hid)) {
        if (old.status === 'active' && old.purpose.toLowerCase() === purpose.toLowerCase() && old.period === period) {
          old.status = 'replaced';
          await this.store.put(pkOf(hid), `MANDATE#${old.id}`, old);
        }
      }
      await this.store.put(pkOf(hid), `MANDATE#${mid}`, m);
      await this.event(hid, 'mandate.set', { mandate_id: mid, budget, period, auto_approve_under });
      // A weekly budget said aloud is the same thing as the settings card's weekly budget: keep both in step.
      const st = period === 'weekly' && !fromSettings ? await this.settings(hid) : null;
      if (st) {
        // a weekly budget said aloud replaces the old weekly envelope (one active budget per purpose and period)
        for (const old of await this.mandates(hid)) if (old.id !== mid && old.status === 'active' && old.period === 'weekly' && old.settings_managed) { old.status = 'replaced'; await this.store.put(pkOf(hid), `MANDATE#${old.id}`, old); }
        await this.store.put(pkOf(hid), 'SETTINGS', { ...st, weekly_budget: budget, auto_buy_under: auto_approve_under, daily_cap: Math.max(st.daily_cap, auto_approve_under), updated: new Date(this.now()).toISOString() });
      }
      const env = m.status === 'active' ? this.envelopeView(m, await this.envelopeOf(hid, m)) : null;
      const rule = auto_approve_under > 0 ? T('md_rule_auto', { amt: usd(auto_approve_under, currency) }) : T('md_rule_ask');
      const when = T('md_per', { period });
      const speech = m.status === 'active'
        ? T('md_done', { purpose, budget: usd(budget, currency), per: when, rule })
        : T('md_pending', { purpose, budget: usd(budget, currency), per: when, rule });
      return { speech, data: { mandate: { ...m, paypal: { mode: paypal.mode, demo_buyer: !!paypal.demo_buyer } }, approval_url: null, envelope: env }, card: 'mandate' };
    });
  }
  // ---------- PayPal sandbox demo buyer (linked once by the owner; judges never log in to PayPal) ----------
  async demoBuyer() {
    if (this.paypal.MODE !== 'sandbox') return null;
    return (await this.store.get(PAYPAL_PK, 'DEMO_BUYER')) || null;
  }
  async demoBuyerStatus() {
    const b = await this.demoBuyer();
    return { paypal: this.paypal.MODE, linked: !!b, payer: b?.payer || null, linked_at: b?.linked_at || null };
  }
  // Step 1 (owner only: reached by a direct, IAM-signed Lambda invoke, never by the public URL).
  async startDemoBuyerLink() {
    if (this.paypal.MODE !== 'sandbox') throw new Error('PayPal sandbox keys are not set (run scripts/set-paypal-sandbox.sh first).');
    const setup = await this.paypal.createMandateSetup({ returnUrl: `${this.publicUrl}/paypal/demo-buyer/return`, cancelUrl: `${this.publicUrl}/paypal/demo-buyer/cancel`, description: 'Mandat for Alexa+ demo buyer: sandbox holds for the public demo (test money)' });
    await this.store.put(PAYPAL_PK, 'DEMO_SETUP', { setupId: setup.id, at: new Date(this.now()).toISOString() });
    return { approveUrl: setup.approveUrl };
  }
  // Step 2: PayPal sends the owner back here after he approved with a sandbox personal account.
  async finishDemoBuyerLink(approvalTokenId) {
    const pending = await this.store.get(PAYPAL_PK, 'DEMO_SETUP');
    if (!pending || !approvalTokenId || pending.setupId !== approvalTokenId) throw new ToolError('This approval does not match the demo buyer setup in progress.', 'Run scripts/link-paypal-demo-buyer.sh again.');
    const t = await this.paypal.activateMandate(approvalTokenId);
    const mask = (e) => String(e || '').replace(/^(.).*?(@.*)$/, '$1•••$2');
    const buyer = { paymentTokenId: t.paymentTokenId, payer: mask(t.payer), linked_at: new Date(this.now()).toISOString() };
    await this.store.put(PAYPAL_PK, 'DEMO_BUYER', buyer);
    await this.store.delete(PAYPAL_PK, 'DEMO_SETUP');
    return { linked: true, payer: buyer.payer };
  }

  // PayPal return URL (sandbox mode): the user approved the vault setup token.
  async activateMandate(hid, mid) {
    return this.locked(hid, async () => {
      const m = await this.store.get(pkOf(hid), `MANDATE#${mid}`);
      if (!m) throw new ToolError('Unknown budget.', 'Set it again.');
      if (m.status === 'active') return m;
      const t = await this.paypal.activateMandate(m.paypal.setupId);
      m.status = 'active';
      m.paypal.paymentTokenId = t.paymentTokenId;
      await this.store.put(pkOf(hid), `MANDATE#${mid}`, m);
      await this.event(hid, 'mandate.approved', { mandate_id: mid });
      return m;
    });
  }

  // ---------- 3. remember_preference ----------
  async rememberPreference(hid, { subject, fact }) {
    subject = String(subject).trim().slice(0, 80);
    fact = String(fact).trim().slice(0, 240);
    if (!subject || !fact) throw new ToolError('I need who or what it is about, and the fact to remember.', 'Ask the user to repeat the preference.');
    return this.locked(hid, async () => {
      const prefs = (await this.store.query(pkOf(hid), 'PREF#')).map((r) => r.value);
      let p = prefs.find((x) => x.subject.toLowerCase() === subject.toLowerCase() && x.fact.toLowerCase() === fact.toLowerCase());
      if (!p) {
        p = { id: id('pref'), subject, fact, at: new Date(this.now()).toISOString() };
        await this.store.put(pkOf(hid), `PREF#${p.id}`, p);
        await this.event(hid, 'preference.saved', { subject });
        prefs.push(p);
      }
      // "We drink Northbeam" reads mid-sentence as "we drink Northbeam"; proper nouns ("Max is…") keep their capital.
      const said = /^(We|Our|They|Their|He|She|His|Her|It|Its|My)\b/.test(fact) ? fact[0].toLowerCase() + fact.slice(1) : fact;
      return { speech: T('rem_ok', { subject, fact: said.replace(/[.!]+$/, '') }), data: { saved: p, preferences: prefs }, card: 'status' };
    });
  }

  // ---------- 4. find_home_services ----------
  async findHomeServices(hid, { need, category, when, area, max_price, guests }) {
    const cat = normalizeCategory(category) || normalizeCategory(need);
    if (!cat) throw new ToolError(`I can book cleaning, catering, plumbing and handyman services.`, 'Ask the user which of these they need.');
    guests = guests || parseGuests(need) || null;
    // Caterers price per guest: never quote a dinner for "one" because the number was lost on the way.
    if (cat === 'catering' && !guests) throw new ToolError(T('e_guests'), 'Ask the user, or reuse the guest count of the booking being replaced, then search again with guests.');
    const merchants = search({ category: cat, area }).map((p) => merchantById(p.id));
    const sid = id('srch');
    // Each merchant agent answers on its own: the screen shows every answer the moment it lands.
    const answers = await Promise.all(merchants.map(async (m) => {
      await this.live({ step: `q-${sid}-${m.id}`, state: 'running', text: T('l_asking', { m: m.name }), image_url: mediaFor({ kind: 'service', merchant_id: m.id }, this.publicUrl).image_url });
      const r = await this.provider.merchantAgent({ merchant: m, when, ask: need, guests });
      const quote = guardQuote(m, r.quote, guests);
      const verified = verifyCard(identityCard(m));
      await this.live(quote
        ? { step: `q-${sid}-${m.id}`, state: 'done', text: m.name, detail: `${quote.slotLabel ? I.slot(usTime(quote.slotLabel), loc()) : ''}${verified ? ' · ' + T('l_verified') : ''}`, from: quote.discount ? round(quote.base) : null, to: round(quote.total), image_url: mediaFor({ kind: 'service', merchant_id: m.id }, this.publicUrl).image_url }
        : { step: `q-${sid}-${m.id}`, state: 'failed', text: m.name, detail: firstSentence(r.reply), image_url: mediaFor({ kind: 'service', merchant_id: m.id }, this.publicUrl).image_url });
      return { m, r, quote };
    }));
    const now = this.now();
    const offers = [];
    const declined = [];
    for (const { m, r, quote } of answers) {
      if (!quote) { declined.push({ merchant: m.name, reply: r.reply }); continue; }
      if (max_price && quote.total > max_price) { declined.push({ merchant: m.name, reply: `Above your ${usd(max_price)} limit (${usd(quote.total)}).` }); continue; }
      const card = identityCard(m);
      offers.push({
        id: id('off'), kind: 'service', merchant_id: m.id, merchant: m.name, category: m.category, area: m.area, rating: m.rating,
        title: m.label, slot_label: quote.slotLabel, guests: quote.guests, when: when || '',
        base: round(quote.base), discount: round(quote.discount), fees: 0, tax: 0, total: round(quote.total), currency: 'USD',
        negotiation: r.reply, conditions: quote.conditions || '',
        card_verified: verifyCard(card), agent: card.agent, card_issuer: card.issuedBy, search_id: sid,
        history: [{ from: 'merchant', list: round(quote.base), total: round(quote.total), text: r.reply }],
        ...mediaFor({ kind: 'service', merchant_id: m.id }, this.publicUrl),
        created: new Date(now).toISOString(), expires: new Date(now + OFFER_TTL).toISOString(),
      });
    }
    offers.sort((a, b) => a.total - b.total || b.rating - a.rating);
    const top = offers.filter((o) => o.card_verified).slice(0, 5);
    if (!top.length) {
      const d = parseWhen(when).day;
      throw new ToolError(T('e_no_service', { noun: nounOf(cat, 1), day: d ? I.dayName(DAY_NAMES[d], loc()) : '', max: max_price ? usd(max_price) : '' }), 'Suggest another day or a higher limit to the user.');
    }
    for (const o of top) await this.store.put(pkOf(hid), `OFFER#${o.id}`, o);
    await this.store.put(pkOf(hid), `SEARCH#${sid}`, { id: sid, kind: 'service', category: cat, when: when || '', guests: guests || null, asked: answers.length, offer_ids: top.map((o) => o.id), declined: declined.length, at: new Date(now).toISOString() });
    const spoken = top.slice(0, 3).map((o, i) => T('svc_line', { n: top.length, i, merchant: o.merchant, total: usd(o.total), slot: spokenSlot(o.slot_label), base: o.discount ? usd(o.base) : '' }));
    return {
      speech: `${answers.length === 1 ? T('svc_one', { one: nounOf(cat, 1) }) : T('svc_many', { n: answers.length, label: nounOf(cat, answers.length) })} ${spoken.join('. ')}.`,
      data: { category: cat, asked: answers.length, offers: top, declined },
      card: 'offers',
    };
  }

  // ---------- 5. find_products ----------
  async findProducts(hid, { query, max_price, quantity = 1 }) {
    quantity = Math.max(1, Math.min(10, Math.floor(quantity || 1)));
    const prefs = (await this.store.query(pkOf(hid), 'PREF#')).map((r) => r.value);
    const banned = new Map(); // ingredient -> reason
    for (const p of prefs) {
      // the fact may be in English, French or Spanish ("allergic to chicken", "allergique au poulet", "alérgico al pollo")
      const who = p.subject.replace(/\s*\(.*\)\s*/, '');
      const reason = T('because', { who, fact: p.fact.replace(/\.$/, '') }).replace(/\s+/g, ' ');
      for (const w of I.allergensOf(p.fact)) banned.set(w.toLowerCase(), reason);
    }
    let found;
    if (shopEnabled()) {
      const live = await searchProducts({ query, maxPrice: max_price, limit: 8, userId: hid });
      found = live.map((p) => ({ id: p.id, shop: 'shop_' + p.retailer, shopName: p.retailer, title: p.title, price: p.price, delivery: 0, contains: [p.title.toLowerCase()], tags: [] }));
    } else found = searchCatalog({ query, maxPrice: max_price });
    const skipped = [];
    const ok = found.filter((p) => {
      const hit = [...banned.keys()].find((b) => p.contains.some((c) => c.includes(b)) || p.title.toLowerCase().includes(b));
      if (hit) skipped.push({ title: p.title, ingredient: hit, because: banned.get(hit) });
      return !hit;
    });
    // Household brand/product preferences go first.
    const liked = (p) => prefs.some((x) => (p.brand && x.fact.toLowerCase().includes(p.brand.toLowerCase())));
    ok.sort((a, b) => Number(liked(b)) - Number(liked(a)));
    if (!ok.length) throw new ToolError(T('e_nothing', { q: query, prefs: skipped.length > 0 }), 'Ask the user for another product or a higher price limit.');
    const now = this.now();
    const sid = id('srch');
    const offers = ok.slice(0, 5).map((p) => ({
      id: id('off'), kind: 'product', merchant_id: p.shop, merchant: p.shopName, product_id: p.id, title: p.title, quantity,
      base: round(p.price * quantity), discount: 0, fees: round(p.delivery || 0), tax: 0, total: round(p.price * quantity + (p.delivery || 0)), currency: 'USD',
      matches_preference: liked(p), slot_label: 'Delivery in 2 days', search_id: sid, contains: p.contains || [], unit_price: round(p.price),
      product_category: p.category || 'home', product_type: p.type || null, features: p.features || [],
      ...mediaFor({ kind: 'product', product_id: p.id }, this.publicUrl),
      created: new Date(now).toISOString(), expires: new Date(now + OFFER_TTL).toISOString(),
    }));
    for (const o of offers) await this.store.put(pkOf(hid), `OFFER#${o.id}`, o);
    await this.store.put(pkOf(hid), `SEARCH#${sid}`, { id: sid, kind: 'product', query, asked: found.length, offer_ids: offers.map((o) => o.id), skipped, at: new Date(now).toISOString() });
    const best = offers[0];
    const skip = skipped.length ? T('prod_skip', { n: skipped.length, ingredients: listWords([...new Set(skipped.map((x) => P(x.ingredient)))]), because: skipped[0].because }) : '';
    return {
      speech: T('prod_best', { usual: best.matches_preference, title: P(best.title), total: usd(best.total), merchant: best.merchant, skip }),
      data: { query, offers, skipped, source: shopEnabled() ? 'channel3' : 'sandbox catalogue' },
      card: 'offers',
    };
  }

  // ---------- 6. negotiate_offer ----------
  async negotiateOffer(hid, { offer_id, ask }) {
    const o = await this.offer(hid, offer_id);
    if (o.kind !== 'service') throw new ToolError('Online shop prices are fixed, so there is nothing to negotiate.', 'Offer another product or go ahead with this price.');
    const m = merchantById(o.merchant_id);
    const r = await this.provider.merchantAgent({ merchant: m, when: `${o.when} ${ask}`, ask, guests: o.guests });
    const quote = guardQuote(m, r.quote, o.guests);
    if (!quote) return { speech: T('neg_says', { m: m.name, reply: r.reply }), data: { offer: o, merchant_reply: r.reply, changed: false }, card: 'offers' };
    const before = o.total;
    Object.assign(o, { base: round(quote.base), discount: round(quote.discount), total: round(quote.total), slot_label: quote.slotLabel, negotiation: r.reply, conditions: quote.conditions || '', expires: new Date(this.now() + OFFER_TTL).toISOString() });
    o.history = [...(o.history || []), { from: 'mandat', text: ask }, { from: 'merchant', list: round(quote.base), total: round(quote.total), text: r.reply }];
    await this.live({ step: `n-${o.id}-${(o.history || []).length}`, state: 'done', text: T('l_negotiated', { m: m.name }), from: before, to: o.total, image_url: o.image_url });
    if (quote.slotLabel) o.when = quote.slotLabel;
    await this.store.put(pkOf(hid), `OFFER#${o.id}`, o);
    const delta = before - o.total;
    return {
      speech: delta > 0 ? T('neg_agreed', { m: m.name, total: usd(o.total), before: usd(before), slot: spokenSlot(o.slot_label) }) : T('neg_says', { m: m.name, reply: r.reply }),
      data: { offer: o, previous_total: before, changed: delta !== 0, merchant_reply: r.reply, offers: [o] },
      card: 'offers',
    };
  }
  async offer(hid, oid) {
    const o = await this.store.get(pkOf(hid), `OFFER#${oid}`);
    if (!o) throw new ToolError(T('e_gone'), 'Search again with find_home_services or find_products.');
    if (Date.parse(o.expires) < this.now()) throw new ToolError(T('e_expired_quote', { m: o.merchant }), 'Search again to get a fresh quote.');
    return o;
  }

  // ---------- 7. propose_plan ----------
  async proposePlan(hid, { item_ids, mandate_id, note }) {
    const ids = [...new Set(item_ids || [])];
    if (!ids.length) throw new ToolError('A plan needs at least one option.', 'Pick options from the last search.');
    const offers = [];
    for (const oid of ids) offers.push(await this.offer(hid, oid));
    const settings = await this.settings(hid);
    if (settings?.paused) throw new ToolError(T('e_paused'), 'Tell the user Mandat is paused; they can say "resume Mandat".');
    const m = await this.mandate(hid, mandate_id);
    const env = await this.envelopeOf(hid, m);
    const lines = offers.map((o) => ({ offer_id: o.id, kind: o.kind, category: o.category ?? null, merchant: o.merchant, merchant_id: o.merchant_id, title: o.title, detail: o.slot_label, guests: o.guests ?? null, quantity: o.quantity ?? null, base: o.base, discount: o.discount, fees: o.fees, tax: o.tax, total: o.total, search_id: o.search_id || null, product_category: o.product_category ?? null, ...(o.image_url ? { image_url: o.image_url, image_alt: o.image_alt } : {}) }));
    const sum = (k) => round(lines.reduce((s, l) => s + (l[k] || 0), 0));
    const breakdown = { base: sum('base'), discount: sum('discount'), fees: sum('fees'), tax: sum('tax'), total: sum('total'), currency: m.currency };
    const verdict = envelope.check(env, breakdown.total);
    const t = envelope.totals(env);
    // Bounded autonomy is per item: bundling a small restock with a big one would hide it behind a yes.
    const auto = Number(m.auto_approve_under) || 0;
    if (auto > 0 && lines.length > 1 && lines.every((l) => l.kind === 'product') && breakdown.total > auto && lines.some((l) => l.total <= auto)) {
      throw new ToolError(T('e_split', { amt: usd(auto) }), 'Call propose_plan once per product.');
    }
    if (!verdict.ok) {
      throw new ToolError(T('e_over', { total: usd(breakdown.total), left: usd(t.remaining), purpose: m.purpose }), 'Drop an item, pick cheaper options, or ask the user to raise the budget with set_spending_mandate.');
    }
    // The household's own rules (settings): categories turned off are never bought; autonomy decides who says yes.
    const blocked = S.blockedLines(settings, lines);
    if (blocked.length) throw new ToolError(T('e_category_off', { cats: listWords([...new Set(blocked.map((l) => T('cat_' + S.categoryOf(l))))]) }), 'Tell the user; they can turn the category on in Mandat settings.');
    const autonomy = S.autonomyVerdict({ settings, threshold: auto, total: breakdown.total, autoSpentToday: await this.autoSpentToday(hid) });
    const token = crypto.randomBytes(16).toString('hex');
    const plan = {
      id: id('plan'), mandate_id: m.id, purpose: m.purpose, lines, breakdown, note: note || '', status: 'proposed',
      auto_approved: settings ? autonomy.auto : !verdict.needsApproval, auto_reason: autonomy.reason, token_hash: sha(token),
      remaining_after: round(t.remaining - breakdown.total), budget: t.total,
      created: new Date(this.now()).toISOString(), expires: new Date(this.now() + PLAN_TTL).toISOString(),
    };
    await this.store.put(pkOf(hid), `PLAN#${plan.id}`, plan);
    await this.event(hid, 'plan.proposed', { plan_id: plan.id, total: breakdown.total, auto_approved: plan.auto_approved });
    const items = lines.map((l) => `${l.merchant} ${usd(l.total)}`);
    const speech = plan.auto_approved
      ? T(plan.auto_reason === 'hands_off' ? 'plan_auto_hands_off' : 'plan_auto', { items: listWords(items), total: usd(breakdown.total), auto: usd(m.auto_approve_under), cap: usd(settings?.daily_cap || 0) })
      : T('plan_ask', { items: listWords(items), total: usd(breakdown.total), discount: breakdown.discount ? usd(breakdown.discount) : '', left: usd(plan.remaining_after), budget: usd(t.total), why: settings ? T('ask_why_' + autonomy.reason, { amt: usd(auto), left: usd(autonomy.left ?? 0) }) : '' });
    const { token_hash, ...pub } = plan;
    return { speech, data: { plan: pub, confirmation_token: token, needs_user_yes: !plan.auto_approved, envelope: this.envelopeView(m, env), autonomy: settings ? { level: settings.autonomy, reason: autonomy.reason } : undefined }, card: 'plan' };
  }

  // ---------- 8. confirm_plan ----------
  async confirmPlan(hid, { plan_id, confirmation_token, user_confirmation }) {
    return this.locked(hid, async () => {
      const plan = await this.store.get(pkOf(hid), `PLAN#${plan_id}`);
      if (!plan) throw new ToolError('I cannot find that plan.', 'Propose the plan again with propose_plan.');
      if (!sameHash(sha(confirmation_token || ''), plan.token_hash)) throw new ToolError('That confirmation does not match this plan, so I did not pay anything.', 'Use the confirmation token returned by propose_plan for this exact plan.');
      // Idempotency: a confirmed plan returns its receipt again, without a second hold.
      const prior = await this.store.get(pkOf(hid), `IDEMP#${plan.id}`);
      if (prior?.receipt) return { ...(await this.receipt(hid, prior.receipt.order_ids, T('already'))), duplicate: true };
      // Only the plan the user is looking at can be paid: a revised (swapped) or dropped plan is dead with its token.
      if (plan.status !== 'proposed') throw new ToolError(plan.status === 'revised' ? T('e_changed') : `That plan is ${plan.status}, so I did not pay anything.`, plan.status === 'revised' ? `Use the newer plan ${plan.revised_to} and its confirmation_token from revise_plan.` : 'Call review_plan or get_household_status.');
      if (Date.parse(plan.expires) < this.now()) throw new ToolError('This plan expired before it was confirmed.', 'Propose it again so prices are fresh.');
      const settings = await this.settings(hid);
      // Emergency stop: nothing is bought while Mandat is paused, not even with a yes.
      if (settings?.paused) throw new ToolError(T('e_paused'), 'Tell the user Mandat is paused; they can say "resume Mandat".');
      const m = await this.mandate(hid, plan.mandate_id);
      // Autonomy is checked again now: the daily limit may have been used since the proposal, or the level changed.
      let alone = plan.auto_approved;
      if (alone && settings) alone = S.autonomyVerdict({ settings, threshold: Number(m.auto_approve_under) || 0, total: plan.breakdown.total, autoSpentToday: await this.autoSpentToday(hid) }).auto;
      if (!alone && !isExplicitYes(user_confirmation)) {
        throw new ToolError(T('e_need_yes', { total: usd(plan.breakdown.total) }), 'Read the total aloud, ask the user to say yes, then call confirm_plan with their words in user_confirmation.');
      }
      // Booking at home or delivering needs an address: only when this household linked through Alexa and did not
      // share it (an old household without a profile keeps working as before).
      const profile = await this.profile(hid);
      if (profile?.permissions && !profile.address) throw new ToolError(T('e_need_address'), 'Tell the user to allow the address for Mandat in the Alexa app (Mandat > Manage), then say yes again.');
      if (!m.paypal?.paymentTokenId) throw new ToolError('The budget is not approved with PayPal yet.', 'Ask the user to open the approval link once.');
      const env = await this.envelopeOf(hid, m);
      const verdict = envelope.check(env, plan.breakdown.total); // re-checked: money may have moved since the proposal
      if (!verdict.ok) throw new ToolError(T('e_left_now', { left: usd(envelope.totals(env).remaining), total: usd(plan.breakdown.total) }), 'Propose a smaller plan.');
      if (!settings && verdict.needsApproval && !isExplicitYes(user_confirmation)) throw new ToolError('This plan needs your explicit yes.', 'Ask the user to confirm.');
      if (!(await this.store.putIfAbsent(pkOf(hid), `IDEMP#${plan.id}`, { at: new Date(this.now()).toISOString() }))) {
        throw new ToolError('This plan is already being booked.', 'Wait a moment and call get_household_status.');
      }
      const orders = [];
      try {
        for (const [i, l] of plan.lines.entries()) {
          const oid = id('ord');
          const pp = await this.paypal.hold({ mode: m.paypal.mode, paymentTokenId: m.paypal.paymentTokenId, amount: l.total, currency: m.currency, merchant: l.merchant, description: `${l.title} (${l.detail})`, reference: `${plan.id}-${i}` });
          envelope.hold(env, { id: oid, merchant: l.merchant, label: l.title, amount: l.total, paypal: pp });
          await this.live({ step: `h-${oid}`, state: 'done', text: T('l_holding', { amt: usd(l.total), m: l.merchant }), detail: T('l_not_charged'), image_url: l.image_url });
          const at = new Date(this.now()).toISOString();
          orders.push({
            id: oid, plan_id: plan.id, mandate_id: m.id, kind: l.kind, category: l.category ?? null, merchant_id: l.merchant_id, merchant: l.merchant, label: l.title, slotLabel: l.detail,
            guests: l.guests, quantity: l.quantity, amount: l.total, currency: m.currency, state: 'held', paypal: { orderId: pp.orderId, authorizationId: pp.authorizationId, mode: pp.mode },
            close_token: crypto.randomBytes(12).toString('hex'), timeline: [{ state: 'held', amount: l.total, at }], auto: !!alone && !isExplicitYes(user_confirmation),
            ...(profile?.address ? { deliver_to: profile.address.line1 } : {}),
            ...(l.image_url ? { image_url: l.image_url, image_alt: l.image_alt } : {}),
          });
        }
      } catch (e) {
        // A hold failed half-way: void what was already held, leave nothing behind.
        for (const o of orders) { try { await this.paypal.release({ mode: o.paypal.mode, authorizationId: o.paypal.authorizationId }); } catch {} }
        await this.store.delete(pkOf(hid), `IDEMP#${plan.id}`);
        throw new ToolError(`PayPal refused the payment hold (${e.message}). Nothing was charged.`, 'Try again in a minute or pick another option.');
      }
      for (const o of orders) await this.store.put(pkOf(hid), `ORDER#${o.id}`, o);
      await this.saveEnvelope(hid, m, env);
      plan.status = 'confirmed';
      plan.confirmed_with = alone && !isExplicitYes(user_confirmation) ? 'auto-approve rule' : String(user_confirmation).slice(0, 80);
      await this.store.put(pkOf(hid), `PLAN#${plan.id}`, plan);
      await this.store.put(pkOf(hid), `IDEMP#${plan.id}`, { receipt: { order_ids: orders.map((o) => o.id) } });
      await this.event(hid, 'plan.confirmed', { plan_id: plan.id, total: plan.breakdown.total, orders: orders.length, how: plan.confirmed_with });
      const t = envelope.totals(env);
      const n = orders.length;
      const speech = T('booked', { auto: plan.confirmed_with === 'auto-approve rule', n, total: usd(plan.breakdown.total), left: usd(t.remaining), purpose: m.purpose });
      return this.receipt(hid, orders.map((o) => o.id), speech, { idempotency_key: plan.id });
    });
  }

  async receipt(hid, orderIds, speech, extra = {}) {
    const orders = [];
    for (const oid of orderIds) { const o = await this.store.get(pkOf(hid), `ORDER#${oid}`); if (o) orders.push(o); }
    const m = orders[0] ? (await this.mandates(hid)).find((x) => x.id === orders[0].mandate_id) : null;
    const env = m ? this.envelopeView(m, await this.envelopeOf(hid, m)) : null;
    return { speech, data: { receipt: { orders: orders.map((o) => ({ ...publicOrder(o), close_token: o.close_token })), envelope: env, ...extra } }, card: 'receipt' };
  }
  async order(hid, oid) {
    const o = await this.store.get(pkOf(hid), `ORDER#${oid}`);
    if (!o) throw new ToolError('I cannot find that order.', 'Call get_household_status to list open orders.');
    return o;
  }

  // ---------- 9. change_order ----------
  async changeOrder(hid, { order_id, change }) {
    return this.locked(hid, async () => {
      const o = await this.order(hid, order_id);
      if (o.state !== 'held') throw new ToolError(`That order is already ${o.state}, so it cannot be changed.`, 'Book a new one instead.');
      if (o.kind !== 'service') throw new ToolError('Shop orders cannot be changed once placed.', 'Cancel it with close_order and buy again.');
      const mer = merchantById(o.merchant_id);
      const r = await this.provider.merchantChange({ merchant: mer, order: o, change });
      // Server-side truth over any model: a move to a day the merchant is closed is a decline.
      if (r.accepted && change.field === 'date') {
        const d = parseWhen(String(change.value)).day;
        if (d && !mer.open.includes(d)) Object.assign(r, { accepted: false, reply: merchantSay(loc(), 'closed_move', { day: I.dayName(DAY_NAMES[d], loc()) }) });
      }
      const m = (await this.mandates(hid)).find((x) => x.id === o.mandate_id);
      const env = await this.envelopeOf(hid, m);
      const at = new Date(this.now()).toISOString();
      if (r.accepted) {
        const total = round(r.total ?? o.amount);
        if (total > o.amount + 1e-9) throw new ToolError(`${mer.name} would charge ${usd(total)}, more than the ${usd(o.amount)} you approved.`, 'Ask the user to approve a new plan for the difference.');
        if (r.slotLabel) o.slotLabel = r.slotLabel;
        if (r.guests) o.guests = r.guests;
        if (total < o.amount) o.expected_total = total; // captured later for less; the rest is released
        o.timeline.push({ state: 'changed', note: `${change.field}: ${change.value}`, at });
        await this.store.put(pkOf(hid), `ORDER#${o.id}`, o);
        await this.event(hid, 'order.changed', { order_id: o.id, change, merchant: o.merchant });
        await this.live({ step: `c-${o.id}`, state: 'done', text: T('l_moved', { m: mer.name }), detail: I.slot(usTime(o.slotLabel || ''), loc()), image_url: o.image_url });
        return { ...(await this.receipt(hid, [o.id], T('chg_agreed', { m: mer.name, slot: spokenSlot(o.slotLabel), amount: usd(o.amount) }))), accepted: true };
      }
      // Declined: void the hold so the money is free again, then line up a replacement.
      await this.live({ step: `c-${o.id}`, state: 'failed', text: T('l_cant_move', { m: mer.name }), detail: firstSentence(r.reply), image_url: o.image_url });
      const pp = await this.paypal.release({ mode: o.paypal.mode, authorizationId: o.paypal.authorizationId });
      await this.live({ step: `r-${o.id}`, state: 'done', text: T('l_released', { amt: usd(o.amount) }), detail: T('l_nothing') });
      envelope.release(env, o.id, pp);
      o.state = 'released';
      o.timeline.push({ state: 'released', amount: o.amount, note: `${mer.name} declined: ${r.reply}`, at });
      await this.store.put(pkOf(hid), `ORDER#${o.id}`, o);
      await this.saveEnvelope(hid, m, env);
      await this.event(hid, 'order.released', { order_id: o.id, reason: 'merchant declined change', merchant: o.merchant, amount: o.amount });
      let alternatives = [];
      if (change.field === 'date') {
        try {
          const found = await this.findHomeServices(hid, { need: `${mer.category} for ${o.guests || ''} guests`, category: mer.category, when: change.value, guests: o.guests });
          alternatives = found.data.offers.filter((x) => x.merchant_id !== mer.id).slice(0, 3);
        } catch { alternatives = []; }
      }
      const rec = await this.receipt(hid, [o.id], '');
      const alt = alternatives[0];
      rec.speech = T('chg_declined', { m: mer.name, reply: r.reply, amount: usd(o.amount), alt: alt?.merchant || '', altSlot: alt ? spokenSlot(alt.slot_label) : '', altTotal: alt ? usd(alt.total) : '' });
      rec.data.alternatives = alternatives;
      rec.accepted = false;
      return rec;
    });
  }

  // ---------- 10. close_order ----------
  async closeOrder(hid, { order_id, action, amount, confirmation_token }) {
    return this.locked(hid, async () => {
      const o = await this.order(hid, order_id);
      if (!sameHash(String(confirmation_token || ''), o.close_token)) throw new ToolError('That confirmation does not match this order, so nothing moved.', 'Use the close token from this order\'s receipt.');
      const m = (await this.mandates(hid)).find((x) => x.id === o.mandate_id);
      const env = await this.envelopeOf(hid, m);
      const at = new Date(this.now()).toISOString();
      let speech;
      if (action === 'capture') {
        if (o.state !== 'held') throw new ToolError(`That order is ${o.state}; only a held payment can be captured.`, 'Check the order with get_household_status.');
        const take = round(amount ?? o.expected_total ?? o.amount);
        if (!(take > 0) || take > o.amount + 1e-9) throw new ToolError(`I can capture at most the ${usd(o.amount)} on hold.`, 'Capture a smaller amount or approve a new plan for the difference.');
        const pp = await this.paypal.capture({ mode: o.paypal.mode, authorizationId: o.paypal.authorizationId, amount: take < o.amount ? take : undefined, currency: o.currency });
        envelope.capture(env, o.id, pp, take);
        Object.assign(o, { state: 'captured', captured: take, paypal: { ...o.paypal, captureId: pp.captureId } });
        o.timeline.push({ state: 'captured', amount: take, at });
        if (take < o.amount) o.timeline.push({ state: 'released', amount: round(o.amount - take), note: 'rest of the hold released', at });
        speech = take < o.amount ? T('cap_partial', { m: o.merchant, take: usd(take), diff: usd(o.amount - take) }) : T('cap_full', { m: o.merchant, take: usd(take) });
      } else if (action === 'cancel') {
        if (o.state !== 'held') throw new ToolError(`That order is ${o.state}; only a held payment can be cancelled. A paid order can be refunded.`, 'Use action refund instead.');
        const pp = await this.paypal.release({ mode: o.paypal.mode, authorizationId: o.paypal.authorizationId });
        envelope.release(env, o.id, pp);
        o.state = 'released';
        o.timeline.push({ state: 'released', amount: o.amount, note: 'cancelled', at });
        speech = T('cancelled', { m: o.merchant, amount: usd(o.amount) });
      } else if (action === 'refund') {
        // A part refund on an order still on hold means "delivered, part sent back": settle the hold, then refund.
        let settled = '';
        if (o.state === 'held' && amount > 0 && amount < o.amount - 1e-9) {
          const take = round(o.expected_total ?? o.amount);
          const pc = await this.paypal.capture({ mode: o.paypal.mode, authorizationId: o.paypal.authorizationId, amount: take < o.amount ? take : undefined, currency: o.currency });
          envelope.capture(env, o.id, pc, take);
          Object.assign(o, { state: 'captured', captured: take, paypal: { ...o.paypal, captureId: pc.captureId } });
          o.timeline.push({ state: 'captured', amount: take, note: 'settled before a part refund', at });
          settled = T('settled_pre', { m: o.merchant, take: usd(take) });
        }
        if (o.state !== 'captured') throw new ToolError(`That order is ${o.state}; only a paid order can be refunded.`, o.state === 'held' ? 'If it was delivered, capture it first (close_order capture), then refund the amount; to call the whole order off, use cancel.' : 'Check the order with get_household_status.');
        const paid = round((o.captured ?? o.amount) - (o.refunded || 0));
        const back = round(amount ?? paid);
        if (!(back > 0) || back > paid + 1e-9) throw new ToolError(`At most ${usd(paid)} can be refunded on this order.`, 'Refund a smaller amount.');
        const pp = await this.paypal.refund({ mode: o.paypal.mode, captureId: o.paypal.captureId, amount: back, currency: o.currency, note: 'Mandat for Alexa+ refund' });
        envelope.refund(env, o.id, back, pp);
        o.refunded = round((o.refunded || 0) + back);
        if (o.refunded >= (o.captured ?? o.amount) - 1e-9) o.state = 'refunded';
        o.timeline.push({ state: 'refunded', amount: back, at });
        speech = T('refund', { settled, back: usd(back), m: o.merchant });
      } else throw new ToolError('The action must be capture, cancel or refund.', 'Pick one.');
      await this.store.put(pkOf(hid), `ORDER#${o.id}`, o);
      await this.saveEnvelope(hid, m, env);
      await this.event(hid, `order.${action}`, { order_id: o.id, amount: amount ?? o.amount, merchant: o.merchant });
      const t = envelope.totals(env);
      return this.receipt(hid, [o.id], `${speech} ${T('left_in', { left: usd(t.remaining), purpose: m.purpose })}`);
    });
  }

  // ---------- 11. get_offer_details ("show me the bed linen", "why this one?") ----------
  async siblings(hid, o) {
    if (!o.search_id) return [o];
    const rows = (await this.store.query(pkOf(hid), 'OFFER#')).map((r) => r.value).filter((x) => x.search_id === o.search_id && Date.parse(x.expires) > this.now());
    return rows.sort((a, b) => a.total - b.total || (b.rating || 0) - (a.rating || 0));
  }
  async pendingPlan(hid, plan_id) {
    const plans = (await this.store.query(pkOf(hid), 'PLAN#')).map((r) => r.value).filter((p) => p.status === 'proposed' && Date.parse(p.expires) > this.now());
    if (plan_id) return plans.find((p) => p.id === plan_id) || null;
    return plans.sort((a, b) => b.created.localeCompare(a.created))[0] || null;
  }
  // Why this option, in facts the household can check (no marketing). Each fact has a tone the card shows honestly:
  //   plus  a real advantage (green dot)    cost  a price disadvantage (amber, never green)    info  neutral
  // Prices are compared only with options of the same kind (sheet sets with sheet sets, not with towels), and an
  // option that is not the cheapest says what it costs more AND what it is chosen for.
  whyOf(o, sibs, search, { inPlan = false } = {}) {
    const why = [];
    const same = o.kind === 'product' && o.product_type ? sibs.filter((x) => x.product_type === o.product_type) : sibs;
    const n = same.length;
    const cheapest = [...same].sort((a, b) => a.total - b.total)[0];
    const name = (x) => (x.kind === 'service' ? x.merchant : P(x.title).split(/[:：(]/)[0].trim());
    const noun = nounOf(o.kind === 'service' ? o.category : 'products', n);
    // what it is chosen for (the item's own qualities), first
    const quality = o.kind === 'service'
      ? [o.rating && n > 1 && o.rating >= Math.max(...same.map((x) => x.rating || 0)) ? T('why_q_rated', { r: o.rating }) : '', o.slot_label ? spokenSlot(o.slot_label) : ''].filter(Boolean)
      : [...(o.features || []).slice(0, 2).map((f) => P(f)), P('delivery in 2 days')];
    const notCheapest = n > 1 && cheapest && cheapest.id !== o.id && o.total > cheapest.total;
    if (quality.length && (notCheapest || o.kind === 'product')) why.push({ tone: 'plus', text: T(inPlan ? 'why_chosen_for' : 'why_offers', { list: listWords(quality) }) });
    if (n > 1 && !notCheapest) why.push({ tone: 'plus', text: o.kind === 'service' ? T('why_cheapest', { n, noun }) : T('why_cheapest_similar', { n }) });
    if (o.kind === 'service' && !notCheapest && n > 1 && o.rating && o.rating >= Math.max(...same.map((x) => x.rating || 0))) why.push({ tone: 'plus', text: T('why_rated', { r: o.rating }) });
    if (notCheapest) why.push({ tone: 'cost', text: T('why_costs_more', { diff: usd(o.total - cheapest.total), name: name(cheapest), n }) });
    if (o.discount) why.push({ tone: 'plus', text: T('why_off', { amt: usd(o.discount), deal: o.conditions ? I.dealOf(o.conditions, loc()) : '' }) });
    if (o.matches_preference) why.push({ tone: 'plus', text: T('why_usual') });
    const skipped = search?.skipped || [];
    if (skipped.length) why.push({ tone: 'plus', text: T('why_skipped', { n: skipped.length, ing: listWords([...new Set(skipped.map((x) => P(x.ingredient)))]), because: skipped[0].because }) });
    if (o.kind === 'service' && o.card_verified) why.push({ tone: 'info', text: T('why_verified') });
    return why;
  }
  async ruleFor(hid, o, plan) {
    let m = null;
    try { m = await this.mandate(hid, plan?.mandate_id); } catch { return null; }
    const env = this.envelopeView(m, await this.envelopeOf(hid, m));
    const auto = Number(m.auto_approve_under) || 0;
    const under = auto > 0 && o.total <= auto;
    return { auto_approve_under: auto, buys_on_its_own: under, text: under ? T('rule_auto', { amt: usd(auto) }) : auto > 0 ? T('rule_above', { amt: usd(auto) }) : T('rule_always'), envelope: env };
  }
  async getOfferDetails(hid, { offer_id }) {
    const o = await this.offer(hid, offer_id);
    const sibs = await this.siblings(hid, o);
    const search = o.search_id ? await this.store.get(pkOf(hid), `SEARCH#${o.search_id}`) : null;
    const plan = await this.pendingPlan(hid);
    const inPlan = !!plan?.lines.some((l) => l.offer_id === o.id);
    const why = this.whyOf(o, sibs, search, { inPlan });
    const addr = (await this.profile(hid))?.address?.line1 || '';
    const rule = await this.ruleFor(hid, o, plan);
    const m = o.kind === 'service' ? merchantById(o.merchant_id) : null;
    const L = loc();
    const specs = o.kind === 'service'
      ? [{ k: T('spec_what'), v: P(o.title) }, { k: T('spec_when'), v: I.slot(o.slot_label, L) }, ...(o.guests ? [{ k: T('spec_guests'), v: T('spec_per_guest', { n: o.guests, price: usd(m.price) }) }] : []), { k: T('spec_where'), v: addr ? T('spec_at_home', { addr }) : T('spec_area', { area: o.area, r: o.rating }) }, { k: T('spec_about'), v: P(m.pitch) }]
      : [{ k: T('spec_what'), v: P(o.title) }, { k: T('spec_delivery'), v: `${o.fees ? T('spec_fee', { slot: I.slot(o.slot_label, L), fee: usd(o.fees) }) : T('spec_free', { slot: I.slot(o.slot_label, L) })}${addr ? T('spec_to', { addr }) : ''}` }, ...(o.contains?.length ? [{ k: T('spec_made'), v: listWords(o.contains.map(P)) }] : []), ...(o.quantity > 1 ? [{ k: T('spec_qty'), v: String(o.quantity) }] : [])];
    const history = (o.history || []).map((h) => ({ ...h }));
    const what = P(o.title);
    const lead = o.kind === 'service'
      ? T('det_svc', { m: o.merchant, total: usd(o.total), what: what.charAt(0).toLowerCase() + what.slice(1), slot: spokenSlot(o.slot_label) })
      : T('det_prod', { title: what, total: usd(o.total), m: o.merchant });
    // say the reason, and the trade-off when there is one (a higher price is never presented as an advantage)
    const said = [why.find((w) => w.tone === 'plus'), why.find((w) => w.tone === 'cost')].filter(Boolean).map((w) => w.text + '.').join(' ');
    const speech = `${lead} ${said}${inPlan ? ' ' + T('in_plan') : ''}`.replace(/\s+/g, ' ').trim();
    return { speech, data: { mode: 'detail', offer: o, images: galleryFor(o, this.publicUrl), specs, why, rule, history, in_plan: inPlan, plan_id: plan?.id || null, alternatives: sibs.filter((x) => x.id !== o.id).length }, card: 'item' };
  }

  // ---------- 12. list_alternatives ("other options?", "something cheaper") ----------
  async listAlternatives(hid, { offer_id, cheaper_only = false }) {
    const o = await this.offer(hid, offer_id);
    const sibs = await this.siblings(hid, o);
    const others = sibs.filter((x) => x.id !== o.id && (!cheaper_only || x.total < o.total));
    const noun = nounOf(o.kind === 'service' ? o.category : 'products', sibs.length);
    if (!others.length) {
      const speech = cheaper_only ? T('alt_cheapest', { name: o.kind === 'service' ? o.merchant : P(o.title), n: sibs.length, noun }) : T('alt_none');
      return { speech, data: { offers: sibs, current_offer_id: o.id, category: o.category, asked: sibs.length }, card: 'offers' };
    }
    const said = others.slice(0, 3).map((x) => `${x.kind === 'service' ? x.merchant : P(x.title)}, ${usd(x.total)}${x.kind === 'service' ? ' ' + spokenSlot(x.slot_label) : ''}`);
    return { speech: T('alt_list', { n: others.length, items: said.join('; ') }), data: { offers: [o, ...others], current_offer_id: o.id, category: o.category, asked: sibs.length }, card: 'offers' };
  }

  // ---------- 13. compare_offers ("compare the two caterers") ----------
  async compareOffers(hid, { offer_ids }) {
    const ids = [...new Set(offer_ids || [])].slice(0, 3);
    if (ids.length < 2) throw new ToolError(T('e_two'), 'Pass two or three offer_ids from the same search.');
    const offers = [];
    for (const x of ids) offers.push(await this.offer(hid, x));
    const plan = await this.pendingPlan(hid);
    const cheapest = [...offers].sort((a, b) => a.total - b.total)[0];
    const best = [...offers].sort((a, b) => (b.rating || 0) - (a.rating || 0))[0];
    const diff = round(Math.max(...offers.map((x) => x.total)) - cheapest.total);
    const name = (x) => (x.kind === 'service' ? x.merchant : P(x.title));
    const parts = offers.map((x) => T('cmp_part', { name: name(x), total: usd(x.total), slot: x.kind === 'service' ? spokenSlot(x.slot_label) : '', r: x.rating, off: x.discount ? usd(x.discount) : '' }));
    const verdict = diff > 0 ? T('cmp_cheaper', { name: name(cheapest), diff: usd(diff), best: best.id !== cheapest.id && best.rating ? name(best) : '' }) : T('cmp_same');
    const cols = offers.map((x) => ({ ...x, images: galleryFor(x, this.publicUrl).slice(0, 1), in_plan: !!plan?.lines.some((l) => l.offer_id === x.id) }));
    return { speech: `${parts.join('. ')}. ${verdict}`, data: { mode: 'compare', offers: cols, cheapest_id: cheapest.id, best_rated_id: best.id, difference: diff, plan_id: plan?.id || null }, card: 'item' };
  }

  // ---------- 14. revise_plan ("take the sateen set instead", "remove the bedding") ----------
  async revisePlan(hid, { plan_id, remove_offer_ids = [], add_offer_ids = [] }) {
    const old = await this.store.get(pkOf(hid), `PLAN#${plan_id}`);
    if (!old) throw new ToolError('I cannot find that plan.', 'Call review_plan to get the plan waiting for a yes.');
    if (old.status !== 'proposed') throw new ToolError(`That plan is already ${old.status}, so it cannot change.`, old.status === 'confirmed' ? 'Use change_order or close_order on its orders.' : 'Call review_plan for the current plan.');
    if (Date.parse(old.expires) < this.now()) throw new ToolError('That plan expired.', 'Propose it again so prices are fresh.');
    const removing = new Set(remove_offer_ids);
    const kept = old.lines.map((l) => l.offer_id).filter((x) => !removing.has(x));
    const ids = [...new Set([...kept, ...add_offer_ids])];
    if (!ids.length) throw new ToolError(T('e_empty'), 'Keep at least one item, or tell the user the plan is dropped and nothing was paid.');
    if (ids.length === old.lines.length && ids.every((x) => old.lines.some((l) => l.offer_id === x))) throw new ToolError(T('e_same'), 'Use offer_ids from the plan (to remove) or from list_alternatives (to add).');
    const next = await this.proposePlan(hid, { item_ids: ids, mandate_id: old.mandate_id, note: old.note });
    old.status = 'revised';
    old.revised_to = next.data.plan.id;
    await this.store.put(pkOf(hid), `PLAN#${old.id}`, old);
    const removed = old.lines.filter((l) => removing.has(l.offer_id));
    const added = next.data.plan.lines.filter((l) => !old.lines.some((x) => x.offer_id === l.offer_id));
    const label = (l) => (l.kind === 'service' ? l.merchant : P(l.title).split(/[:：]/)[0].trim());
    const change = removed.length && added.length ? T('rev_swap', { out: listWords(removed.map(label)), in: listWords(added.map(label)) })
      : removed.length ? T('rev_removed', { out: listWords(removed.map(label)) }) : T('rev_added', { in: listWords(added.map(label)) });
    const p = next.data.plan;
    const env = next.data.envelope;
    const tail = p.auto_approved ? T('rev_tail_auto', { total: usd(p.breakdown.total) }) : T('rev_tail', { total: usd(p.breakdown.total), left: usd(p.remaining_after), budget: usd(env.budget) });
    await this.live({ step: `v-${p.id}`, state: 'done', text: change.replace(/\.$/, ''), from: old.breakdown.total, to: p.breakdown.total });
    return { speech: `${change} ${tail}`, data: { ...next.data, revised: { from_plan_id: old.id, previous_total: old.breakdown.total, removed: removed.map((l) => l.offer_id), added: added.map((l) => l.offer_id) } }, card: 'plan' };
  }

  // ---------- 15. review_plan ("show me the plan", Back) ----------
  async reviewPlan(hid, { plan_id } = {}) {
    const plan = await this.pendingPlan(hid, plan_id);
    if (!plan) throw new ToolError(T('e_no_plan'), 'Ask the user what they need, or call get_household_status for what is booked.');
    const m = await this.mandate(hid, plan.mandate_id);
    const env = this.envelopeView(m, await this.envelopeOf(hid, m));
    const items = plan.lines.map((l) => `${l.merchant} ${usd(l.total)}`);
    const { token_hash, ...pub } = plan;
    return { speech: T('review', { items: listWords(items), total: usd(plan.breakdown.total), left: usd(plan.remaining_after), budget: usd(env.budget), ask: !plan.auto_approved }), data: { plan: pub, needs_user_yes: !plan.auto_approved, envelope: env, reviewed: true }, card: 'plan' };
  }

  // ---------- household identity, settings and the emergency stop (account linking, first run) ----------
  async profile(hid) { return (await this.store.get(pkOf(hid), 'PROFILE')) || null; }
  async settings(hid) { return (await this.store.get(pkOf(hid), 'SETTINGS')) || null; }
  // What Mandat bought on its own today (counts toward the daily limit). A voided hold gives its room back.
  async autoSpentToday(hid) {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const orders = (await this.store.query(pkOf(hid), 'ORDER#')).map((r) => r.value);
    return round(orders.filter((o) => o.auto && o.state !== 'released' && String(o.timeline?.[0]?.at || '').startsWith(day)).reduce((s, o) => s + (o.captured ?? o.amount) - (o.refunded || 0), 0));
  }

  // A new household behind a new account link (src/core/oauth.mjs). "demo" is pre-filled for judges: the two facts
  // the stories rely on (Max's allergy, the coffee brand); no budget and no settings yet, so the first run shows.
  async seedHousehold(kind = 'demo') {
    const hid = `${kind === 'demo' ? 'demo' : 'hh'}-${crypto.randomBytes(5).toString('hex')}`;
    const at = new Date(this.now()).toISOString();
    await this.store.put(pkOf(hid), 'PROFILE', { kind, created: at });
    if (kind === 'demo') {
      for (const [subject, fact] of [['Max (dog)', 'allergic to chicken'], ['Coffee', 'We drink Northbeam medium roast']]) {
        const p = { id: id('pref'), subject, fact, at };
        await this.store.put(pkOf(hid), `PREF#${p.id}`, p);
      }
    }
    await this.event(hid, 'household.created', { kind });
    return hid;
  }

  // Alexa customer-data permissions (simulated host side: Amazon's Permissions page does not say how the data reaches
  // an MCP add-on). Only what the person allowed is kept; a permission turned off deletes that detail at once.
  async applyCustomerPermissions(hid, { granted = {}, values = {} }) {
    return this.locked(hid, async () => {
      const p = (await this.profile(hid)) || { kind: 'linked', created: new Date(this.now()).toISOString() };
      p.permissions = { name: !!granted.name, email: !!granted.email, address: !!granted.address };
      p.name = granted.name && values.name ? { full: String(values.name.full || '').slice(0, 80), given: String(values.name.given || '').slice(0, 40) } : null;
      p.email = granted.email && values.email ? String(values.email).slice(0, 120) : null;
      const a = values.address || {};
      p.address = granted.address && a.line1 ? { line1: String(a.line1).slice(0, 80), city: String(a.city || '').slice(0, 40), region: String(a.region || '').slice(0, 20), postal: String(a.postal || '').slice(0, 12) } : null;
      p.permissions_at = new Date(this.now()).toISOString();
      p.source = 'Alexa customer-data permissions (simulated)';
      await this.store.put(pkOf(hid), 'PROFILE', p);
      await this.event(hid, 'permissions.updated', { granted: Object.keys(p.permissions).filter((k) => p.permissions[k]) });
      const shared = Object.keys(p.permissions).filter((k) => p.permissions[k]).map((k) => T('perm_' + k));
      return { speech: T('perm_ok', { name: p.name?.given || '', list: shared.length ? listWords(shared) : '' }), data: { profile: publicProfile(p) }, card: 'status' };
    });
  }

  settingsView(s, extra = {}) {
    return { ...S.DEFAULTS, ...s, categories: [...(s?.categories || S.CATEGORIES)], ...extra };
  }
  // ---------- 16. get_settings ("Alexa, open Mandat settings"; also the first-run card) ----------
  async getSettings(hid, { first_run = false } = {}) {
    let s = await this.settings(hid);
    if (!s) { s = { ...S.DEFAULTS, categories: [...S.CATEGORIES], created: new Date(this.now()).toISOString() }; await this.store.put(pkOf(hid), 'SETTINGS', s); }
    // the weekly envelope exists from the first look at the settings, so the defaults already protect the household
    if (!(await this.weeklyMandate(hid))) await this.syncWeeklyMandate(hid, s);
    const profile = await this.profile(hid);
    const given = profile?.name?.given || '';
    const step = s.onboarded ? null : S.nextStep(s.answered || [], s);
    const speech = !s.onboarded
      ? `${T('set_welcome', { name: given })} ${T('ask_' + (step || 'done'), this.askVars(s))}`
      : `${T('set_summary', this.summaryVars(s))} ${s.paused ? T('set_paused_note') : ''}`.trim();
    return { speech, data: { settings: this.settingsView(s), first_run: !s.onboarded || !!first_run, onboarding_step: step, auto_spent_today: await this.autoSpentToday(hid), profile: publicProfile(profile) }, card: 'settings' };
  }
  askVars(s) { return { week: usd(s.weekly_budget), auto: usd(s.auto_buy_under), cap: usd(s.daily_cap), level: T('lvl_' + s.autonomy) }; }
  summaryVars(s) {
    const off = S.CATEGORIES.filter((c) => !(s.categories || S.CATEGORIES).includes(c));
    return { week: usd(s.weekly_budget), level: T('lvl_' + s.autonomy), rule: T('rule_' + s.autonomy, this.askVars(s)), off: off.length ? T('set_off', { cats: listWords(off.map((c) => T('cat_' + c))) }) : T('set_all_on') };
  }

  // ---------- 17. update_settings (touch on the card, or by voice: "200 a week", "Balanced") ----------
  async updateSettings(hid, patch = {}) {
    const cur = (await this.settings(hid)) || { ...S.DEFAULTS, categories: [...S.CATEGORIES], created: new Date(this.now()).toISOString() };
    const r = S.applyPatch(cur, patch);
    if (r.error) throw new ToolError(T(r.error.key, { ...r.error, lo: usd(r.error.lo ?? 0), hi: usd(r.error.hi ?? 0), ...this.askVars({ ...cur, ...patch }) }), 'Tell the user the limit and ask for another amount.');
    const next = { ...r.next, answered: [...new Set([...(cur.answered || []), ...r.changed.filter((k) => S.ONBOARDING_STEPS.includes(k)), ...(patch.answered || []).filter((k) => S.ONBOARDING_STEPS.includes(k))])], updated: new Date(this.now()).toISOString() };
    // The weekly budget is the household's recurring envelope: keep it in step (in place: held and spent stay).
    if (r.changed.includes('weekly_budget') || r.changed.includes('auto_buy_under') || !(await this.weeklyMandate(hid))) await this.syncWeeklyMandate(hid, next);
    await this.store.put(pkOf(hid), 'SETTINGS', next);
    if (r.changed.length) await this.event(hid, 'settings.updated', { changed: r.changed });
    // confirm what the person set, even when it was already that value ("Balanced." -> "Balanced.")
    const asked = [...new Set([...r.changed, ...Object.keys(patch).filter((k) => ['weekly_budget', 'auto_buy_under', 'autonomy', 'daily_cap'].includes(k)), ...(patch.categories_on || patch.categories_off ? ['categories'] : [])])];
    const said = asked.filter((k) => k !== 'onboarded').map((k) => T('chg_' + k, { ...this.askVars(next), cats: this.summaryVars(next).off }));
    const finished = r.changed.includes('onboarded');
    const speech = finished ? T('set_done', this.summaryVars(next)) : said.length ? said.join(' ') : T('set_same');
    const step = next.onboarded ? null : S.nextStep(next.answered, next);
    return { speech, data: { settings: this.settingsView(next), changed: r.changed, onboarding_step: step, first_run: !next.onboarded, auto_spent_today: await this.autoSpentToday(hid) }, card: 'settings' };
  }
  async weeklyMandate(hid) {
    return (await this.mandates(hid)).filter((m) => m.status === 'active' && m.period === 'weekly').sort((a, b) => Number(!!b.settings_managed) - Number(!!a.settings_managed) || b.created.localeCompare(a.created))[0] || null;
  }
  async syncWeeklyMandate(hid, s) {
    const m = await this.weeklyMandate(hid);
    if (!m) {
      await this.setSpendingMandate(hid, { budget: s.weekly_budget, period: 'weekly', auto_approve_under: s.auto_buy_under, purpose: T('purpose_weekly'), fromSettings: true });
      return;
    }
    await this.locked(hid, async () => {
      const env = await this.envelopeOf(hid, m);
      const t = envelope.totals(env);
      if (s.weekly_budget < t.held + t.spent - 1e-9) throw new ToolError(T('set_e_below_committed', { amt: usd(t.held + t.spent) }), 'Ask the user for a weekly budget at least that high.');
      Object.assign(m, { budget: s.weekly_budget, auto_approve_under: s.auto_buy_under, settings_managed: true });
      env.total = s.weekly_budget; env.approveAbove = s.auto_buy_under;
      await this.store.put(pkOf(hid), `MANDATE#${m.id}`, m);
      await this.saveEnvelope(hid, m, env);
    });
  }

  // ---------- 18. pause_spending: the emergency stop ("Alexa, pause Mandat", "stop all spending") ----------
  // Pauses every autonomy level, voids every payment hold still open (nothing was charged on them) and drops the
  // plans waiting for a yes. Nothing can be bought until the person says "resume Mandat".
  async pauseSpending(hid) {
    const out = await this.locked(hid, async () => {
      const s = (await this.settings(hid)) || { ...S.DEFAULTS, categories: [...S.CATEGORIES], created: new Date(this.now()).toISOString() };
      s.paused = true; s.paused_at = new Date(this.now()).toISOString();
      await this.store.put(pkOf(hid), 'SETTINGS', s);
      const voided = [];
      const at = new Date(this.now()).toISOString();
      for (const o of (await this.store.query(pkOf(hid), 'ORDER#')).map((r) => r.value).filter((x) => x.state === 'held')) {
        const pp = await this.paypal.release({ mode: o.paypal.mode, authorizationId: o.paypal.authorizationId });
        const m = (await this.mandates(hid)).find((x) => x.id === o.mandate_id);
        if (m) { const env = await this.envelopeOf(hid, m); try { envelope.release(env, o.id, pp); } catch {} await this.saveEnvelope(hid, m, env); }
        o.state = 'released';
        o.timeline.push({ state: 'released', amount: o.amount, note: 'emergency stop', at });
        await this.store.put(pkOf(hid), `ORDER#${o.id}`, o);
        await this.live({ step: `p-${o.id}`, state: 'done', text: T('l_released', { amt: usd(o.amount) }), detail: o.merchant, image_url: o.image_url });
        voided.push(o);
      }
      let plans = 0;
      for (const p of (await this.store.query(pkOf(hid), 'PLAN#')).map((r) => r.value).filter((x) => x.status === 'proposed')) {
        p.status = 'cancelled'; plans++;
        await this.store.put(pkOf(hid), `PLAN#${p.id}`, p);
      }
      const amount = round(voided.reduce((x, o) => x + o.amount, 0));
      await this.event(hid, 'spending.paused', { voided: voided.length, amount, plans });
      return { voided, amount, plans };
    });
    const status = await this.getHouseholdStatus(hid, {});
    const speech = T('pause_done', { n: out.voided.length, amt: usd(out.amount), names: listWords(out.voided.slice(0, 3).map((o) => o.merchant)), plans: out.plans });
    return { speech, data: { ...status.data, stop: { voided: out.voided.map(publicOrder), amount: out.amount, plans: out.plans } }, card: 'status' };
  }
  // ---------- 19. resume_spending ----------
  async resumeSpending(hid) {
    const s = await this.settings(hid);
    if (!s?.paused) { const st = await this.getHouseholdStatus(hid, {}); return { speech: T('resume_not_paused'), data: st.data, card: 'status' }; }
    s.paused = false; s.resumed_at = new Date(this.now()).toISOString();
    await this.store.put(pkOf(hid), 'SETTINGS', s);
    await this.event(hid, 'spending.resumed', {});
    const st = await this.getHouseholdStatus(hid, {});
    return { speech: T('resume_done', this.summaryVars(s)), data: { ...st.data, resumed: true }, card: 'status' };
  }

  // ---------- 20. delete_my_data: void the holds, then erase the whole household and its account links ----------
  async deleteHouseholdData(hid, { user_confirmation }) {
    if (!(isExplicitYes(user_confirmation) || user_confirmation === 'tap:delete')) throw new ToolError(T('e_delete_yes'), 'Explain what is erased, ask the user to say yes, then call delete_my_data with their words in user_confirmation.');
    return this.locked(hid, async () => {
      let voided = 0;
      for (const o of (await this.store.query(pkOf(hid), 'ORDER#')).map((r) => r.value).filter((x) => x.state === 'held')) {
        try { await this.paypal.release({ mode: o.paypal.mode, authorizationId: o.paypal.authorizationId }); voided++; } catch {}
      }
      const rows = await this.store.query(pkOf(hid), '');
      // account links: their tokens live under their own keys
      for (const r of rows.filter((x) => x.sk.startsWith('LINK#'))) for (const t of r.value.tokens || []) await this.store.delete(t.pk, 'T');
      for (const r of rows) await this.store.delete(pkOf(hid), r.sk);
      return { speech: T('deleted', { n: voided }), data: { deleted: true, rows: rows.length, voided, unlinked: true }, card: 'status' };
    });
  }

  // Recent actions for the status card (from the household's own event log), newest first.
  async recentActions(hid, max = 4) {
    const rows = (await this.store.query(pkOf(hid), 'EVENT#')).map((r) => r.value).slice(-30);
    const text = (e) => {
      switch (e.type) {
        case 'mandate.set': return T('ev_budget', { amt: usd(e.budget) });
        case 'plan.confirmed': return T(e.how === 'auto-approve rule' ? 'ev_bought_alone' : 'ev_booked_yes', { amt: usd(e.total) });
        case 'order.released': return T('ev_declined', { m: e.merchant || '' });
        case 'order.capture': return T('ev_paid', { m: e.merchant || '', amt: usd(e.amount || 0) });
        case 'order.cancel': return T('ev_cancel', { m: e.merchant || '' });
        case 'order.refund': return T('ev_refund', { m: e.merchant || '', amt: usd(e.amount || 0) });
        case 'order.changed': return T('ev_moved', { m: e.merchant || '' });
        case 'settings.updated': return T('ev_settings');
        case 'spending.paused': return T('ev_paused', { n: e.voided || 0 });
        case 'spending.resumed': return T('ev_resumed');
        case 'permissions.updated': return T('ev_permissions');
        case 'preference.saved': return T('ev_pref', { s: e.subject });
        default: return null;
      }
    };
    return rows.map((e) => ({ at: e.at, type: e.type, text: text(e) })).filter((x) => x.text).slice(-max).reverse();
  }

  // ---------- app-only: refresh a card ----------
  async refreshCard(hid, { card, plan_id, order_ids }) {
    if (card === 'receipt' && order_ids?.length) return this.receipt(hid, order_ids, '');
    if (card === 'plan' && plan_id) {
      const p = await this.store.get(pkOf(hid), `PLAN#${plan_id}`);
      if (!p) throw new ToolError('Unknown plan.', 'Propose it again.');
      const { token_hash, ...pub } = p;
      return { speech: '', data: { plan: pub }, card: 'plan' };
    }
    const s = await this.getHouseholdStatus(hid, {});
    return { ...s, speech: '' };
  }
}

// What the household shared through Alexa, as the cards show it (never more).
export function publicProfile(p) {
  if (!p) return null;
  return { kind: p.kind, permissions: p.permissions || null, name: p.name?.full || null, given_name: p.name?.given || null, email: p.email || null, address: p.address ? [p.address.line1, p.address.city].filter(Boolean).join(', ') : null };
}
export function publicOrder(o) {
  const { close_token, paypal, ...rest } = o;
  return { ...rest, paypal_mode: paypal?.mode, paypal_authorization: paypal?.authorizationId };
}
export { MERCHANTS };
