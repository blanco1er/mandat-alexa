// MCP Apps views (spec 2026-01-26): each card is one self-contained HTML document (shared CSS and the postMessage
// bridge are inlined at load time), served as a ui:// resource with mimeType "text/html;profile=mcp-app".
// URIs carry a content hash (ui://mandat/plan-<hash>.html), as Amazon recommends, so hosts never show a stale card.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_APP_MIME = 'text/html;profile=mcp-app';
export const UI_EXTENSION = 'io.modelcontextprotocol/ui';
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
export const CARD_NAMES = ['status', 'mandate', 'offers', 'plan', 'receipt', 'item'];

const TITLES = { status: 'Household status', mandate: 'Spending budget', offers: 'Options and quotes', plan: 'Plan to approve', receipt: 'Receipt and payment timeline', item: 'Item details and comparison' };

let cache = null;
export function cards() {
  if (cache) return cache;
  const css = fs.readFileSync(path.join(DIR, 'shared.css'), 'utf8');
  const js = fs.readFileSync(path.join(DIR, 'bridge.js'), 'utf8');
  cache = {};
  for (const name of CARD_NAMES) {
    const html = fs.readFileSync(path.join(DIR, `${name}.html`), 'utf8').replace('/*SHARED_CSS*/', () => css).replace('/*BRIDGE_JS*/', () => js);
    const hash = crypto.createHash('sha256').update(html).digest('hex').slice(0, 10);
    cache[name] = { name, title: TITLES[name], uri: `ui://mandat/${name}-${hash}.html`, html };
  }
  return cache;
}

// _meta.ui for the resource (both in resources/list and in resources/read contents[]).
// No network access; code, styles and icons are inline. The only external resources are the item photos, served
// from our own origin (/media/items/), so resourceDomains lists that one origin and nothing else.
export function resourceUiMeta(publicUrl) {
  let origin = null;
  try { origin = publicUrl ? new URL(publicUrl).origin : null; } catch {}
  return { ui: { csp: { connectDomains: [], resourceDomains: origin ? [origin] : [] }, prefersBorder: false } };
}
