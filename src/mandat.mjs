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
import { DAY_NAMES, guardQuote, identityCard, merchant as merchantById, MERCHANTS, normalizeCategory, parseGuests, parseWhen, search, verifyCard } from './core/merchants.mjs';
import { pkOf } from './store/index.mjs';

export class ToolError extends Error {
  constructor(message, next) { super(message); this.next = next; }
}

const OFFER_TTL = 30 * 60 * 1000;
const PLAN_TTL = 15 * 60 * 1000;
const MAX_BUDGET = 5000; // sandbox demo cap
const round = (x) => Math.round(Number(x) * 100) / 100;
const usd = (n, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: Number.isInteger(round(n)) ? 0 : 2 }).format(round(n));
const id = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const spokenSlot = (slot) => String(slot || '').replace(/^(\w+day) (\d)/, '$1 at $2');
const listWords = (xs) => (xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);
// An explicit yes: what the user said, or the Approve tap of the plan card.
const AFFIRMATIVE = /^(\s*(yes|yeah|yep|yup|sure|ok|okay|confirm(ed)?|approve(d)?|go ahead|do it|book it|buy it|pay|sounds good|tap:approve)\b)/i;
export const isExplicitYes = (s) => typeof s === 'string' && AFFIRMATIVE.test(s.trim()) && !/\b(no|not|don't|cancel|wait|stop)\b/i.test(s);

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
    if (!m) throw new ToolError('There is no spending budget yet, so I cannot pay for anything.', 'Ask the user for a budget and call set_spending_mandate.');
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
      open_orders: section && section !== 'orders' ? undefined : open.map(publicOrder),
      recent_orders: section && section !== 'orders' ? undefined : orders.filter((o) => o.state !== 'held').slice(-5).map(publicOrder),
      preferences: section && section !== 'preferences' ? undefined : preferences,
      pending_decisions: pending.map((p) => ({ plan_id: p.id, total: p.breakdown.total, lines: p.lines.map((l) => l.merchant) })),
    };
    const parts = [];
    if (!section || section === 'budget') {
      if (!envelopes.length) parts.push('You have no spending budget set yet.');
      for (const e of envelopes.slice(0, 2)) parts.push(`${e.purpose || 'Your budget'}: ${usd(e.remaining, e.currency)} left of ${usd(e.budget, e.currency)}${e.period === 'once' ? '' : ' this ' + e.period.replace('ly', '')}${e.held ? `, ${usd(e.held, e.currency)} on hold` : ''}.`);
    }
    if (!section || section === 'orders') parts.push(open.length ? `${open.length} ${open.length === 1 ? 'order is' : 'orders are'} open: ${listWords(open.slice(0, 3).map((o) => o.merchant))}.` : 'No open orders.');
    if (section === 'preferences') parts.push(preferences.length ? `I remember: ${listWords(preferences.slice(0, 5).map((p) => `${p.subject}, ${p.fact}`))}.` : 'I have no household preferences saved yet.');
    if (pending.length) parts.push(`${pending.length === 1 ? 'One plan is' : pending.length + ' plans are'} waiting for your yes.`);
    return { speech: parts.join(' '), data, card: 'status' };
  }

  // ---------- 2. set_spending_mandate ----------
  async setSpendingMandate(hid, { budget, currency = 'USD', period, auto_approve_under = 0, purpose }) {
    budget = round(budget);
    auto_approve_under = round(auto_approve_under || 0);
    if (!(budget > 0) || budget > MAX_BUDGET) throw new ToolError(`The budget must be between $1 and ${usd(MAX_BUDGET)} in this sandbox.`, 'Ask the user for a smaller amount.');
    if (auto_approve_under < 0 || auto_approve_under > budget) throw new ToolError('The auto-approve limit must be between zero and the budget.', 'Ask the user under which amount Mandat may buy without asking.');
    return this.locked(hid, async () => {
      const mid = id('mdt');
      const returnUrl = `${this.publicUrl}/paypal/return?household=${encodeURIComponent(hid)}&mandate=${mid}`;
      const setup = await this.paypal.createMandateSetup({ returnUrl, cancelUrl: `${this.publicUrl}/paypal/cancel?mandate=${mid}`, description: `Mandat for Alexa+: ${purpose}`.slice(0, 120) });
      const m = { id: mid, purpose, budget, currency, period, auto_approve_under, created: new Date(this.now()).toISOString(), status: 'awaiting_approval', paypal: { setupId: setup.id, mode: setup.mode } };
      // Offline (simulated) PayPal: the mandate is signed on the spot, clearly flagged as simulated.
      if (setup.mode === 'offline') {
        const t = await this.paypal.activateMandate(setup.id);
        m.status = 'active';
        m.paypal.paymentTokenId = t.paymentTokenId;
      }
      // One active budget per purpose: a new one replaces the old.
      for (const old of await this.mandates(hid)) {
        if (old.status === 'active' && old.purpose.toLowerCase() === purpose.toLowerCase() && old.period === period) {
          old.status = 'replaced';
          await this.store.put(pkOf(hid), `MANDATE#${old.id}`, old);
        }
      }
      await this.store.put(pkOf(hid), `MANDATE#${mid}`, m);
      await this.event(hid, 'mandate.set', { mandate_id: mid, budget, period, auto_approve_under });
      const env = m.status === 'active' ? this.envelopeView(m, await this.envelopeOf(hid, m)) : null;
      const rule = auto_approve_under > 0 ? `I will buy on my own under ${usd(auto_approve_under, currency)} and ask you above that.` : 'I will ask you before every payment.';
      const when = period === 'once' ? '' : ` per ${period.replace('ly', '')}`;
      const speech = m.status === 'active'
        ? `Done. ${purpose}: ${usd(budget, currency)}${when}. ${rule}`
        : `I set ${usd(budget, currency)}${when} for ${purpose}. To finish, approve it once with PayPal from the link on the screen or in your Alexa app. ${rule}`;
      return { speech, data: { mandate: { ...m, paypal: { mode: setup.mode } }, approval_url: setup.mode === 'offline' ? null : setup.approveUrl, envelope: env }, card: 'mandate' };
    });
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
      return { speech: `Got it. ${subject}: ${fact}. I will remember that.`, data: { saved: p, preferences: prefs }, card: 'status' };
    });
  }

  // ---------- 4. find_home_services ----------
  async findHomeServices(hid, { need, category, when, area, max_price, guests }) {
    const cat = normalizeCategory(category) || normalizeCategory(need);
    if (!cat) throw new ToolError(`I can book cleaning, catering, plumbing and handyman services.`, 'Ask the user which of these they need.');
    guests = guests || parseGuests(need) || null;
    const merchants = search({ category: cat, area }).map((p) => merchantById(p.id));
    const answers = await Promise.all(merchants.map(async (m) => {
      const r = await this.provider.merchantAgent({ merchant: m, when, ask: need, guests });
      return { m, r, quote: guardQuote(m, r.quote, guests) };
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
        card_verified: verifyCard(card), agent: card.agent, card_issuer: card.issuedBy,
        created: new Date(now).toISOString(), expires: new Date(now + OFFER_TTL).toISOString(),
      });
    }
    offers.sort((a, b) => a.total - b.total || b.rating - a.rating);
    const top = offers.filter((o) => o.card_verified).slice(0, 5);
    if (!top.length) {
      const d = parseWhen(when).day;
      throw new ToolError(`No ${cat} service can do ${d ? DAY_NAMES[d] : 'that'}${max_price ? ` under ${usd(max_price)}` : ''}.`, 'Suggest another day or a higher limit to the user.');
    }
    for (const o of top) await this.store.put(pkOf(hid), `OFFER#${o.id}`, o);
    const label = { cleaning: 'cleaners', catering: 'caterers', plumbing: 'plumbers', handyman: 'handymen' }[cat];
    const spoken = top.slice(0, 3).map((o, i) => `${i === 0 ? 'Best' : 'Then'}: ${o.merchant}, ${usd(o.total)} ${spokenSlot(o.slot_label)}${o.discount ? `, down from ${usd(o.base)}` : ''}`);
    return {
      speech: `I asked ${answers.length} ${label}. ${spoken.join('. ')}.`,
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
      const m = /allerg\w*\s+(?:to\s+)?([a-z ,&-]+)/i.exec(p.fact) || /\b(?:no|avoid|never)\s+([a-z ,&-]+)/i.exec(p.fact);
      const who = p.subject.replace(/\s*\(.*\)\s*/, '');
      const reason = `${who} ${/^(is|are)\b/i.test(p.fact) ? '' : 'is '}${p.fact.replace(/\.$/, '')}`.replace(/\s+/g, ' ');
      if (m) for (const w of m[1].split(/,|\band\b|&/)) if (w.trim()) banned.set(w.trim().toLowerCase(), reason);
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
    if (!ok.length) throw new ToolError(`I found nothing for ${query}${skipped.length ? ' that fits your household preferences' : ''}.`, 'Ask the user for another product or a higher price limit.');
    const now = this.now();
    const offers = ok.slice(0, 5).map((p) => ({
      id: id('off'), kind: 'product', merchant_id: p.shop, merchant: p.shopName, product_id: p.id, title: p.title, quantity,
      base: round(p.price * quantity), discount: 0, fees: round(p.delivery || 0), tax: 0, total: round(p.price * quantity + (p.delivery || 0)), currency: 'USD',
      matches_preference: liked(p), slot_label: 'Delivery in 2 days',
      created: new Date(now).toISOString(), expires: new Date(now + OFFER_TTL).toISOString(),
    }));
    for (const o of offers) await this.store.put(pkOf(hid), `OFFER#${o.id}`, o);
    const best = offers[0];
    const skip = skipped.length ? ` I skipped ${skipped.length} with ${[...new Set(skipped.map((x) => x.ingredient))].join(', ')}, because ${skipped[0].because}.` : '';
    return {
      speech: `${best.matches_preference ? 'Your usual' : 'Best match'}: ${best.title}, ${usd(best.total)} from ${best.merchant}.${skip}`,
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
    if (!quote) return { speech: `${m.name} says: ${r.reply}`, data: { offer: o, merchant_reply: r.reply, changed: false }, card: 'offers' };
    const before = o.total;
    Object.assign(o, { base: round(quote.base), discount: round(quote.discount), total: round(quote.total), slot_label: quote.slotLabel, negotiation: r.reply, conditions: quote.conditions || '', expires: new Date(this.now() + OFFER_TTL).toISOString() });
    if (quote.slotLabel) o.when = quote.slotLabel;
    await this.store.put(pkOf(hid), `OFFER#${o.id}`, o);
    const delta = before - o.total;
    return {
      speech: delta > 0 ? `${m.name} agreed: ${usd(o.total)} instead of ${usd(before)}, ${spokenSlot(o.slot_label)}.` : `${m.name} says: ${r.reply}`,
      data: { offer: o, previous_total: before, changed: delta !== 0, merchant_reply: r.reply, offers: [o] },
      card: 'offers',
    };
  }
  async offer(hid, oid) {
    const o = await this.store.get(pkOf(hid), `OFFER#${oid}`);
    if (!o) throw new ToolError('I cannot find that option any more.', 'Search again with find_home_services or find_products.');
    if (Date.parse(o.expires) < this.now()) throw new ToolError(`The quote from ${o.merchant} has expired.`, 'Search again to get a fresh quote.');
    return o;
  }

  // ---------- 7. propose_plan ----------
  async proposePlan(hid, { item_ids, mandate_id, note }) {
    const ids = [...new Set(item_ids || [])];
    if (!ids.length) throw new ToolError('A plan needs at least one option.', 'Pick options from the last search.');
    const offers = [];
    for (const oid of ids) offers.push(await this.offer(hid, oid));
    const m = await this.mandate(hid, mandate_id);
    const env = await this.envelopeOf(hid, m);
    const lines = offers.map((o) => ({ offer_id: o.id, kind: o.kind, merchant: o.merchant, merchant_id: o.merchant_id, title: o.title, detail: o.slot_label, guests: o.guests ?? null, quantity: o.quantity ?? null, base: o.base, discount: o.discount, fees: o.fees, tax: o.tax, total: o.total }));
    const sum = (k) => round(lines.reduce((s, l) => s + (l[k] || 0), 0));
    const breakdown = { base: sum('base'), discount: sum('discount'), fees: sum('fees'), tax: sum('tax'), total: sum('total'), currency: m.currency };
    const verdict = envelope.check(env, breakdown.total);
    const t = envelope.totals(env);
    if (!verdict.ok) {
      throw new ToolError(`That plan costs ${usd(breakdown.total)} but only ${usd(t.remaining)} is left in ${m.purpose}.`, 'Drop an item, pick cheaper options, or ask the user to raise the budget with set_spending_mandate.');
    }
    const token = crypto.randomBytes(16).toString('hex');
    const plan = {
      id: id('plan'), mandate_id: m.id, purpose: m.purpose, lines, breakdown, note: note || '', status: 'proposed',
      auto_approved: !verdict.needsApproval, token_hash: sha(token),
      remaining_after: round(t.remaining - breakdown.total), budget: t.total,
      created: new Date(this.now()).toISOString(), expires: new Date(this.now() + PLAN_TTL).toISOString(),
    };
    await this.store.put(pkOf(hid), `PLAN#${plan.id}`, plan);
    await this.event(hid, 'plan.proposed', { plan_id: plan.id, total: breakdown.total, auto_approved: plan.auto_approved });
    const items = lines.map((l) => `${l.merchant} ${usd(l.total)}`);
    const speech = plan.auto_approved
      ? `${listWords(items)}. That is ${usd(breakdown.total)}, under your ${usd(m.auto_approve_under)} auto-approve rule, so I can buy it right away.`
      : `Here is the plan: ${listWords(items)}. Total ${usd(breakdown.total)}${breakdown.discount ? `, after ${usd(breakdown.discount)} negotiated off` : ''}. That leaves ${usd(plan.remaining_after)} of your ${usd(t.total)}. Should I book it?`;
    const { token_hash, ...pub } = plan;
    return { speech, data: { plan: pub, confirmation_token: token, needs_user_yes: !plan.auto_approved, envelope: this.envelopeView(m, env) }, card: 'plan' };
  }

  // ---------- 8. confirm_plan ----------
  async confirmPlan(hid, { plan_id, confirmation_token, user_confirmation }) {
    return this.locked(hid, async () => {
      const plan = await this.store.get(pkOf(hid), `PLAN#${plan_id}`);
      if (!plan) throw new ToolError('I cannot find that plan.', 'Propose the plan again with propose_plan.');
      if (!sameHash(sha(confirmation_token || ''), plan.token_hash)) throw new ToolError('That confirmation does not match this plan, so I did not pay anything.', 'Use the confirmation token returned by propose_plan for this exact plan.');
      // Idempotency: a confirmed plan returns its receipt again, without a second hold.
      const prior = await this.store.get(pkOf(hid), `IDEMP#${plan.id}`);
      if (prior?.receipt) return { ...(await this.receipt(hid, prior.receipt.order_ids, `Already booked: nothing new was charged.`)), duplicate: true };
      if (Date.parse(plan.expires) < this.now()) throw new ToolError('This plan expired before it was confirmed.', 'Propose it again so prices are fresh.');
      if (!plan.auto_approved && !isExplicitYes(user_confirmation)) {
        throw new ToolError(`I need your explicit yes before paying ${usd(plan.breakdown.total)}.`, 'Read the total aloud, ask the user to say yes, then call confirm_plan with their words in user_confirmation.');
      }
      const m = await this.mandate(hid, plan.mandate_id);
      if (!m.paypal?.paymentTokenId) throw new ToolError('The budget is not approved with PayPal yet.', 'Ask the user to open the approval link once.');
      const env = await this.envelopeOf(hid, m);
      const verdict = envelope.check(env, plan.breakdown.total); // re-checked: money may have moved since the proposal
      if (!verdict.ok) throw new ToolError(`Only ${usd(envelope.totals(env).remaining)} is left now, the plan costs ${usd(plan.breakdown.total)}.`, 'Propose a smaller plan.');
      if (verdict.needsApproval && !isExplicitYes(user_confirmation)) throw new ToolError('This plan needs your explicit yes.', 'Ask the user to confirm.');
      if (!(await this.store.putIfAbsent(pkOf(hid), `IDEMP#${plan.id}`, { at: new Date(this.now()).toISOString() }))) {
        throw new ToolError('This plan is already being booked.', 'Wait a moment and call get_household_status.');
      }
      const orders = [];
      try {
        for (const [i, l] of plan.lines.entries()) {
          const oid = id('ord');
          const pp = await this.paypal.hold({ paymentTokenId: m.paypal.paymentTokenId, amount: l.total, currency: m.currency, merchant: l.merchant, description: `${l.title} (${l.detail})`, reference: `${plan.id}-${i}` });
          envelope.hold(env, { id: oid, merchant: l.merchant, label: l.title, amount: l.total, paypal: pp });
          const at = new Date(this.now()).toISOString();
          orders.push({
            id: oid, plan_id: plan.id, mandate_id: m.id, kind: l.kind, merchant_id: l.merchant_id, merchant: l.merchant, label: l.title, slotLabel: l.detail,
            guests: l.guests, quantity: l.quantity, amount: l.total, currency: m.currency, state: 'held', paypal: { orderId: pp.orderId, authorizationId: pp.authorizationId, mode: pp.mode },
            close_token: crypto.randomBytes(12).toString('hex'), timeline: [{ state: 'held', amount: l.total, at }],
          });
        }
      } catch (e) {
        // A hold failed half-way: void what was already held, leave nothing behind.
        for (const o of orders) { try { await this.paypal.release({ authorizationId: o.paypal.authorizationId }); } catch {} }
        await this.store.delete(pkOf(hid), `IDEMP#${plan.id}`);
        throw new ToolError(`PayPal refused the payment hold (${e.message}). Nothing was charged.`, 'Try again in a minute or pick another option.');
      }
      for (const o of orders) await this.store.put(pkOf(hid), `ORDER#${o.id}`, o);
      await this.saveEnvelope(hid, m, env);
      plan.status = 'confirmed';
      plan.confirmed_with = plan.auto_approved ? 'auto-approve rule' : String(user_confirmation).slice(0, 80);
      await this.store.put(pkOf(hid), `PLAN#${plan.id}`, plan);
      await this.store.put(pkOf(hid), `IDEMP#${plan.id}`, { receipt: { order_ids: orders.map((o) => o.id) } });
      await this.event(hid, 'plan.confirmed', { plan_id: plan.id, total: plan.breakdown.total, orders: orders.length, how: plan.confirmed_with });
      const t = envelope.totals(env);
      const n = orders.length;
      const speech = `${plan.auto_approved ? 'Bought, under your auto-approve rule.' : 'Booked.'} ${n === 1 ? 'One payment hold' : `${n} payment holds`} for ${usd(plan.breakdown.total)}; nothing is charged until ${n === 1 ? 'it is' : 'each is'} delivered. ${usd(t.remaining)} left in ${m.purpose}.`;
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
        await this.event(hid, 'order.changed', { order_id: o.id, change });
        return { ...(await this.receipt(hid, [o.id], `${mer.name} agreed: ${spokenSlot(o.slotLabel)}, same hold of ${usd(o.amount)}.`)), accepted: true };
      }
      // Declined: void the hold so the money is free again, then line up a replacement.
      const pp = await this.paypal.release({ authorizationId: o.paypal.authorizationId });
      envelope.release(env, o.id, pp);
      o.state = 'released';
      o.timeline.push({ state: 'released', amount: o.amount, note: `${mer.name} declined: ${r.reply}`, at });
      await this.store.put(pkOf(hid), `ORDER#${o.id}`, o);
      await this.saveEnvelope(hid, m, env);
      await this.event(hid, 'order.released', { order_id: o.id, reason: 'merchant declined change' });
      let alternatives = [];
      if (change.field === 'date') {
        try {
          const found = await this.findHomeServices(hid, { need: `${mer.category} for ${o.guests || ''} guests`, category: mer.category, when: change.value, guests: o.guests });
          alternatives = found.data.offers.filter((x) => x.merchant_id !== mer.id).slice(0, 3);
        } catch { alternatives = []; }
      }
      const rec = await this.receipt(hid, [o.id], '');
      const alt = alternatives[0];
      rec.speech = `${mer.name} can't do it: ${r.reply} I voided their ${usd(o.amount)} hold, nothing was charged.${alt ? ` ${alt.merchant} can do ${spokenSlot(alt.slot_label)} for ${usd(alt.total)}. Want me to book them?` : ''}`;
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
        const pp = await this.paypal.capture({ authorizationId: o.paypal.authorizationId, amount: take < o.amount ? take : undefined, currency: o.currency });
        envelope.capture(env, o.id, pp, take);
        Object.assign(o, { state: 'captured', captured: take, paypal: { ...o.paypal, captureId: pp.captureId } });
        o.timeline.push({ state: 'captured', amount: take, at });
        if (take < o.amount) o.timeline.push({ state: 'released', amount: round(o.amount - take), note: 'rest of the hold released', at });
        speech = take < o.amount
          ? `${o.merchant} billed ${usd(take)}, ${usd(o.amount - take)} less than held. I captured ${usd(take)} and released the rest.`
          : `Paid ${o.merchant} ${usd(take)}.`;
      } else if (action === 'cancel') {
        if (o.state !== 'held') throw new ToolError(`That order is ${o.state}; only a held payment can be cancelled. A paid order can be refunded.`, 'Use action refund instead.');
        const pp = await this.paypal.release({ authorizationId: o.paypal.authorizationId });
        envelope.release(env, o.id, pp);
        o.state = 'released';
        o.timeline.push({ state: 'released', amount: o.amount, note: 'cancelled', at });
        speech = `Cancelled ${o.merchant}. The ${usd(o.amount)} hold is released; nothing was charged.`;
      } else if (action === 'refund') {
        if (o.state !== 'captured') throw new ToolError(`That order is ${o.state}; only a paid order can be refunded.`, o.state === 'held' ? 'Use action cancel to release the hold instead.' : 'Check the order with get_household_status.');
        const paid = round((o.captured ?? o.amount) - (o.refunded || 0));
        const back = round(amount ?? paid);
        if (!(back > 0) || back > paid + 1e-9) throw new ToolError(`At most ${usd(paid)} can be refunded on this order.`, 'Refund a smaller amount.');
        const pp = await this.paypal.refund({ captureId: o.paypal.captureId, amount: back, currency: o.currency, note: 'Mandat for Alexa+ refund' });
        envelope.refund(env, o.id, back, pp);
        o.refunded = round((o.refunded || 0) + back);
        if (o.refunded >= (o.captured ?? o.amount) - 1e-9) o.state = 'refunded';
        o.timeline.push({ state: 'refunded', amount: back, at });
        speech = `Refund of ${usd(back)} from ${o.merchant} is on its way.`;
      } else throw new ToolError('The action must be capture, cancel or refund.', 'Pick one.');
      await this.store.put(pkOf(hid), `ORDER#${o.id}`, o);
      await this.saveEnvelope(hid, m, env);
      await this.event(hid, `order.${action}`, { order_id: o.id, amount });
      const t = envelope.totals(env);
      return this.receipt(hid, [o.id], `${speech} ${usd(t.remaining)} left in ${m.purpose}.`);
    });
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

export function publicOrder(o) {
  const { close_token, paypal, ...rest } = o;
  return { ...rest, paypal_mode: paypal?.mode, paypal_authorization: paypal?.authorizationId };
}
export { MERCHANTS };
