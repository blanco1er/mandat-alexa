// Seen live on 20 Oct 2026: story 2 bought two products on their own (two plans in one turn) and Alexa said
// "$184.01 is left in your weekly household budget", the balance after the first hold; the right one was $146.22.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureFinalBalances } from '../src/brain/honesty.mjs';
import { boot, talker } from './helpers.mjs';

const steps = (...rem) => rem.map((r) => ({ name: 'confirm_plan', result: { structuredContent: { receipt: { envelope: { mandate_id: 'week', purpose: 'Weekly household budget', remaining: r } } } } }));

test('a balance from an earlier step of the turn is replaced by the final one (EN/FR/ES)', () => {
  const s = steps(184.01, 146.22);
  assert.equal(ensureFinalBalances({ speech: 'I bought both. $184.01 is left in your weekly household budget.', steps: s }).speech, 'I bought both. $146.22 is left in your weekly household budget.');
  assert.equal(ensureFinalBalances({ speech: 'Il reste 184,01 $ sur le budget de la semaine.', steps: s }).speech, 'Il reste 146,22 $ sur le budget de la semaine.');
  assert.equal(ensureFinalBalances({ speech: 'Te quedan 184,01 $ esta semana.', steps: s }).speech, 'Te quedan 146,22 $ esta semana.');
});

test('a price equal to an earlier balance is never touched; a final balance stays; other budgets are separate', () => {
  const s = steps(180, 37.01);
  assert.equal(ensureFinalBalances({ speech: 'Olive & Thyme Kitchen was paid $180. You have $37.01 left.', steps: s }).speech, 'Olive & Thyme Kitchen was paid $180. You have $37.01 left.');
  const two = [...steps(184.01, 146.22), { name: 'confirm_plan', result: { structuredContent: { receipt: { envelope: { mandate_id: 'visit', remaining: 42.01 } } } } }];
  assert.equal(ensureFinalBalances({ speech: '$42.01 left for the visit, $184.01 left this week.', steps: two }).speech, '$42.01 left for the visit, $146.22 left this week.');
});

test('story 2 end to end: the spoken balance is the one after every hold of the turn', async () => {
  const srv = await boot();
  try {
    const say = talker(srv.mcpUrl, 'bal-' + Date.now().toString(36));
    await say('Alexa, set a weekly household budget of $150, and buy on your own under $40.');
    await say('Max, our dog, is allergic to chicken.');
    const out = await say("We're almost out of dog food and laundry detergent.");
    const envs = out.steps.map((x) => x.result?.structuredContent?.receipt?.envelope).filter(Boolean);
    const final = envs.at(-1)?.remaining;
    if (final != null) {
      const fixed = ensureFinalBalances(out).speech;
      for (const e of envs.slice(0, -1)) if (e.remaining !== final) assert.ok(!fixed.includes(String(e.remaining)), `stale ${e.remaining} in: ${fixed}`);
    }
  } finally { srv.close(); }
});
