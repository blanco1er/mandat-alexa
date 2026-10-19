// A total is never shown or said next to one item's price as if it were that item's price (UB-98 style ambiguity):
// the confirm prompt names the plan, and an item in the plan says the plan's total as a total.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, client, sc, text, inLawsPlan, talker } from './helpers.mjs';
import { setLang, t } from '../simulator/i18n.js';
import { tr } from '../src/core/i18n.mjs';

const srv = await boot();
test.after(() => srv.close());

test('the "say yes" prompt names the plan in English, French and Spanish (screen and voice)', () => {
  const want = { 'en-US': /confirm the plan · \$384/, 'fr-FR': /valider le plan · \$384/, 'es-ES': /confirmar el plan · \$384/ };
  for (const [loc, re] of Object.entries(want)) {
    setLang(loc);
    assert.match(t('Say “yes” to confirm the plan · {amt}', { amt: '$384' }), re, loc);
    assert.match(tr(loc, 'p_say_yes'), /plan/, loc);
    assert.match(tr(loc, 'e_need_yes', { total: '384 $' }), /plan \(384 \$/, loc);
  }
  setLang('en-US');
});

test('an item in the plan says the plan total as a total, never as its own price', async () => {
  const c = await client(srv.mcpUrl);
  const { bed } = await inLawsPlan(c);
  const r = await c.callTool({ name: 'get_offer_details', arguments: { offer_id: sc(bed).offers[0].id } });
  assert.match(text(r), /\$85 from Hearth & Linen.*It is in your plan \(\$380 in total\)\./);
  await c.close();
});

test('Echo Dot: the approval prompt says it confirms the plan', async () => {
  const say = talker(srv.mcpUrl, 'dot-word-' + Math.random().toString(36).slice(2, 7), 'dot');
  await say('Set a weekly household budget of $150, and buy on your own under $40.');
  await say('Remember that Max, our dog, is allergic to chicken.');
  await say('Remember we use Seventh Generation detergent.');
  const out = await say("We're almost out of dog food and laundry detergent.");
  assert.match(out.speech, /Say yes to confirm the plan\.$/);
});
