// Look closer, compare and swap before saying yes: get_offer_details, list_alternatives, compare_offers,
// revise_plan, review_plan. Plus the live activity feed of a voice turn. Same money guardrails as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, client, inLawsPlan, sc, text, talker } from './helpers.mjs';
import { connectMcp } from '../src/brain/simulated.mjs';

const srv = await boot();
test.after(() => srv.close());

test('get_offer_details: gallery, specs, why, the rule, negotiation; voice-complete', async () => {
  const c = await client(srv.mcpUrl);
  const { clean, bed, food, plan } = await inLawsPlan(c);
  const r = await c.callTool({ name: 'get_offer_details', arguments: { offer_id: sc(bed).offers[0].id } });
  assert.ok(!r.isError, text(r));
  const d = sc(r);
  assert.equal(d.mode, 'detail');
  assert.ok(d.images.length >= 1 && d.images.every((i) => i.url.includes('/media/items/') && i.alt));
  assert.ok(d.in_plan);
  assert.equal(d.plan_id, sc(plan).plan.id);
  assert.match(text(r), /Guest bed bundle.*\$85.*Hearth & Linen/);
  assert.match(text(r), /in your plan/i);
  assert.equal(d.rule.buys_on_its_own, false);
  // a real business: estimated price with its rule, a booking request, its published data; never a negotiation
  const local = await c.callTool({ name: 'get_offer_details', arguments: { offer_id: sc(clean).offers[0].id } });
  const svc = sc(local);
  assert.ok(svc.why.some((w) => /^Estimated price: 2 h × \$50 per hour, a typical rate\. The business sets the real price$/.test(w.text) && w.tone === 'info'), svc.why.map((w) => w.text).join(' | '));
  assert.ok(svc.why.some((w) => /^Booking request only: .* has not confirmed it, and this demo does not send it$/.test(w.text)));
  assert.ok(svc.specs.some((x) => x.k === 'Estimate' && /\$100 · 2 h × \$50 per hour/.test(x.v)));
  assert.ok(svc.specs.some((x) => x.k === 'Source' && /OpenStreetMap/.test(x.v)));
  assert.match(text(local), /about \$100 estimated, requested for Friday at 10 AM.*booking request; they have not confirmed it/);
  assert.equal(svc.history.length, 0);
  // a demo partner: the negotiation, labelled simulated
  const partner = sc(await c.callTool({ name: 'get_offer_details', arguments: { offer_id: sc(food).offers[0].id } }));
  assert.ok(partner.why.some((w) => /\$15 off/.test(w.text)));
  assert.ok(partner.why.some((w) => /^Demo partner: a simulated merchant agent$/.test(w.text)));
  assert.equal(partner.history[0].list, 210);
  assert.equal(partner.history[0].total, 195);
  // the guest bed bundle is compared with the other sheet sets only (not with towels): it costs more, said in amber
  assert.ok(d.why.some((w) => /^Chosen for queen size, with 2 pillowcases, cotton percale and delivery in 2 days$/.test(w.text) && w.tone === 'plus'), d.why.map((w) => w.text).join(' | '));
  assert.ok(d.why.some((w) => w.tone === 'cost' && /Costs \$36 more than Queen microfiber sheet set, grey/.test(w.text)), d.why.map((w) => w.text).join(' | '));
  assert.ok(d.why.some((w) => /^Test catalogue/.test(w.text)));
  await c.close();
});

test('list_alternatives and compare_offers change nothing and say which is cheaper', async () => {
  const c = await client(srv.mcpUrl);
  const { bed, food, plan } = await inLawsPlan(c);
  const alts = await c.callTool({ name: 'list_alternatives', arguments: { offer_id: sc(bed).offers[0].id } });
  // Other options are the same kind of thing (sheets for sheets, never towels for sheets).
  const altOffers = sc(alts).offers;
  assert.ok(altOffers.length >= 2);
  const kind = altOffers[0].product_type;
  if (kind) for (const x of altOffers) assert.equal(x.product_type, kind);
  assert.match(text(alts), /other option/i);
  const cheaper = await c.callTool({ name: 'list_alternatives', arguments: { offer_id: sc(food).offers[0].id, cheaper_only: true } });
  assert.match(text(cheaper), /already the cheapest of the 5 caterers/);
  const cmp = await c.callTool({ name: 'compare_offers', arguments: { offer_ids: [sc(food).offers[0].id, sc(food).offers[1].id] } });
  assert.equal(sc(cmp).mode, 'compare');
  assert.equal(sc(cmp).cheapest_id, sc(food).offers[0].id);
  assert.match(text(cmp), /Hearth Table Catering is \$\d+ cheaper/);
  const one = await c.callTool({ name: 'compare_offers', arguments: { offer_ids: [sc(food).offers[0].id] } });
  assert.ok(one.isError);
  // still the same plan, still waiting
  const again = await c.callTool({ name: 'review_plan', arguments: {} });
  assert.equal(sc(again).plan.id, sc(plan).plan.id);
  assert.equal(sc(again).plan.breakdown.total, 380);
  await c.close();
});

test('revise_plan swaps an item: new total vs budget, new token; the old plan can no longer be paid', async () => {
  const c = await client(srv.mcpUrl);
  const { bed, plan } = await inLawsPlan(c);
  const king = sc(bed).offers.find((o) => /King sateen/.test(o.title));
  const r = await c.callTool({ name: 'revise_plan', arguments: { plan_id: sc(plan).plan.id, remove_offer_ids: [sc(bed).offers[0].id], add_offer_ids: [king.id] } });
  assert.ok(!r.isError, text(r));
  assert.equal(sc(r).plan.breakdown.total, 399);
  assert.equal(sc(r).plan.remaining_after, 1);
  assert.match(text(r), /Swapped Guest bed bundle for King sateen sheet set, white\. New total \$399, \$1 left of your \$400\. Should I book it\?/);
  assert.notEqual(sc(r).confirmation_token, sc(plan).confirmation_token);
  // the old plan and its token are dead
  const old = await c.callTool({ name: 'confirm_plan', arguments: { plan_id: sc(plan).plan.id, confirmation_token: sc(plan).confirmation_token, user_confirmation: 'yes' } });
  assert.ok(old.isError);
  // the new plan still needs a real yes
  const noYes = await c.callTool({ name: 'confirm_plan', arguments: { plan_id: sc(r).plan.id, confirmation_token: sc(r).confirmation_token, user_confirmation: 'show me more' } });
  assert.ok(noYes.isError);
  const yes = await c.callTool({ name: 'confirm_plan', arguments: { plan_id: sc(r).plan.id, confirmation_token: sc(r).confirmation_token, user_confirmation: 'yes' } });
  assert.ok(!yes.isError, text(yes));
  assert.equal(sc(yes).receipt.envelope.remaining, 1);
  await c.close();
});

test('revise_plan never goes over the budget, and refuses an empty or unchanged plan', async () => {
  const c = await client(srv.mcpUrl);
  const { food, plan } = await inLawsPlan(c);
  const basil = sc(food).offers.find((o) => o.merchant === 'Basil Street Caterers');
  const over = await c.callTool({ name: 'revise_plan', arguments: { plan_id: sc(plan).plan.id, remove_offer_ids: [sc(food).offers[0].id], add_offer_ids: [basil.id] } });
  assert.ok(over.isError);
  assert.match(text(over), /costs \$449 but only \$400 is left/);
  const all = sc(plan).plan.lines.map((l) => l.offer_id);
  assert.ok((await c.callTool({ name: 'revise_plan', arguments: { plan_id: sc(plan).plan.id, remove_offer_ids: all } })).isError);
  assert.ok((await c.callTool({ name: 'revise_plan', arguments: { plan_id: sc(plan).plan.id } })).isError);
  // the original plan is untouched by the refused swaps
  const still = await c.callTool({ name: 'review_plan', arguments: { plan_id: sc(plan).plan.id } });
  assert.equal(sc(still).plan.breakdown.total, 380);
  await c.close();
});

test('live activity: every tool call and every merchant answer of a turn lands on the feed, in order', async () => {
  const household = 'act-' + Math.random().toString(36).slice(2, 8);
  const turn = 'turn-' + Math.random().toString(36).slice(2, 10);
  const { client: c } = await connectMcp(srv.mcpUrl, { household, headers: { 'X-Mandat-Turn': turn } });
  await c.callTool({ name: 'set_spending_mandate', arguments: { budget: 400, period: 'once', purpose: 'Test' } });
  await c.callTool({ name: 'find_home_services', arguments: { need: 'deep clean', category: 'cleaning', when: 'Friday morning' } });
  await c.callTool({ name: 'find_home_services', arguments: { need: 'dinner for six', category: 'catering', when: 'Saturday evening', guests: 6 } });
  const r = await fetch(`${srv.url}/activity?household=${household}&turn=${turn}`);
  const { events } = await r.json();
  const texts = events.map((e) => `${e.state}:${e.text}`);
  assert.ok(texts.includes('done:Budget $400 set'), texts.join(' | '));
  assert.ok(texts.includes('done:4 cleaners near Capitol Hill · estimated prices'), texts.join(' | '));
  assert.ok(texts.includes('done:4 near Capitol Hill · 4 options'), texts.join(' | '));
  assert.ok(texts.includes('done:4 near Capitol Hill · 3 demo partners · 5 options'), texts.join(' | '));
  const hearth = events.find((e) => e.text === 'Hearth Table Catering');
  assert.equal(hearth.from, 210);
  assert.equal(hearth.to, 195);
  assert.match(hearth.detail, /^demo partner/);
  assert.ok(hearth.image_url.includes('/media/items/'));
  assert.ok(events.every((e) => e.state !== 'running'), 'every step finished');
  // another turn id sees nothing; a bad id is refused quietly
  assert.deepEqual((await (await fetch(`${srv.url}/activity?household=${household}&turn=turn-other-1`)).json()).events, []);
  assert.deepEqual((await (await fetch(`${srv.url}/activity?household=${household}&turn=../x`)).json()).events, []);
  await c.close();
});

test('spoken flow (simulated brain): look closer, other options, take the first one, compare caterers, yes; story 3 still fits', async () => {
  const say = talker(srv.mcpUrl, 'judge-' + Math.random().toString(36).slice(2, 7));
  const names = (o) => o.steps.map((s) => s.name);
  await say('Set a weekly household budget of $150, and buy on your own under $40.');
  const plan = await say('Alexa, my in-laws land Saturday. Get the guest room ready: a cleaner Friday, fresh bedding, and dinner for six at home Saturday. Keep it under $400.');
  assert.equal(sc(plan.steps.at(-1).result).plan.breakdown.total, 380);
  const look = await say('Show me the bed linen.');
  assert.deepEqual(names(look), ['get_offer_details']);
  assert.match(sc(look.steps[0].result).offer.title, /Guest bed bundle/);
  assert.match(look.speech, /in your plan/i);
  const others = await say('Other options?');
  assert.deepEqual(names(others), ['list_alternatives']);
  assert.ok(sc(others.steps[0].result).offers.some((o) => /microfiber/.test(o.title)), 'the bedding search stays under a fifth of the budget');
  const swap = await say('Take the first one instead.');
  assert.deepEqual(names(swap), ['revise_plan']);
  assert.match(swap.speech, /Swapped Guest bed bundle for Queen microfiber sheet set, grey\. New total \$344, \$56 left of your \$400\. Should I book it\?/);
  const cmp = await say('Compare the two caterers.');
  assert.deepEqual(names(cmp), ['compare_offers']);
  // the plan's caterer (a demo partner) against the best real caterer: an estimate, said as one
  assert.match(cmp.speech, /^Hearth Table Catering \(demo partner\): \$195, Saturday at 7 PM, \$15 off\. .+: about \$270 estimated, Saturday at 7 PM\. Hearth Table Catering is \$75 cheaper\.$/);
  const why = await say('Why this one?');
  assert.deepEqual(names(why), ['get_offer_details']);
  const back = await say('Show me the plan.');
  assert.deepEqual(names(back), ['review_plan']);
  assert.equal(sc(back.steps[0].result).plan.breakdown.total, 344);
  const yes = await say('Yes, book it.');
  assert.deepEqual(names(yes), ['confirm_plan']);
  assert.equal(sc(yes.steps[0].result).receipt.envelope.remaining, 56);
  // story 3 still works after the swap: the replacement caterer fits the $251 freed
  const moved = await say('Their flight moved to Sunday.');
  assert.match(moved.speech, /Olive & Thyme Kitchen can do Sunday at 7:30 PM for \$210/);
  const ok = await say('Yes, go ahead.');
  assert.equal(sc(ok.steps.at(-1).result).receipt.envelope.remaining, 400 - 100 - 49 - 210);
  const settle = await say('Everything went well. Settle up: Olive billed $180, and refund $10 on the sheets.');
  assert.match(settle.speech, /Refunded \$10 on the Home Basics Co order/);
});

test('"not this one, cheaper" is not a no; a swap with nothing better is said honestly', async () => {
  const say = talker(srv.mcpUrl, 'cheap-' + Math.random().toString(36).slice(2, 7));
  await say('Alexa, my in-laws land Saturday. Get the guest room ready: a cleaner Friday, fresh bedding, and dinner for six at home Saturday. Keep it under $400.');
  const r = await say('Not this caterer, something cheaper.');
  assert.deepEqual(r.steps.map((s) => s.name), ['list_alternatives']);
  assert.match(r.speech, /already the cheapest of the 5 caterers/);
  const over = await say('Swap the caterer for Basil Street Caterers.');
  assert.deepEqual(over.steps.map((s) => s.name), ['revise_plan']);
  assert.match(over.speech, /costs \$449 but only \$400 is left/);
});
