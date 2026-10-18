// The Mandat MCP server: 10 intent tools + 1 app-only tool + 5 MCP Apps views, on @modelcontextprotocol/sdk 1.32.1.
// Stateless: one McpServer per HTTP request (Lambda-friendly); state lives in the store under explicit ids
// (mandate_id, offer_id, plan_id, order_id), which is the pattern AWS recommends for stateless MCP servers.
// Every tool result carries:
//   content[0]          what the assistant says, readable aloud (no ids, no pipes)
//   content[1]          compact ids for the assistant ("do not read aloud"), for hosts that do not pass
//                       structuredContent to the model (MCP Apps: structuredContent is NOT added to model context)
//   structuredContent   the full data, rendered by the card
//   _meta.ui            { resourceUri, invoking, invoked } (MCP Apps resourceUri + the Alexa+ client convention)
// Errors are tool execution errors (isError: true) with one next step, per the 2025-11-25 changelog.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolError } from '../mandat.mjs';
import { cards, CARD_NAMES, MCP_APP_MIME, resourceUiMeta, UI_EXTENSION } from './ui.mjs';

export const SERVER_INFO = { name: 'mandat-for-alexa-plus', title: 'Mandat for Alexa+', version: '0.1.0' };
export const INSTRUCTIONS = `Mandat runs household errands inside a spending budget the user set once.
Flow: find_home_services / find_products -> (negotiate_offer) -> propose_plan -> read the total aloud -> the user says yes -> confirm_plan with user_confirmation set to the user's words.
Never call confirm_plan for a plan that needs a yes before the user has said it. Never invent ids: use the ones in the results.
Speak content[0] only. Offer at most 5 options (3 on screenless devices). After an error, propose the one next step it gives.`;

const HOUSEHOLD_RE = /^[a-z0-9_-]{1,40}$/i;
export function householdFrom(extra, fallback = 'demo') {
  const h = extra?.requestInfo?.headers?.['x-mandat-household'];
  const v = Array.isArray(h) ? h[0] : h;
  return v && HOUSEHOLD_RE.test(v) ? v : fallback;
}

// What the assistant needs to chain calls, nothing more.
function idsFor(tool, d) {
  switch (tool) {
    case 'set_spending_mandate': return { mandate_id: d.mandate?.id, status: d.mandate?.status, approval_url: d.approval_url || undefined };
    case 'get_household_status': {
      const purpose = Object.fromEntries((d.envelopes || []).map((e) => [e.mandate_id, e.purpose]));
      return { mandates: d.envelopes?.map((e) => ({ mandate_id: e.mandate_id, purpose: e.purpose, remaining: e.remaining })), open_orders: d.open_orders?.map((o) => ({ order_id: o.id, kind: o.kind, category: o.category || undefined, merchant: o.merchant, item: o.label, when: o.slotLabel || undefined, amount: o.amount, state: o.state, mandate_id: o.mandate_id, budget: o.purpose || purpose[o.mandate_id] })), pending: d.pending_decisions };
    }
    case 'find_home_services': case 'find_products': case 'negotiate_offer':
      // offers come best first (cheapest verified service; for products, the household's usual brand first)
      return { recommended_offer_id: d.offers?.[0]?.id, offers: (d.offers || []).map((o) => ({ offer_id: o.id, merchant: o.merchant, title: o.title, total: o.total, when: o.slot_label })) };
    case 'propose_plan': return { plan_id: d.plan?.id, mandate_id: d.plan?.mandate_id, total: d.plan?.breakdown?.total, needs_user_yes: d.needs_user_yes, confirmation_token: d.confirmation_token };
    case 'confirm_plan': case 'change_order': case 'close_order':
      return { orders: d.receipt?.orders?.map((o) => ({ order_id: o.id, merchant: o.merchant, state: o.state, amount: o.amount, captured: o.captured || undefined, mandate_id: o.mandate_id, close_token: o.close_token })), alternatives: d.alternatives?.map((o) => ({ offer_id: o.id, merchant: o.merchant, total: o.total, when: o.slot_label })), replacement: d.alternatives?.length ? `propose_plan with item_ids ["${d.alternatives[0].id}"] and mandate_id "${d.receipt?.orders?.[0]?.mandate_id}"` : undefined };
    default: return {};
  }
}

const UI_TEXT = {
  get_household_status: ['Checking your household…', 'Household status ready'],
  set_spending_mandate: ['Setting your budget…', 'Budget set'],
  remember_preference: ['Saving that…', 'Saved'],
  find_home_services: ['Asking local pros…', 'Quotes ready'],
  find_products: ['Searching products…', 'Products found'],
  negotiate_offer: ['Negotiating…', 'Merchant answered'],
  propose_plan: ['Building your plan…', 'Plan ready'],
  confirm_plan: ['Placing payment holds…', 'Booked'],
  change_order: ['Contacting the merchant…', 'Merchant answered'],
  close_order: ['Updating the payment…', 'Payment updated'],
  refresh_card: ['Refreshing…', 'Up to date'],
};

export function createMcpServer({ service, household = householdFrom }) {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, extensions: { [UI_EXTENSION]: {} } },
    instructions: INSTRUCTIONS,
  });
  const ui = cards();

  // ---------- resources: the 5 cards ----------
  for (const name of CARD_NAMES) {
    const c = ui[name];
    server.registerResource(`card-${name}`, c.uri, { title: c.title, description: `Mandat ${c.title.toLowerCase()} card (MCP App view)`, mimeType: MCP_APP_MIME, _meta: resourceUiMeta(service.publicUrl) },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: MCP_APP_MIME, text: c.html, _meta: resourceUiMeta(service.publicUrl) }] }));
  }

  // ---------- tools ----------
  const tool = (name, { title, description, input, card, annotations = {}, visibility }, run) => {
    const [invoking, invoked] = UI_TEXT[name];
    const uiMeta = { resourceUri: ui[card].uri, invoking, invoked, ...(visibility ? { visibility } : {}) };
    server.registerTool(name, { title, description, inputSchema: input, annotations: { title, ...annotations }, _meta: { ui: uiMeta } }, async (args, extra) => {
      const hid = household(extra);
      try {
        const out = await run(hid, args);
        const cardName = out.card || card;
        const data = { ...out.data, ...(out.duplicate ? { duplicate: true } : {}) };
        return {
          content: [
            { type: 'text', text: out.speech || invoked },
            { type: 'text', text: `Assistant data (do not read aloud): ${JSON.stringify(idsFor(name, data))}` },
          ],
          structuredContent: data,
          _meta: { ui: { resourceUri: ui[cardName].uri, invoking, invoked } },
        };
      } catch (e) {
        if (e instanceof ToolError) return { isError: true, content: [{ type: 'text', text: `${e.message} Next step: ${e.next}` }] };
        console.error(`[mcp] ${name} failed:`, e);
        return { isError: true, content: [{ type: 'text', text: `Something went wrong on Mandat's side. Next step: call get_household_status to see what was done before trying again.` }] };
      }
    });
  };

  const money = z.number().positive().max(5000);

  tool('get_household_status', {
    title: 'Household budget and orders',
    description: 'Use when the user asks how much budget is left, what is booked or on the way, or what Mandat remembers about the household. Returns the spending envelopes, open orders, saved preferences and plans waiting for a yes.',
    input: { section: z.enum(['budget', 'orders', 'preferences']).optional().describe('Limit the answer to one part; omit for everything.') },
    card: 'status', annotations: { readOnlyHint: true, openWorldHint: false },
  }, (hid, a) => service.getHouseholdStatus(hid, a));

  tool('set_spending_mandate', {
    title: 'Set a spending budget',
    description: 'Use when the user gives Mandat a budget ("keep it under $400", "$150 a week for groceries") or an auto-approve rule ("buy without asking under $40"). Creates the envelope Mandat must stay inside and the one-time PayPal approval. A new budget with the same purpose and period replaces the old one.',
    input: {
      budget: money.describe('Total amount the household allows, in currency units.'),
      currency: z.enum(['USD']).default('USD').describe('Currency (USD in this sandbox).'),
      period: z.enum(['once', 'weekly', 'monthly']).describe('once for a single event, or a recurring envelope.'),
      auto_approve_under: z.number().min(0).max(5000).default(0).describe('Mandat may pay on its own up to this amount per plan; 0 means always ask.'),
      purpose: z.string().min(2).max(80).describe('Short name the user will hear, e.g. "In-laws visit" or "Household essentials".'),
    },
    card: 'mandate', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (hid, a) => service.setSpendingMandate(hid, a));

  tool('remember_preference', {
    title: 'Remember a household preference',
    description: 'Use when the user states a lasting fact about the household: allergies ("Max is allergic to chicken"), brands ("we drink Northbeam medium roast"), access notes. Saved across sessions and applied to every later search.',
    input: { subject: z.string().min(1).max(80).describe('Who or what it is about, e.g. "Max (dog)" or "Coffee".'), fact: z.string().min(2).max(240).describe('The fact, in the user\'s words.') },
    card: 'status', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (hid, a) => service.rememberPreference(hid, a));

  tool('find_home_services', {
    title: 'Get quotes from local home services',
    description: 'Use when the user needs a service at home: cleaning, catering, plumbing or handyman work. Asks every matching merchant agent in parallel, verifies each agent\'s signed identity card, and returns up to 5 negotiated quotes, cheapest first. Does not book anything.',
    input: {
      need: z.string().min(2).max(200).describe('What is needed, in the user\'s words, e.g. "dinner for six at home".'),
      category: z.enum(['cleaning', 'catering', 'plumbing', 'handyman']).describe('Type of service.'),
      when: z.string().min(2).max(80).describe('Day and time wished, e.g. "Friday before noon" or "Saturday 7pm".'),
      area: z.string().max(60).optional().describe('Neighbourhood, to prefer closer merchants.'),
      max_price: z.number().positive().max(5000).optional().describe('Skip quotes above this total.'),
      guests: z.number().int().min(1).max(30).optional().describe('Number of guests: required for catering (prices are per guest).'),
    },
    card: 'offers', annotations: { readOnlyHint: true, openWorldHint: true },
  }, (hid, a) => service.findHomeServices(hid, a));

  tool('find_products', {
    title: 'Find household products',
    description: 'Use when the user needs things delivered: bedding, pet food, coffee, household supplies. Filters out anything that conflicts with saved household preferences (allergies) and puts the household\'s usual brand first. Returns up to 5 products with delivery. Does not buy anything.',
    input: {
      query: z.string().min(2).max(200).describe('What to look for, e.g. "dog food" or "queen sheets for the guest room".'),
      max_price: z.number().positive().max(5000).optional().describe('Highest price per item.'),
      quantity: z.number().int().min(1).max(10).default(1).describe('How many units. Leave it out (1) unless the user said a number: one bedding set covers a bed.'),
    },
    card: 'offers', annotations: { readOnlyHint: true, openWorldHint: true },
  }, (hid, a) => service.findProducts(hid, a));

  tool('negotiate_offer', {
    title: 'Negotiate a quote',
    description: 'Use when the user wants a better price or a different slot on one service quote ("can they do better if we take Friday morning?"). Sends one message to the merchant\'s agent and returns the updated quote. The merchant never goes below its own floor.',
    input: { offer_id: z.string().min(3).max(40).describe('offer_id from find_home_services.'), ask: z.string().min(2).max(200).describe('What to ask the merchant, e.g. "Friday morning for $80?".') },
    card: 'offers', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (hid, a) => service.negotiateOffer(hid, a));

  tool('propose_plan', {
    title: 'Propose a plan to approve',
    description: 'Use once the options are chosen. Groups them into one plan with the price breakdown (base, negotiated discount, fees, tax, total), checks it fits the budget, and says whether it is under the auto-approve rule. Returns a confirmation_token. Moves no money. If needs_user_yes is true, read the total aloud and ask the user to say yes.',
    input: {
      item_ids: z.array(z.string().min(3).max(40)).min(1).max(5).describe('offer_ids to include.'),
      mandate_id: z.string().max(40).optional().describe('Which budget pays; omit to use the household\'s recurring envelope.'),
      note: z.string().max(200).optional().describe('Optional note for the household, e.g. "for the in-laws visit".'),
    },
    card: 'plan', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (hid, a) => service.proposePlan(hid, a));

  tool('confirm_plan', {
    title: 'Confirm and place payment holds',
    description: 'Use only after the user explicitly said yes to a proposed plan (or when propose_plan said it is under the auto-approve rule). Places one PayPal authorization hold per item; nothing is captured until the service is done. Idempotent: calling it again for the same plan returns the same receipt and never pays twice.',
    input: {
      plan_id: z.string().min(3).max(40).describe('plan_id from propose_plan.'),
      confirmation_token: z.string().min(8).max(64).describe('confirmation_token from propose_plan.'),
      user_confirmation: z.string().max(120).optional().describe('The user\'s own words of approval, e.g. "Yes, book it". Required when propose_plan returned needs_user_yes.'),
    },
    card: 'receipt', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (hid, a) => service.confirmPlan(hid, a));

  tool('change_order', {
    title: 'Change a booked order',
    description: 'Use when plans change on a booked service: a new date, a new time or a new number of guests. Asks the merchant\'s agent. If the merchant declines, Mandat voids that payment hold at once and returns replacement options to propose (with the same mandate_id). When guests now arrive on another day, call it once for every service of that event: work needed before they arrive (cleaning) moves to the day before the new arrival day, the dinner moves to the new day.',
    input: {
      order_id: z.string().min(3).max(40).describe('order_id from a receipt or get_household_status.'),
      change: z.object({ field: z.enum(['date', 'time', 'quantity']), value: z.string().min(1).max(60).describe('New value, e.g. "Sunday", "7pm" or "5".') }).describe('The one thing to change.'),
    },
    card: 'receipt', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (hid, a) => service.changeOrder(hid, a));

  tool('close_order', {
    title: 'Pay, cancel or refund an order',
    description: 'Use when a service is done (capture: pays the merchant, a lower final bill captures less and releases the rest), when the user cancels before it happens (cancel: voids the hold), or for money back (refund, full or partial: on an order still on hold, a part refund first pays the rest). To settle up after an event, capture every held order of that event, with the final bill as amount when the user gives one. Needs the order\'s close_token from its receipt.',
    input: {
      order_id: z.string().min(3).max(40),
      action: z.enum(['capture', 'cancel', 'refund']),
      amount: z.number().positive().max(5000).optional().describe('For capture: the final bill if lower than the hold. For refund: the amount back; omit for a full refund.'),
      confirmation_token: z.string().min(8).max(64).describe('close_token of this order, from its receipt.'),
    },
    card: 'receipt', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, (hid, a) => service.closeOrder(hid, a));

  // App-only: the cards call it to refresh themselves; hidden from the model (MCP Apps visibility).
  tool('refresh_card', {
    title: 'Refresh a Mandat card',
    description: 'Used by Mandat cards to refresh their content. Not for the assistant.',
    input: { card: z.enum(['status', 'plan', 'receipt']), plan_id: z.string().max(40).optional(), order_ids: z.array(z.string().max(40)).max(10).optional() },
    card: 'status', annotations: { readOnlyHint: true, openWorldHint: false }, visibility: ['app'],
  }, (hid, a) => service.refreshCard(hid, a));

  // McpServer turns listChanged on when the first tool/resource is registered. This server is stateless and its
  // lists never change at runtime, so it announces what it really does (found with MCP Inspector).
  server.server.registerCapabilities({ tools: { listChanged: false }, resources: { listChanged: false } });
  return server;
}
