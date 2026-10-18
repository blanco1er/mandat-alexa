// AWS Lambda entry point (Function URL, payload format 2.0, buffered response). Same router as the local server.
// Handler: src/lambda.handler. Env (names only): MANDAT_STORE=dynamodb, MANDAT_TABLE, MANDAT_MODEL=bedrock,
// MANDAT_TTS=polly, MANDAT_PUBLIC_URL, MANDAT_ALLOWED_ORIGINS, MANDAT_DEMO_TOKEN, MANDAT_NETWORK_SECRET,
// MANDAT_AUTH (required on the public demo: account linking), MANDAT_OAUTH_CLIENT_ID / _SECRET / _REDIRECT_URIS (the
// real Alexa+ client, optional), MANDAT_LLM_BUDGET_USD, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (sandbox), MANDAT_BRAIN, MANDAT_BRAIN_MODEL.
import { createApp } from './app.mjs';
import { Mandat } from './mandat.mjs';
import { createStore } from './store/index.mjs';
import { createProvider } from './providers/index.mjs';
import { SimulatedBrain } from './brain/simulated.mjs';
import { setSharedLedger } from './core/spend.mjs';
import crypto from 'node:crypto';

// Key on the brain's own MCP calls so the per-IP limit does not count them (derived, never the secret itself).
export const internalKeyOf = (secret) => (secret ? crypto.createHash('sha256').update(`mandat-internal:${secret}`).digest('hex').slice(0, 32) : '');

let app = null;
let serviceRef = null;
async function appFor(origin) {
  if (app) return app;
  const publicUrl = process.env.MANDAT_PUBLIC_URL || origin;
  const store = createStore(process.env.MANDAT_STORE || 'dynamodb');
  if (store.ledger) setSharedLedger(store.ledger()); // one LLM budget for every warm container
  const service = new Mandat({ store, provider: createProvider(), publicUrl });
  serviceRef = service;
  const internalKey = internalKeyOf(process.env.MANDAT_NETWORK_SECRET);
  const headers = { ...(process.env.MANDAT_DEMO_TOKEN ? { Authorization: `Bearer ${process.env.MANDAT_DEMO_TOKEN}` } : {}), ...(internalKey ? { 'X-Mandat-Internal': internalKey } : {}) };
  // The brain calls this same function's /mcp over HTTPS, like any external MCP client would.
  const brain = process.env.MANDAT_BRAIN === 'strands'
    ? await (await import('../orchestrator/brain.mjs')).createStrandsBrain({ mcpUrl: `${publicUrl}/mcp`, headers })
    : new SimulatedBrain({ mcpUrl: `${publicUrl}/mcp`, headers });
  app = createApp({ service, brain, internalKey, mcpUrl: `${publicUrl}/mcp`, allowedOrigins: (process.env.MANDAT_ALLOWED_ORIGINS || publicUrl).split(",").map((x) => x.trim()) });
  return app;
}

// Function URL event (2.0) -> Request
export function eventToRequest(event) {
  const host = event.headers?.host || event.requestContext?.domainName || 'localhost';
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const url = `https://${host}${event.rawPath || '/'}${qs}`;
  const method = event.requestContext?.http?.method || 'GET';
  const headers = new Headers(event.headers || {});
  // The caller's address as AWS saw it (never a header the caller could set): used by the per-IP demo limits.
  headers.delete('x-mandat-client-ip');
  if (event.requestContext?.http?.sourceIp) headers.set('x-mandat-client-ip', event.requestContext.http.sourceIp);
  if (event.cookies?.length) headers.set('cookie', event.cookies.join('; '));
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body) : undefined;
  return new Request(url, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : body });
}

// Owner-only commands. A direct Lambda invoke is signed with the owner's IAM credentials (aws lambda invoke); the
// public Function URL always carries requestContext.http, so these can never be reached from the internet.
//   { "mandat_admin": "link-demo-buyer" }  -> { approveUrl }: approve once with a PayPal sandbox personal account
//   { "mandat_admin": "demo-buyer-status" } -> { paypal, linked, payer (masked), linked_at }
async function admin(event) {
  await appFor(process.env.MANDAT_PUBLIC_URL || 'https://localhost');
  if (event.mandat_admin === 'link-demo-buyer') return serviceRef.startDemoBuyerLink();
  if (event.mandat_admin === 'demo-buyer-status') return serviceRef.demoBuyerStatus();
  return { error: 'unknown admin command' };
}

export async function handler(event) {
  if (event && event.mandat_admin && !event.requestContext) return admin(event);
  const request = eventToRequest(event);
  const response = await (await appFor(new URL(request.url).origin))(request);
  const type = response.headers.get('content-type') || '';
  const buf = Buffer.from(await response.arrayBuffer());
  const text = /json|text|javascript|html|svg/.test(type);
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  return { statusCode: response.status, headers, body: text ? buf.toString('utf8') : buf.toString('base64'), isBase64Encoded: !text };
}
