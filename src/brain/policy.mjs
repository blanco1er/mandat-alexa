// The simulated "Alexa+ brain": a deterministic policy that plays the role of the model in the tool loop.
// Given the user's utterance, the household session (pending plan, device) and the tool results of this turn so
// far, it returns the next action: { type: 'tool', name, args } or { type: 'say', text }.
// Pure module (no Node imports): used by the simulated orchestrator, by the Strands ScriptedModel (orchestrator/),
// and by the tests. It only covers the demo intents; the Bedrock brain handles free-form requests.

import * as I from '../core/i18n.mjs';

const sc = (r) => (r && r.structuredContent) || {};
const said = (r) => (r && r.content && r.content[0] && r.content[0].text) || '';
const failed = (r) => !!(r && r.isError);
const tool = (name, args) => ({ type: 'tool', name, args });
const say = (text) => ({ type: 'say', text: text.replace(/\s+/g, ' ').trim() });
const money = (t) => { const m = /\$\s?(\d+(?:\.\d+)?)/.exec(t); return m ? Number(m[1]) : null; };
const DAY = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const best = (r) => (sc(r).offers || [])[0];

export function classify(u, session = {}) {
  const t = u.toLowerCase();
  if (session.pending && /^\s*(yes|yeah|yep|sure|ok|okay|go ahead|do it|book it|buy it|confirm)\b/.test(t)) return 'confirm';
  if (session.pending && /^\s*(no|nope|don't|cancel|not now|stop)\b(?!.*\b(cheaper|instead|other)\b)/.test(t)) return 'decline';
  // Looking closer, comparing and swapping need something on the table: a plan waiting for a yes, or recent options.
  if (session.pending || Object.keys(session.offers || {}).length) {
    if (/\b(show me|see|back to|open)\b.*\bthe plan\b|^\s*(go )?back\b/.test(t) && session.pending) return 'show_plan';
    if (/\bcompare\b/.test(t)) return 'compare';
    if (/\b(remove|drop|take out)\b/.test(t) && session.pending) return 'remove';
    if (/\b(instead|swap|replace|switch to|go with)\b/.test(t)) return 'swap';
    if (/\bplan\b.*\bfor me\b|\b(choose|pick)\b/.test(t) && !session.pending) return 'choose';
    if (/\b(other options?|alternatives?|something else|what else|cheaper)\b/.test(t)) return 'alternatives';
    if (/\bwhy\b/.test(t)) return 'why';
    if (/\b(show me|look at|closer|details|tell me more|zoom)\b/.test(t)) return 'inspect';
  }
  if (/\bremember\b/.test(t)) return 'remember';
  if (/(weekly|monthly|a week|a month|per week|per month)/.test(t) && /budget|\$/.test(t)) return 'set_budget';
  if (/(moved|move|changed|postponed|delayed).*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/.test(t)) return 'plans_change';
  if (/(settle up|final bill|billed|they're done|all done|went well|refund)/.test(t)) return 'settle';
  if (/(under|budget|keep it)\s.*\$\d+/.test(t) && /(clean|dinner|cater|bedding|sheets)/.test(t)) return 'big_plan';
  if (/(out of|running low|need more|almost out)/.test(t)) return 'restock';
  if (/(how much|left|status|what's booked|what is booked|budget)/.test(t)) return 'status';
  if (/(clean|caterer|dinner|plumber|leak|handyman|fix)/.test(t)) return 'one_service';
  return 'unknown';
}

// Wishes inside one sentence ("a cleaner Friday, fresh bedding, and dinner for six at home Saturday").
export function wishes(u) {
  const t = u.toLowerCase();
  const out = [];
  const near = (re) => { const i = t.search(re); if (i < 0) return null; const tail = t.slice(i, i + 60); const d = DAY.exec(tail); return d ? cap(d[1]) : null; };
  if (/clean/.test(t)) out.push({ kind: 'service', category: 'cleaning', need: 'deep clean of the guest room and bath', when: `${near(/clean/) || 'Friday'} morning` });
  if (/(bedding|sheets|linen)/.test(t)) out.push({ kind: 'product', query: 'queen bedding sheets for the guest room' });
  if (/(dinner|cater)/.test(t)) {
    const g = /(?:for|of)\s+(\w+)/.exec(t.slice(t.search(/dinner|cater/)));
    out.push({ kind: 'service', category: 'catering', need: `dinner for ${g ? g[1] : 'six'} at home`, when: `${near(/dinner|cater/) || 'Saturday'} evening` });
  }
  if (/(plumb|leak)/.test(t)) out.push({ kind: 'service', category: 'plumbing', need: 'fix a leak', when: `${near(/plumb|leak/) || 'Monday'} morning` });
  if (/(handyman|fix|mount|assemble)/.test(t) && !/(plumb|leak)/.test(t)) out.push({ kind: 'service', category: 'handyman', need: 'small home fix', when: `${near(/handyman|fix|mount|assemble/) || 'Saturday'} morning` });
  return out;
}

function purposeOf(u, L) {
  const t = u.toLowerCase();
  if (/in-?laws/.test(t)) return I.tr(L, 'pur_inlaws');
  if (/(party|guests|visit|invités|invitados|fiesta|fête)/.test(t)) return I.tr(L, 'pur_guests');
  return I.tr(L, 'pur_plan');
}

// ---- what the user points at ("the bed linen", "the caterer", "Olive & Thyme", "the sateen set", "that") ----
const CATEGORY_WORDS = { cleaning: /\bclean(er|ers|ing)?\b|\bmaid/, catering: /\b(cater(er|ers|ing)?|dinner|food for|chef)\b/, plumbing: /\bplumb/, handyman: /\bhandy/ };
const PRODUCT_WORDS = { bedding: /\b(bed ?linen|linens?|bedding|sheets?|pillow\w*|sateen|percale|duvet|towels?)\b/, dog: /\b(dog|kibble)\b/, coffee: /\b(coffee|beans|roast|espresso|decaf)\b/ };
const fold = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const words = (x) => fold(x).split(/[^a-z0-9&]+/).filter((w) => w.length > 2 && !['the', 'and', 'for', 'with', 'set', 'from', 'des', 'les', 'pour', 'avec', 'del', 'los', 'las', 'con', 'para'].includes(w));
const familyOf = (o) => (o.kind === 'product' ? (/(sheet|bed|duvet|towel|pillow)/i.test(o.title) ? 'bedding' : /dog/i.test(o.title) ? 'dog' : /coffee|roast|decaf/i.test(o.title) ? 'coffee' : 'other') : o.category);
function known(session) {
  const out = new Map();
  for (const o of Object.values(session.offers || {})) out.set(o.id, { ...o, inPlan: false });
  for (const l of session.pending?.lines || []) out.set(l.offer_id, { ...(out.get(l.offer_id) || {}), id: l.offer_id, kind: l.kind, category: l.category, merchant: l.merchant, title: l.title, total: l.total, search_id: l.search_id, inPlan: true });
  return [...out.values()];
}
// Best match for the words of the utterance; ties go to `prefer` (in the plan, or not in the plan).
function pointAt(u, session, { prefer, locale } = {}) {
  const t = u.toLowerCase();
  const ws = new Set(words(t));
  const all = known(session);
  const score = (o) => {
    let s = 0;
    // the item's name as the user may say it: English catalogue title, or its French / Spanish name on the card
    for (const w of new Set(words(`${o.merchant} ${o.title} ${I.phrase(o.title, 'fr-FR')} ${I.phrase(o.title, 'es-ES')}`))) if (ws.has(w)) s += 3;
    const fam = familyOf(o);
    if (o.kind === 'service' && CATEGORY_WORDS[fam]?.test(t)) s += 2;
    if (o.kind === 'product' && PRODUCT_WORDS[fam]?.test(t)) s += 2;
    if (prefer === 'plan' && o.inPlan) s += 0.5;
    if (prefer === 'other' && !o.inPlan) s += 0.5;
    return s;
  };
  const ranked = all.map((o) => ({ o, s: score(o) })).filter((x) => x.s >= 2).sort((a, b) => b.s - a.s || a.o.total - b.o.total);
  if (ranked.length) return ranked[0].o;
  if (/\b(that|this|it|this one|that one)\b/.test(t) && session.focus) return all.find((o) => o.id === session.focus) || null;
  return null;
}
const sameSearch = (a, b) => (a.search_id && b.search_id ? a.search_id === b.search_id : familyOf(a) === familyOf(b) && a.kind === b.kind);
const label = (o) => (o.kind === 'service' ? o.merchant : String(o.title || '').split(':')[0]);

// Absorb a tool result into the session (pending plan, last alternatives). Pure: returns a new session.
export function absorb(session, name, result) {
  const s = { ...session };
  const d = sc(result);
  if (failed(result)) return s;
  const lines = (p) => p.lines.map((l) => ({ offer_id: l.offer_id, kind: l.kind, category: l.category, merchant: l.merchant, title: l.title, total: l.total, search_id: l.search_id || null }));
  if (name === 'propose_plan' || name === 'revise_plan') s.pending = d.needs_user_yes ? { plan_id: d.plan.id, token: d.confirmation_token, total: d.plan.breakdown.total, lines: lines(d.plan) } : null;
  if (name === 'confirm_plan') { s.pending = null; s.focus = null; }
  // options seen recently (for "show me", "other options", "take X instead"): the last 15, light
  const seen = d.offers || (d.offer ? [d.offer] : []);
  if (seen.length && ['find_home_services', 'find_products', 'list_alternatives', 'negotiate_offer', 'get_offer_details', 'compare_offers'].includes(name)) {
    const keep = Object.values({ ...(s.offers || {}) });
    for (const o of seen) keep.push({ id: o.id, kind: o.kind, category: o.category ?? null, merchant: o.merchant, title: o.title, total: o.total, search_id: o.search_id || null });
    s.offers = Object.fromEntries(keep.slice(-15).map((o) => [o.id, o]));
  }
  if (name === 'get_offer_details' && d.offer) s.focus = d.offer.id;
  return s;
}

export function decide({ utterance, session = {}, steps = [], locale }) {
  // French and Spanish are mapped to the words the playbooks know (I.canon); what Alexa says comes back in the
  // user's language (I.tr). The user's own words (a yes, a household fact) are kept as said.
  const L = I.normLocale(locale || session.locale || 'en-US');
  const lang = I.langOf(L);
  const raw = String(utterance || '');
  const u = I.canon(raw, L);
  const tl = (k, v) => I.tr(L, k, v);
  const usdL = (n) => I.money(n, L);
  const intent = classify(u, session);
  const last = steps[steps.length - 1];
  if (last && failed(last.result)) return say(said(last.result).replace(/ Next step:.*$/, ''));
  const n = steps.length;
  const dot = session.device === 'dot';
  const YES = ' ' + tl('p_say_yes');

  switch (intent) {
    case 'confirm':
      if (n === 0) return tool('confirm_plan', { plan_id: session.pending.plan_id, confirmation_token: session.pending.token, user_confirmation: raw.slice(0, 120) });
      return say(said(last.result));
    case 'decline':
      return say(tl('p_decline'));

    case 'show_plan':
      if (n === 0) return tool('review_plan', { plan_id: session.pending.plan_id });
      return say(said(last.result) + (dot ? YES : ''));

    case 'inspect': case 'why': {
      const o = pointAt(u, session, { prefer: 'plan' }) || (session.focus && known(session).find((x) => x.id === session.focus));
      if (!o) return say(tl('p_which'));
      if (n === 0) return tool('get_offer_details', { offer_id: o.id });
      return say(said(last.result));
    }

    case 'alternatives': {
      const o = pointAt(u, session, { prefer: 'plan' }) || (session.focus && known(session).find((x) => x.id === session.focus)) || (session.pending?.lines?.length === 1 ? known(session).find((x) => x.inPlan) : null);
      if (!o) return say(tl('p_alts_which'));
      if (n === 0) return tool('list_alternatives', { offer_id: o.id, cheaper_only: /cheaper|less expensive/i.test(u) });
      return say(said(last.result) + (session.pending ? ' ' + tl('p_say_instead') : ''));
    }

    case 'compare': {
      const all = known(session);
      const anchor = pointAt(u, session, { prefer: 'plan' }) || all.find((x) => x.id === session.focus);
      if (!anchor) return say(tl('p_compare_which'));
      const group = all.filter((x) => sameSearch(x, anchor)).sort((a, b) => (b.inPlan - a.inPlan) || a.total - b.total);
      const howMany = /\b(two|2|both)\b/i.test(u) ? 2 : 3;
      const ids = group.slice(0, howMany).map((x) => x.id);
      if (ids.length < 2) return say(tl('p_only_one'));
      if (n === 0) return tool('compare_offers', { offer_ids: ids });
      return say(said(last.result));
    }

    case 'swap': {
      if (!session.pending) return say(tl('p_no_plan'));
      const add = pointAt(u, session, { prefer: 'other' });
      if (!add || add.inPlan) return say(tl('p_swap_which'));
      const out = known(session).find((x) => x.inPlan && sameSearch(x, add)) || known(session).find((x) => x.inPlan && familyOf(x) === familyOf(add));
      if (n === 0) return tool('revise_plan', { plan_id: session.pending.plan_id, remove_offer_ids: out ? [out.id] : [], add_offer_ids: [add.id] });
      return say(said(last.result) + (dot ? YES : ''));
    }

    case 'remove': {
      const o = pointAt(u, session, { prefer: 'plan' });
      if (!o || !o.inPlan) return say(tl('p_remove_which'));
      if (n === 0) return tool('revise_plan', { plan_id: session.pending.plan_id, remove_offer_ids: [o.id] });
      return say(said(last.result) + (dot ? YES : ''));
    }

    case 'choose': {
      const o = pointAt(u, session, {}) || known(session).find((x) => x.id === session.focus);
      if (!o) return say(tl('p_choose_which'));
      if (n === 0) return tool('propose_plan', { item_ids: [o.id] });
      return say(said(last.result) + (dot && sc(last.result).needs_user_yes ? YES : ''));
    }

    case 'remember': {
      if (n === 0) {
        if (lang !== 'en') {
          // the fact is saved in the user's words; Mandat reads allergies in English, French and Spanish
          const t = raw.replace(lang === 'fr' ? /^.*?(?:souviens-toi|rappelle-toi|retiens|n['’]oublie pas)\s*(?:que\s*|qu['’]\s*)?/i : /^.*?(?:recuerda|acuérdate de|no olvides)\s*(?:que\s*)?/i, '').replace(/[.!]$/, '').trim();
          const dog = (lang === 'fr' ? /(\p{L}+),?\s+(?:notre|mon)\s+chien,?\s+est\s+(.*)$/iu : /(\p{L}+),?\s+(?:nuestro|mi)\s+perro,?\s+es\s+(.*)$/iu).exec(t);
          if (dog) return tool('remember_preference', { subject: `${cap(dog[1])} (${tl('sub_dog')})`, fact: dog[2] });
          if (/caf[ée]|torréfaction|tueste|roast/i.test(t)) return tool('remember_preference', { subject: tl('sub_coffee'), fact: cap(t) });
          return tool('remember_preference', { subject: lang === 'fr' ? 'Maison' : 'Casa', fact: cap(t) });
        }
        const t = u.replace(/^.*?\bremember\b\s*(that\s*)?/i, '').replace(/[.!]$/, '');
        const dog = /\b(\w+),?\s+(?:our|my)\s+dog,?\s+is\s+(.*)$/i.exec(t);
        if (dog) return tool('remember_preference', { subject: `${cap(dog[1])} (dog)`, fact: dog[2] });
        if (/coffee|roast/i.test(t)) return tool('remember_preference', { subject: 'Coffee', fact: cap(t) });
        const m = /^(\w+)\s+(is|are|likes|prefers|drinks|eats)\s+(.*)$/i.exec(t);
        return tool('remember_preference', m ? { subject: cap(m[1]), fact: `${m[2]} ${m[3]}` } : { subject: 'Household', fact: cap(t) });
      }
      return say(said(last.result));
    }

    case 'set_budget': {
      if (n === 0) {
        const amounts = [...u.matchAll(/\$\s?(\d+)/g)].map((m) => Number(m[1]));
        const auto = /(without asking|on your own|auto)/i.test(u) && amounts.length > 1 ? amounts[1] : 0;
        return tool('set_spending_mandate', { budget: amounts[0], currency: 'USD', period: /month/i.test(u) ? 'monthly' : 'weekly', auto_approve_under: auto, purpose: /grocer|courses|compra/i.test(u) ? tl('pur_groceries') : tl('pur_house') });
      }
      return say(said(last.result));
    }

    case 'status':
      if (n === 0) return tool('get_household_status', {});
      return say(said(last.result));

    case 'big_plan': {
      // set budget -> one search per wish -> one plan -> ask
      const ws = wishes(u);
      if (n === 0) return tool('set_spending_mandate', { budget: money(u), currency: 'USD', period: 'once', auto_approve_under: 0, purpose: purposeOf(u, L) });
      if (n <= ws.length) {
        const w = ws[n - 1];
        return w.kind === 'product' ? tool('find_products', { query: w.query, quantity: 1 }) : tool('find_home_services', { need: w.need, category: w.category, when: w.when });
      }
      if (n === ws.length + 1) {
        const ids = steps.slice(1, ws.length + 1).map((s) => best(s.result)?.id).filter(Boolean);
        return tool('propose_plan', { item_ids: ids, mandate_id: sc(steps[0].result).mandate.id, note: purposeOf(u, L) });
      }
      const asked = steps.slice(1, ws.length + 1).filter((s) => s.name === 'find_home_services').map((s) => { const k = sc(s.result).asked; return `${k} ${I.noun(sc(s.result).category, k, L)}`; });
      return say(`${asked.length ? tl('p_asked', { list: I.list(asked, L) }) : ''}${said(last.result)}${dot ? YES : ''}`);
    }

    case 'restock': {
      // one product at a time: under the auto-approve rule it is bought at once, above it Mandat asks.
      const items = [];
      if (/dog|kibble/i.test(u)) items.push('dog food');
      if (/coffee/i.test(u)) items.push('coffee');
      if (/(sheets|bedding)/i.test(u)) items.push('bedding');
      if (!items.length) items.push(u.replace(/^.*(out of|low on|need more)\s*/i, '').replace(/[.!?]$/, ''));
      // walk the items: find -> propose -> (confirm if auto)
      const lines = [];
      let i = 0, k = 0, asking = false;
      while (i < items.length) {
        const find = steps[k], prop = steps[k + 1], conf = steps[k + 2];
        if (!find) return tool('find_products', { query: items[i], quantity: 1 });
        if (!prop) return tool('propose_plan', { item_ids: [best(find.result).id], note: `Restock: ${items[i]}` });
        const p = sc(prop.result);
        if (p.needs_user_yes) {
          const o = best(find.result);
          lines.push(tl('p_restock_ask', { usual: o.matches_preference, title: I.phrase(o.title, L), total: usdL(p.plan.breakdown.total) }));
          asking = true;
          k += 2; i++;
          continue;
        }
        if (!conf) return tool('confirm_plan', { plan_id: p.plan.id, confirmation_token: p.confirmation_token });
        const skipped = sc(find.result).skipped || [];
        lines.push(tl('p_restock_bought', { title: I.phrase(best(find.result).title, L), total: usdL(p.plan.breakdown.total), skip: skipped.length ? tl('p_restock_skip', { n: skipped.length, ing: I.phrase(skipped[0].ingredient, L), because: skipped[0].because }) : '' }));
        k += 3; i++;
      }
      return say(lines.join(' ') + (dot && asking ? YES : ''));
    }

    case 'plans_change': {
      // status -> change each open service order of the event -> propose the replacement -> ask
      const day = cap(DAY.exec(u)[1].toLowerCase());
      const before = { Sunday: 'Saturday', Monday: 'Sunday', Tuesday: 'Monday', Wednesday: 'Tuesday', Thursday: 'Wednesday', Friday: 'Thursday', Saturday: 'Friday' }[day];
      if (n === 0) return tool('get_household_status', { section: 'orders' });
      const open = (sc(steps[0].result).open_orders || []).filter((o) => o.kind === 'service');
      const changes = open.map((o) => ({ o, value: /dinner|cater/i.test(o.label) ? day : before }));
      if (n <= changes.length) { const c = changes[n - 1]; return tool('change_order', { order_id: c.o.id, change: { field: 'date', value: c.value } }); }
      const declined = steps.slice(1, changes.length + 1).find((s) => (sc(s.result).alternatives || []).length);
      if (declined && n === changes.length + 1) {
        const alt = sc(declined.result).alternatives[0];
        const order = (sc(declined.result).receipt.orders || [])[0];
        return tool('propose_plan', { item_ids: [alt.id], mandate_id: order.mandate_id, note: 'Replacement after a date change' });
      }
      // what simply moved first, then what was declined (with its replacement)
      const told = steps.slice(1, changes.length + 1).sort((a, b) => (sc(a.result).alternatives ? 1 : 0) - (sc(b.result).alternatives ? 1 : 0)).map((s) => said(s.result)).join(' ');
      return say(`${told}${declined ? `${dot ? YES : ''}` : ''}`);
    }

    case 'settle': {
      // status -> capture every held order (with the final bill if one is given) -> refund if asked
      const finals = [...u.matchAll(/([A-Z][\w&' ]+?)\s+(?:billed|charged|final bill (?:is|was))\s+\$\s?(\d+(?:\.\d+)?)/g)].map((m) => ({ who: m[1].trim().toLowerCase(), amount: Number(m[2]) }));
      const refund = /refund\s+(?:the\s+)?\$\s?(\d+(?:\.\d+)?)\s*(?:for\s+the\s+)?(\w+)?/i.exec(u) || /refund.*?\$\s?(\d+(?:\.\d+)?)\s+(\w+)/i.exec(u);
      if (n === 0) return tool('get_household_status', {});
      // settle the event's orders (its own one-time budget), not the weekly restocks that are still on their way
      const status = sc(steps[0].result);
      const events = (status.mandates || []).filter((m) => m.period === 'once' && m.status === 'active').map((m) => m.id);
      const all = status.open_orders || [];
      const open = all.some((o) => events.includes(o.mandate_id)) ? all.filter((o) => events.includes(o.mandate_id)) : all;
      // close tokens come from receipts; the host keeps them in the session (orders map)
      const tokens = session.closeTokens || {};
      if (n <= open.length) {
        const o = open[n - 1];
        const f = finals.find((x) => o.merchant.toLowerCase().startsWith(x.who.split(' ')[0]));
        return tool('close_order', { order_id: o.id, action: 'capture', ...(f ? { amount: f.amount } : {}), confirmation_token: tokens[o.id] || 'missing-token' });
      }
      if (refund && n === open.length + 1) {
        const word = (refund[2] || '').toLowerCase();
        const target = open.find((o) => /pillow|bedding|sheet/.test(word) ? /bed|sheet|pillow/i.test(o.label) : true);
        if (target) return tool('close_order', { order_id: target.id, action: 'refund', amount: Number(refund[1]), confirmation_token: tokens[target.id] || 'missing-token' });
      }
      // one short summary instead of one sentence per order
      const done = steps.slice(1);
      const caps = done.filter((x) => x.args.action === 'capture' && !failed(x.result));
      const partial = caps.map((x) => said(x.result)).find((t) => I.PARTIAL_RE[lang].test(t));
      const ref = done.find((x) => x.args.action === 'refund' && !failed(x.result));
      const env = sc(done[done.length - 1]?.result).receipt?.envelope;
      const parts = [tl('p_paid', { n: caps.length })];
      if (partial) parts.push(partial.replace(I.LEFT_IN_RE[lang], ''));
      if (ref) parts.push(said(ref.result).replace(I.LEFT_IN_RE[lang], ''));
      if (env) parts.push(tl('left_in', { left: usdL(env.remaining), purpose: env.purpose }));
      return say(parts.join(' '));
    }

    case 'one_service': {
      const w = wishes(u)[0];
      if (!w) return say(tl('p_one_service'));
      if (n === 0) return tool('find_home_services', { need: w.need, category: w.category, when: w.when });
      return say(said(last.result) + (dot ? ' ' + tl('p_book_first') : ''));
    }
    default:
      return say(tl('p_default'));
  }
}

// Keep each order's close token from receipts (the settle step needs them).
export function absorbTokens(session, result) {
  const orders = sc(result).receipt?.orders || [];
  if (!orders.length) return session;
  const closeTokens = { ...(session.closeTokens || {}) };
  for (const o of orders) if (o.close_token) closeTokens[o.id] = o.close_token;
  return { ...session, closeTokens };
}
