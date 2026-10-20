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

// Seen live on 20 Oct: two auto-buys in one turn are two plans, so the first confirmation says "$184.01 left" and the
// second "$146.22 left"; Nova repeated the first, a balance that was already out of date when Alexa spoke. After the
// turn, any balance of a budget that a later step of the same turn changed is replaced by that budget's final balance
// (each tool result carries the envelope it touched: receipt.envelope, envelope or envelopes).
export function ensureFinalBalances(out = {}) {
  let speech = String(out.speech || '');
  const seen = new Map(); // mandate_id -> balances in order
  for (const s of out.steps || []) {
    const d = s.result?.isError ? null : s.result?.structuredContent;
    if (!d) continue;
    for (const e of [d.receipt?.envelope, d.envelope, ...(d.envelopes || [])].filter((x) => x?.mandate_id && Number.isFinite(x.remaining))) {
      const list = seen.get(e.mandate_id) || [];
      if (list[list.length - 1] !== e.remaining) list.push(e.remaining);
      seen.set(e.mandate_id, list);
    }
  }
  let fixed = false;
  // "$184.01", "184,01 $", "$1,234.50", "$40" / "40 $" (a whole amount may be written without cents)
  const pat = (n) => {
    const [i, c] = n.toFixed(2).split('.');
    const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, '[,\u202f\u00a0 ]?');
    const num = c === '00' ? `${int}(?:[.,]00)?` : `${int}[.,]${c}`;
    return new RegExp(`(\\$\\s?)${num}(?![\\d.,]\\d)|(?<![\\d.,])${num}(\\s?\\$)`, 'g');
  };
  const fmt = (n, like) => { const s = Number.isInteger(n) && !/[.,]\d\d/.test(like) ? String(n) : n.toFixed(2); return /,\d\d/.test(like) ? s.replace('.', ',') : s; };
  for (const list of seen.values()) {
    const final = list[list.length - 1];
    for (const old of list.slice(0, -1)) {
      if (old === final) continue;
      // only a balance ("… left", "il reste …", "te quedan …"), never a price that happens to be the same number
      speech = speech.replace(pat(old), (m, pre, post, at, all) => {
        // the "left" word sits in the same sentence, with no other figure between it and this amount
        const st = Math.max(0, all.slice(0, at).search(/[.!?]\s(?!.*[.!?]\s)/s) + 1);
        const endRel = all.slice(at + m.length).search(/[.!?](\s|$)/);
        const sentence = all.slice(st, endRel < 0 ? all.length : at + m.length + endRel);
        const rel = at - st, plain = sentence.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const LEFT = /\b(left|remain\w*|reste\w*|restant\w*|queda\w*|restan\w*)\b/g;
        let ok = false;
        for (const w of plain.matchAll(LEFT)) {
          const between = w.index > rel ? plain.slice(rel + m.length, w.index) : plain.slice(w.index + w[0].length, rel);
          if (between.length <= 45 && !/\d/.test(between)) ok = true;
        }
        if (!ok) return m;
        fixed = true; const like = m.replace(/[$\s]/g, ''); return `${pre || ''}${fmt(final, like)}${post || ''}`;
      });
    }
  }
  return fixed ? { ...out, speech, balances_fixed: true } : out;
}
