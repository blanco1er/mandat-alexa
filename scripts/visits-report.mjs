// Who tried the public demo, from where, and how far they went. Owner only: reads the DynamoDB table with the
// owner's AWS profile; there is no public page for it. Visits of the owner's devices and of our scripts are never
// logged (src/core/visits.mjs). Output in French.
//   AWS_PROFILE=mandat node scripts/visits-report.mjs                    # the last 14 days
//   AWS_PROFILE=mandat node scripts/visits-report.mjs --depuis 2026-10-23 [--jusqu 2026-12-15] [--detail]
import { pathToFileURL } from 'node:url';

const GAP = 30 * 60e3; // a new session after 30 minutes without an event
const pct = (n, d) => (d ? ` (${Math.round((n / d) * 100)} %)` : '');
const fmtDur = (ms) => (ms < 60e3 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60e3)} min`);
const day = (iso) => iso.slice(0, 10);
const hm = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

// rows: the stored events ({ at, type, visitor, ref, browser, os, bot, device, lang, text, tools, detail, outcome })
export function sessionsOf(rows) {
  const byVisitor = new Map();
  for (const r of [...rows].sort((a, b) => a.at.localeCompare(b.at))) {
    const list = byVisitor.get(r.visitor) || [];
    const last = list[list.length - 1];
    if (!last || Date.parse(r.at) - Date.parse(last.end) > GAP) list.push({ visitor: r.visitor, start: r.at, end: r.at, events: [r] });
    else { last.end = r.at; last.events.push(r); }
    byVisitor.set(r.visitor, list);
  }
  return [...byVisitor.values()].flat().sort((a, b) => a.start.localeCompare(b.start));
}

export function summarize(rows, { from = '', to = '', detail = false } = {}) {
  rows = rows.filter((r) => !r.bot);
  const out = [];
  const visitors = new Set(rows.map((r) => r.visitor));
  out.push(`Mandat for Alexa+ · visites de la démo publique${from ? ` du ${from}` : ''}${to ? ` au ${to}` : ''} (visites internes et robots exclus)`);
  if (!rows.length) { out.push('', 'Aucune visite externe sur la période.'); return out.join('\n'); }
  const refOf = new Map();
  for (const r of rows) if (r.ref && !refOf.has(r.visitor)) refOf.set(r.visitor, r.ref);
  const count = (f) => new Set(rows.filter(f).map((r) => r.visitor)).size;
  const turns = rows.filter((r) => r.type === 'turn');
  out.push('', `Visiteurs uniques : ${visitors.size} · tours vocaux ou écrits : ${turns.length}`);
  out.push('', 'Par jour :');
  for (const d of [...new Set(rows.map((r) => day(r.at)))].sort()) {
    const rs = rows.filter((r) => day(r.at) === d);
    out.push(`  ${d} : ${new Set(rs.map((r) => r.visitor)).size} visiteur(s), ${rs.filter((r) => r.type === 'turn').length} tour(s)`);
  }
  const refs = {};
  for (const v of visitors) { const k = refOf.get(v) || 'accès direct'; refs[k] = (refs[k] || 0) + 1; }
  out.push('', `Provenance : ${Object.entries(refs).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  const reached = (k) => count((r) => r.type === 'turn' && r.outcome?.[k]);
  out.push('', 'Jusqu’où ils sont allés :');
  out.push(`  ont lié un compte : ${count((r) => r.type === 'link')}${pct(count((r) => r.type === 'link'), visitors.size)}`);
  out.push(`  ont parlé ou écrit : ${count((r) => r.type === 'turn')}${pct(count((r) => r.type === 'turn'), visitors.size)}`);
  out.push(`  plan proposé : ${reached('plan')} · « oui » et paiement de test : ${reached('paid')} · commande réglée : ${reached('settled')}`);
  out.push(`  arrêt d’urgence : ${reached('stop')} · données supprimées : ${reached('deleted')}`);
  out.push(`  cartes touchées : ${count((r) => r.type === 'card')} · outils MCP appelés directement : ${count((r) => r.type === 'tool')}`);
  const tally = (key) => { const t = {}; for (const r of rows) if (r[key]) t[r[key]] = (t[r[key]] || 0) + 1; return Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ') || '—'; };
  out.push('', `Appareils choisis : ${tally('device')}`, `Langues : ${tally('lang')}`);
  const fam = {};
  for (const v of visitors) { const r = rows.find((x) => x.visitor === v); const k = `${r.browser}/${r.os}`; fam[k] = (fam[k] || 0) + 1; }
  out.push(`Navigateurs : ${Object.entries(fam).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  const sess = sessionsOf(rows);
  const durs = sess.map((s) => Date.parse(s.end) - Date.parse(s.start)).sort((a, b) => a - b);
  out.push('', `Sessions : ${sess.length} · durée médiane ${fmtDur(durs[Math.floor(durs.length / 2)] || 0)} · la plus longue ${fmtDur(durs[durs.length - 1] || 0)}`);
  out.push('', 'Ce qu’ils ont demandé (les 15 dernières phrases) :');
  for (const r of turns.slice(-15)) out.push(`  ${day(r.at)} ${hm(r.at)} · ${r.visitor.slice(0, 6)} · « ${r.text || ''} »${r.tools?.length ? ` → ${r.tools.join(', ')}` : ''}`);
  if (detail) {
    out.push('', 'Détail par session :');
    for (const s of sess) {
      out.push('', `Session ${s.visitor.slice(0, 6)} · ${day(s.start)} ${hm(s.start)} · ${fmtDur(Date.parse(s.end) - Date.parse(s.start))} · ${refOf.get(s.visitor) || 'accès direct'} · ${s.events[0].browser}/${s.events[0].os}`);
      for (const e of s.events) out.push(`  ${hm(e.at)} ${e.type}${e.device ? ` [${e.device}]` : ''}${e.lang ? ` [${e.lang}]` : ''}${e.text ? ` « ${e.text} »` : ''}${e.tools?.length ? ` → ${e.tools.join(', ')}` : ''}${e.detail ? ` (${e.detail})` : ''}`);
    }
  }
  return out.join('\n');
}

async function fetchRows(from, to) {
  const ddb = await import('@aws-sdk/client-dynamodb');
  const lib = await import('@aws-sdk/lib-dynamodb');
  const doc = lib.DynamoDBDocumentClient.from(new ddb.DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' }));
  const rows = [];
  for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    let ExclusiveStartKey;
    do {
      const r = await doc.send(new lib.QueryCommand({ TableName: process.env.MANDAT_TABLE || 'mandat', KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `VISIT#${d.toISOString().slice(0, 10)}` }, ExclusiveStartKey }));
      for (const it of r.Items || []) rows.push(it.v);
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  }
  return rows;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const to = arg('--jusqu') || new Date().toISOString().slice(0, 10);
  const from = arg('--depuis') || new Date(Date.now() - 13 * 86400e3).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) { console.error('Dates au format AAAA-MM-JJ, par exemple --depuis 2026-10-23'); process.exit(2); }
  const rows = await fetchRows(from, to).catch((e) => { console.error(`Lecture DynamoDB impossible (${e.name}: ${e.message}). Lancez avec AWS_PROFILE=mandat.`); process.exit(1); });
  console.log(summarize(rows, { from, to, detail: process.argv.includes('--detail') }));
}
