// What is real and what is not is said by the code, not left to the model. A tool result that needs an honesty
// sentence carries it in structuredContent.honesty = { text, must } (src/mandat.mjs). After the model's turn, the
// host checks the spoken answer: if it dropped that sentence (seen live: Nova 2 Lite summarises the plan and leaves
// out "test money" and "booking request"), the sentence is added back, in the user's language, once.
// Only the latest result that carries one counts (the plan's sentence covers the searches before it), and the
// sentence goes before the closing question ("… It is all paid with test money … Should I book it?") or the Echo Dot's
// "Say yes to confirm the plan."
export function ensureHonesty(out = {}) {
  const speech = String(out.speech || '').trim();
  const last = [...(out.steps || [])].reverse().find((s) => !s.result?.isError && s.result?.structuredContent?.honesty);
  if (!last) return out;
  const needs = [].concat(last.result.structuredContent.honesty).filter((h) => h?.text);
  const missing = needs.filter((h) => !new RegExp(h.must, 'iu').test(speech) && !speech.includes(h.text));
  if (!missing.length) return out;
  const add = [...new Set(missing.map((h) => h.text))].join(' ');
  // "… Should I book it?" / "… Je réserve ?" / "… ¿Lo reservo?": keep the question last
  // the closing question, or the Echo Dot's "Say yes to confirm the plan.", stays last
  const q = /(?:^|(?<=[.!?…]))\s*(?:¿)?[^.!?…¿]*\?\s*$/u.exec(speech) || /(?:^|(?<=[.!?…]))\s*(?:Say yes|Dites oui|Di sí)[^.!?…]*[.!]\s*$/u.exec(speech);
  const text = q && q.index > 0 ? `${speech.slice(0, q.index).trim()} ${add} ${speech.slice(q.index).trim()}` : `${speech} ${add}`;
  return { ...out, speech: text.replace(/\s+/g, ' ').trim(), honesty_added: true };
}
