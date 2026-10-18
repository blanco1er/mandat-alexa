// The simulated "Alexa+ brain": a deterministic policy that plays the role of the model in the tool loop.
// Given the user's utterance, the household session (pending plan, device) and the tool results of this turn so
// far, it returns the next action: { type: 'tool', name, args } or { type: 'say', text }.
// Pure module (no Node imports): used by the simulated orchestrator, by the Strands ScriptedModel (orchestrator/),
// and by the tests. It only covers the demo intents; the Bedrock brain handles free-form requests.

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
  if (session.pending && /^\s*(yes|yeah|yep|sure|ok|okay|go ahead|do it|book it|buy it|confirm)/.test(t)) return 'confirm';
  if (session.pending && /^\s*(no|nope|don't|cancel|not now|stop)/.test(t)) return 'decline';
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

function purposeOf(u) {
  const t = u.toLowerCase();
  if (/in-?laws/.test(t)) return 'In-laws visit';
  if (/(party|guests|visit)/.test(t)) return 'Guests visit';
  return 'This plan';
}

// Absorb a tool result into the session (pending plan, last alternatives). Pure: returns a new session.
export function absorb(session, name, result) {
  const s = { ...session };
  const d = sc(result);
  if (failed(result)) return s;
  if (name === 'propose_plan') s.pending = d.needs_user_yes ? { plan_id: d.plan.id, token: d.confirmation_token, total: d.plan.breakdown.total } : null;
  if (name === 'confirm_plan') s.pending = null;
  return s;
}

export function decide({ utterance, session = {}, steps = [] }) {
  const u = String(utterance || '');
  const intent = classify(u, session);
  const last = steps[steps.length - 1];
  if (last && failed(last.result)) return say(said(last.result).replace(/ Next step:.*$/, ''));
  const n = steps.length;
  const dot = session.device === 'dot';

  switch (intent) {
    case 'confirm':
      if (n === 0) return tool('confirm_plan', { plan_id: session.pending.plan_id, confirmation_token: session.pending.token, user_confirmation: u.slice(0, 120) });
      return say(said(last.result));
    case 'decline':
      return say('Okay, I will not buy it. The plan stays unpaid.');

    case 'remember': {
      if (n === 0) {
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
        return tool('set_spending_mandate', { budget: amounts[0], currency: 'USD', period: /month/i.test(u) ? 'monthly' : 'weekly', auto_approve_under: auto, purpose: /grocer/i.test(u) ? 'Groceries' : 'Household essentials' });
      }
      return say(said(last.result));
    }

    case 'status':
      if (n === 0) return tool('get_household_status', {});
      return say(said(last.result));

    case 'big_plan': {
      // set budget -> one search per wish -> one plan -> ask
      const ws = wishes(u);
      if (n === 0) return tool('set_spending_mandate', { budget: money(u), currency: 'USD', period: 'once', auto_approve_under: 0, purpose: purposeOf(u) });
      if (n <= ws.length) {
        const w = ws[n - 1];
        return w.kind === 'product' ? tool('find_products', { query: w.query, quantity: 1 }) : tool('find_home_services', { need: w.need, category: w.category, when: w.when });
      }
      if (n === ws.length + 1) {
        const ids = steps.slice(1, ws.length + 1).map((s) => best(s.result)?.id).filter(Boolean);
        return tool('propose_plan', { item_ids: ids, mandate_id: sc(steps[0].result).mandate.id, note: purposeOf(u) });
      }
      const asked = steps.slice(1, ws.length + 1).filter((s) => s.name === 'find_home_services').map((s) => { const n = sc(s.result).asked; const c = sc(s.result).category; return `${n} ${c === 'catering' ? 'caterer' : c === 'cleaning' ? 'cleaner' : 'pro'}${n === 1 ? '' : 's'}`; });
      return say(`${asked.length ? `I asked ${asked.join(' and ')}. ` : ''}${said(last.result)}${dot ? ' Say yes to confirm.' : ''}`);
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
      let i = 0, k = 0;
      while (i < items.length) {
        const find = steps[k], prop = steps[k + 1], conf = steps[k + 2];
        if (!find) return tool('find_products', { query: items[i], quantity: 1 });
        if (!prop) return tool('propose_plan', { item_ids: [best(find.result).id], note: `Restock: ${items[i]}` });
        const p = sc(prop.result);
        if (p.needs_user_yes) {
          const o = best(find.result);
          lines.push(`${o.matches_preference ? 'Your usual ' : ''}${o.title} is ${'$' + p.plan.breakdown.total}, above your auto-approve limit, so I'm asking: should I buy it?`);
          k += 2; i++;
          continue;
        }
        if (!conf) return tool('confirm_plan', { plan_id: p.plan.id, confirmation_token: p.confirmation_token });
        const skipped = sc(find.result).skipped || [];
        lines.push(`I ordered ${best(find.result).title}, ${'$' + p.plan.breakdown.total}, under your auto-approve rule${skipped.length ? `, and skipped ${skipped.length} with ${skipped[0].ingredient} because ${skipped[0].because}` : ''}.`);
        k += 3; i++;
      }
      return say(lines.join(' ') + (dot && /should I buy/.test(lines.join(' ')) ? ' Say yes to confirm.' : ''));
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
      return say(`${told}${declined ? ` ${dot ? 'Say yes to confirm.' : ''}` : ''}`);
    }

    case 'settle': {
      // status -> capture every held order (with the final bill if one is given) -> refund if asked
      const finals = [...u.matchAll(/([A-Z][\w&' ]+?)\s+(?:billed|charged|final bill (?:is|was))\s+\$\s?(\d+(?:\.\d+)?)/g)].map((m) => ({ who: m[1].trim().toLowerCase(), amount: Number(m[2]) }));
      const refund = /refund\s+(?:the\s+)?\$\s?(\d+(?:\.\d+)?)\s*(?:for\s+the\s+)?(\w+)?/i.exec(u) || /refund.*?\$\s?(\d+(?:\.\d+)?)\s+(\w+)/i.exec(u);
      if (n === 0) return tool('get_household_status', { section: 'orders' });
      const open = sc(steps[0].result).open_orders || [];
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
      const partial = caps.map((x) => said(x.result)).find((t) => /less than held/.test(t));
      const ref = done.find((x) => x.args.action === 'refund' && !failed(x.result));
      const env = sc(done[done.length - 1]?.result).receipt?.envelope;
      const parts = [`Paid ${caps.length} ${caps.length === 1 ? 'order' : 'orders'}.`];
      if (partial) parts.push(partial.replace(/ \$[\d.,]+ left in .*$/, ''));
      if (ref) parts.push(said(ref.result).replace(/ \$[\d.,]+ left in .*$/, ''));
      if (env) parts.push(`$${env.remaining} left in ${env.purpose}.`);
      return say(parts.join(' '));
    }

    case 'one_service': {
      const w = wishes(u)[0];
      if (!w) return say('I can book cleaning, catering, plumbing and handyman services. Which one?');
      if (n === 0) return tool('find_home_services', { need: w.need, category: w.category, when: w.when });
      return say(said(last.result) + (dot ? ' Want me to book the first one?' : ''));
    }
    default:
      return say('I can set a household budget, find home services and products, book them inside your budget, and change or cancel orders. What do you need?');
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
