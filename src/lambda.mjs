// AWS Lambda entry point (Function URL, payload format 2.0, buffered response). Same router as the local server.
// Handler: src/lambda.handler. Env (names only): MANDAT_STORE=dynamodb, MANDAT_TABLE, MANDAT_MODEL=bedrock,
// MANDAT_TTS=polly, MANDAT_PUBLIC_URL, MANDAT_ALLOWED_ORIGINS, MANDAT_DEMO_TOKEN, MANDAT_NETWORK_SECRET,
// MANDAT_LLM_BUDGET_USD, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (sandbox), MANDAT_BRAIN, MANDAT_BRAIN_MODEL.
import { createApp } from './app.mjs';
import { Mandat } from './mandat.mjs';
import { createStore } from './store/index.mjs';
import { createProvider } from './providers/index.mjs';
import { SimulatedBrain } from './brain/simulated.mjs';

let app = null;
async function appFor(origin) {
  if (app) return app;
  const publicUrl = process.env.MANDAT_PUBLIC_URL || origin;
  const service = new Mandat({ store: createStore(process.env.MANDAT_STORE || 'dynamodb'), provider: createProvider(), publicUrl });
  const headers = process.env.MANDAT_DEMO_TOKEN ? { Authorization: `Bearer ${process.env.MANDAT_DEMO_TOKEN}` } : {};
  // The brain calls this same function's /mcp over HTTPS, like any external MCP client would.
  const brain = process.env.MANDAT_BRAIN === 'strands'
    ? await (await import('../orchestrator/brain.mjs')).createStrandsBrain({ mcpUrl: `${publicUrl}/mcp`, headers })
    : new SimulatedBrain({ mcpUrl: `${publicUrl}/mcp`, headers });
  app = createApp({ service, brain, allowedOrigins: (process.env.MANDAT_ALLOWED_ORIGINS || publicUrl).split(",").map((x) => x.trim()) });
  return app;
}

// Function URL event (2.0) -> Request
export function eventToRequest(event) {
  const host = event.headers?.host || event.requestContext?.domainName || 'localhost';
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const url = `https://${host}${event.rawPath || '/'}${qs}`;
  const method = event.requestContext?.http?.method || 'GET';
  const headers = new Headers(event.headers || {});
  if (event.cookies?.length) headers.set('cookie', event.cookies.join('; '));
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body) : undefined;
  return new Request(url, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : body });
}

export async function handler(event) {
  const request = eventToRequest(event);
  const response = await (await appFor(new URL(request.url).origin))(request);
  const type = response.headers.get('content-type') || '';
  const buf = Buffer.from(await response.arrayBuffer());
  const text = /json|text|javascript|html|svg/.test(type);
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  return { statusCode: response.status, headers, body: text ? buf.toString('utf8') : buf.toString('base64'), isBase64Encoded: !text };
}
