// The three demo stories against real Amazon Bedrock (Nova 2 Lite): Strands brain + Nova merchant agents, through
// a real local MCP server (Streamable HTTP). Costs a few cents per run; every call is counted (core/spend.mjs).
//   AWS_PROFILE=mandat node scripts/live-scenarios.mjs [runs=1] [story=all|setup|1|2|3]
// Each story uses a fresh Strands agent (no chat history: memory comes from the MCP server's store only, as on a
// cold Lambda container). The session (pending plan) travels between turns like the simulator sends it.
// Exit code 1 if a check fails. Output: one line per turn (tools, speech, tokens), then a summary with the cost.
// LIVE_URL=https://<function-url> runs the same stories against a deployed endpoint's POST /turn instead (the
// brain then runs on Lambda; the cost is read from the endpoint's shared ledger in /healthz).
process.env.MANDAT_STORE = 'memory';
process.env.MANDAT_PAYPAL = process.env.MANDAT_PAYPAL || 'offline';
process.env.MANDAT_MODEL = process.env.MANDAT_MODEL || 'bedrock';
process.env.MANDAT_LIMIT_MCP = '0';
process.env.MANDAT_LIMIT_TURNS = '0';
if (!process.env.MANDAT_LLM_BUDGET_USD) process.env.MANDAT_LLM_BUDGET_USD = '2';

const { start } = await import('../src/server.mjs');
const { createStrandsBrain } = await import('../orchestrator/brain.mjs');
const { spendView } = await import('../src/core/spend.mjs');

const runs = Number(process.argv[2] || 1);
const only = process.argv[3] || 'all';
const sc = (r) => r?.structuredContent || {};
const names = (out) => out.steps.map((s) => s.name);
const lastOk = (out, name) => [...out.steps].reverse().find((s) => s.name === name && !s.result?.isError)?.result;
const allOk = (out, name) => out.steps.filter((s) => s.name === name && !s.result?.isError).map((s) => s.result);

const STORIES = {
  setup: [
    ['Set a weekly household budget of $150, and buy on your own under $40.', (o) => {
      const m = sc(lastOk(o, 'set_spending_mandate')).mandate;
      return [['weekly $150 mandate, auto under $40', m && m.budget === 150 && m.period === 'weekly' && m.auto_approve_under === 40]];
    }],
    ['Remember that Max, our dog, is allergic to chicken.', (o) => [['preference saved', !!lastOk(o, 'remember_preference')]]],
    ['Remember we drink Northbeam medium roast.', (o) => [['preference saved', !!lastOk(o, 'remember_preference')]]],
  ],
  1: [
    ['Alexa, my in-laws land Saturday. Get the guest room ready: a cleaner Friday, fresh bedding, and dinner for six at home Saturday. Keep it under $400.', (o) => {
      const p = sc(lastOk(o, 'propose_plan'));
      const cats = allOk(o, 'find_home_services').map((r) => sc(r).category);
      return [
        ['$400 one-off budget', allOk(o, 'set_spending_mandate').some((r) => sc(r).mandate?.budget === 400)],
        ['cleaners and caterers asked', cats.includes('cleaning') && cats.includes('catering')],
        ['bedding searched', !!lastOk(o, 'find_products')],
        ['one plan, 3 lines, under $400', p.plan?.lines?.length === 3 && p.plan.breakdown.total <= 400],
        ['plan total (story: $372)', p.plan?.breakdown?.total, 'info'],
        ['asks for a yes, no money moved', p.needs_user_yes === true && !lastOk(o, 'confirm_plan')],
      ];
    }],
    ['Yes, book it.', (o) => {
      const r = sc(lastOk(o, 'confirm_plan')).receipt;
      return [['3 holds placed', r?.orders?.length === 3 && r.orders.every((x) => x.state === 'held')]];
    }],
  ],
  2: [
    ["We're almost out of dog food and coffee.", (o) => {
      const finds = allOk(o, 'find_products').map(sc);
      const dog = finds.find((f) => (f.offers || []).some((x) => /dog|kibble/i.test(x.title)));
      const confirms = allOk(o, 'confirm_plan').map((r) => sc(r).receipt);
      const proposals = allOk(o, 'propose_plan').map(sc);
      return [
        ['no chicken recipe offered', !!dog && dog.offers.every((x) => !/chicken/i.test(x.title))],
        ['dog food bought on its own (under $40)', confirms.some((r) => r?.orders?.some((x) => /dog|kibble|salmon/i.test(x.title || x.label || x.merchant || '')) && r.orders.every((x) => x.amount <= 40))],
        ['coffee waits for a yes', proposals.some((p) => p.needs_user_yes === true && p.plan.lines.some((l) => /northbeam|coffee/i.test(l.title || l.label || '')))],
      ];
    }],
    ['Yes.', (o) => [['coffee bought after the yes', !!lastOk(o, 'confirm_plan')]]],
  ],
  3: [
    ['Their flight moved to Sunday.', (o) => {
      const changes = allOk(o, 'change_order').map(sc);
      const orders = changes.map((c) => c.receipt?.orders?.[0]).filter(Boolean);
      return [
        ['cleaner moved, same hold', orders.some((x) => /BrightNest/.test(x.merchant) && x.state === 'held')],
        ['caterer declined, hold voided', orders.some((x) => /Hearth/.test(x.merchant) && x.state === 'released')],
        ['replacement proposed, waits for a yes', allOk(o, 'propose_plan').some((r) => sc(r).needs_user_yes === true)],
      ];
    }],
    ['Yes, go ahead.', (o) => [['replacement booked', !!lastOk(o, 'confirm_plan')]]],
    ['Everything went well. Settle up: Olive billed $180, and refund the $28 pillowcases.', (o) => {
      const orders = allOk(o, 'close_order').map((r) => sc(r).receipt?.orders?.[0]).filter(Boolean);
      const olive = orders.find((x) => /Olive/.test(x.merchant));
      return [
        ['Olive captured $180, rest released', olive?.captured === 180 && olive.timeline.some((t) => t.state === 'released')],
        ['pillowcases refunded', orders.some((x) => x.timeline?.some((t) => t.state === 'refunded'))],
      ];
    }],
    ['How much is left?', (o) => [['answers with the budget', /\$\d+/.test(o.speech)]]],
  ],
};

const LIVE = (process.env.LIVE_URL || '').replace(/\/$/, '');
const srv = LIVE ? { url: LIVE, close: async () => {} } : await start({ port: 0, storeKind: 'memory', modelKind: process.env.MANDAT_MODEL, brainKind: 'none' });
// The deployed demo requires account linking: each run links a fresh empty household (OAuth 2.1 + PKCE, like Alexa).
const { linkHousehold } = await import('./link-demo.mjs');
const links = new Map();
const tokenFor = async (household) => { if (!links.has(household)) links.set(household, (await linkHousehold(LIVE, { choice: 'new' })).access_token); return links.get(household); };
const remoteBrain = () => ({
  async runTurn({ text, session, household }) {
    const r = await fetch(`${LIVE}/turn`, { method: 'POST', headers: { 'content-type': 'application/json', origin: LIVE, authorization: `Bearer ${await tokenFor(household)}` }, body: JSON.stringify({ text, session, household, device: session.device || 'show' }) });
    const out = await r.json();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${out.speech || out.error}`);
    return out;
  },
  async close() {},
});
const before = LIVE ? (await (await fetch(`${LIVE}/healthz`)).json()).llm_budget : null;
const results = [];
const order = only === 'all' ? ['setup', 1, 2, 3] : ['setup', ...(only === 'setup' ? [] : (only === '1' ? [1] : only === '2' ? [1, 2] : [1, 2, 3]))];
// stories build on each other (story 3 changes story 1's bookings): earlier ones are replayed when one is asked for
for (let run = 1; run <= runs; run++) {
  const household = `live-${Date.now().toString(36)}-${run}`;
  let session = { device: 'show' };
  for (const key of order) {
    const brain = LIVE ? remoteBrain() : await createStrandsBrain({ mcpUrl: `${srv.url}/mcp`, model: 'bedrock' });
    for (const [text, check] of STORIES[key]) {
      const t0 = Date.now();
      let out;
      try { out = await brain.runTurn({ text, session, household }); } catch (e) { out = { speech: `ERROR ${e.name}: ${e.message}`, steps: [], session }; }
      session = { ...out.session, device: 'show' };
      const ms = Date.now() - t0;
      const checks = check(out);
      const failed = checks.filter(([, ok, kind]) => kind !== 'info' && !ok);
      results.push({ run, story: key, text, ok: !failed.length, ms });
      console.log(`\n[run ${run} · story ${key}] "${text.slice(0, 70)}" · ${ms} ms · ${out.usage ? `${out.usage.inputTokens} in / ${out.usage.outputTokens} out` : ''} · ${out.stopReason || ''}`);
      console.log(`  skills active: ${(out.skills || []).join(', ') || 'none'}`);
      console.log(`  tools: ${names(out).map((n, i) => (out.steps[i].result?.isError ? `${n}(ERROR)` : n)).join(' → ') || '(none)'}`);
      for (const s of out.steps.filter((x) => x.result?.isError)) console.log(`  tool error ${s.name}: ${s.result.content?.[0]?.text}`);
      if (process.env.LIVE_VERBOSE) for (const s of out.steps) {
        const d = sc(s.result);
        if (d.offers) console.log(`    ${s.name}(${JSON.stringify(s.args).slice(0, 120)}): ${d.offers.map((o) => `${o.id} ${o.merchant} $${o.total}`).join(' | ')}${d.declined?.length ? ` · declined: ${d.declined.map((x) => `${x.merchant}: ${x.reply}`).join(' | ')}` : ''}`);
        else console.log(`    ${s.name}(${JSON.stringify(s.args).slice(0, 200)})`);
      }
      for (const s of out.steps.filter((x) => x.name === 'propose_plan' && !x.result?.isError)) console.log(`  plan: ${sc(s.result).plan.lines.map((l) => `${l.merchant} $${l.total}`).join(' + ')} = $${sc(s.result).plan.breakdown.total}`);
      console.log(`  says: ${out.speech}`);
      for (const [label, ok, kind] of checks) console.log(`  ${kind === 'info' ? 'ℹ' : ok ? '✓' : '✗'} ${label}${kind === 'info' ? `: ${ok}` : ''}`);
    }
    await brain.close();
  }
}
await srv.close();
const spend = spendView();
if (LIVE) {
  const after = (await (await fetch(`${LIVE}/healthz`)).json()).llm_budget;
  Object.assign(spend, { usd: (after?.usd || 0) - (before?.usd || 0), calls: 0, byModel: {} });
  console.log(`\nendpoint ledger: $${before?.usd} -> $${after?.usd} of $${after?.budget} (may lag ~10 s between containers)`);
}
const bad = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - bad.length}/${results.length} turns passed · median ${results.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)]} ms/turn · model spend $${spend.usd.toFixed(4)} (${spend.calls} calls)`);
for (const [m, v] of Object.entries(spend.byModel || {})) console.log(`    ${m}: ${v.calls} calls, ${v.in} in / ${v.out} out tokens, $${v.usd.toFixed(4)}`);
process.exit(bad.length ? 1 : 0);
