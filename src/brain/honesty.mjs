// What is real and what is not is said by the code, not left to the model. A tool result that needs an honesty
// sentence carries it in structuredContent.honesty = { text, must } (src/mandat.mjs). After the model's turn, the
// host checks the spoken answer: if it dropped that sentence (seen live: Nova 2 Lite summarises the plan and leaves
// out "test money" and "booking request"), the sentence is added, in the user's language, once.
export function ensureHonesty(out = {}) {
  const speech = String(out.speech || '');
  const needs = [];
  for (const s of out.steps || []) {
    const h = s.result?.structuredContent?.honesty;
    if (!h || s.result?.isError) continue;
    for (const one of [].concat(h)) if (one?.text && !needs.some((x) => x.text === one.text && x.must === one.must)) needs.push(one);
  }
  const missing = needs.filter((h) => !new RegExp(h.must, 'iu').test(speech) && !speech.includes(h.text));
  if (!missing.length) return out;
  // the last answer wins: say only the sentences of the latest results that need one (at most two)
  const add = [...new Set(missing.map((h) => h.text))].slice(-2).join(' ');
  return { ...out, speech: `${speech.replace(/\s+$/, '')} ${add}`.trim(), honesty_added: true };
}
