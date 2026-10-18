// One web-standard router (Request -> Response) for both runtimes: the local Node server (src/server.mjs) and
// AWS Lambda behind a Function URL (src/lambda.mjs). Routes:
//   POST|GET|DELETE /mcp   MCP Streamable HTTP, stateless, JSON responses (protocol 2025-11-25)
//   POST /turn             one user utterance -> orchestrator (simulated, or Strands/Bedrock) -> speech + tool results
//   POST /tts              Polly when MANDAT_TTS=polly, else 501 (the browser speaks)
//   GET  /paypal/return    PayPal sandbox vault approval comes back here
//   GET  /healthz          liveness + which providers are on
//   GET  /simulator/*      the Alexa+ web simulator (static)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './mcp/server.mjs';
import { createTts } from './providers/tts.mjs';
import { MODE as PAYPAL_MODE } from './core/paypal.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = { '/simulator/': path.join(ROOT, 'simulator') };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// MCP 2025-11-25 transports: servers MUST validate Origin and answer 403 when it is invalid.
// Requests without Origin (server-to-server: the orchestrator, Strands, MCP Inspector CLI, curl) are allowed.
export function originAllowed(origin, allowed) {
  if (!origin) return true;
  return allowed.includes(origin);
}

export function createApp({ service, brain = null, allowedOrigins, demoToken = process.env.MANDAT_DEMO_TOKEN || '', tts = createTts() }) {
  const origins = allowedOrigins || (process.env.MANDAT_ALLOWED_ORIGINS || 'http://localhost:8787,http://127.0.0.1:8787').split(',').map((s) => s.trim()).filter(Boolean);

  async function mcp(request) {
    if (!originAllowed(request.headers.get('origin'), origins)) return json(403, { jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden origin' }, id: null });
    if (demoToken && request.headers.get('authorization') !== `Bearer ${demoToken}`) return json(401, { jsonrpc: '2.0', error: { code: -32001, message: 'Missing or wrong bearer token' }, id: null }, { 'www-authenticate': 'Bearer' });
    const server = createMcpServer({ service });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      // stateless: everything for this request is done once the JSON response exists
      queueMicrotask(() => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    }
  }

  async function serveStatic(prefix, pathname) {
    const base = STATIC[prefix];
    let rel = decodeURIComponent(pathname.slice(prefix.length)) || 'index.html';
    const file = path.resolve(base, rel);
    if (!file.startsWith(base + path.sep) && file !== base) return new Response('Not found', { status: 404 });
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, { headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' } });
    } catch { return new Response('Not found', { status: 404 }); }
  }

  return async function fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === '/mcp') return await mcp(request);
      if (p === '/healthz') return json(200, { ok: true, protocol: LATEST_PROTOCOL_VERSION, model: service.provider.name, store: service.store.kind, paypal: PAYPAL_MODE, brain: brain?.name || null, tts: tts?.name || 'browser' });
      if (p === '/turn' && request.method === 'POST') {
        if (!originAllowed(request.headers.get('origin'), origins)) return json(403, { error: 'Forbidden origin' });
        if (!brain) return json(501, { error: 'No orchestrator configured' });
        const body = await request.json().catch(() => ({}));
        const text = String(body.text || '').slice(0, 500);
        if (!text.trim()) return json(400, { error: 'Say something.' });
        const household = /^[a-z0-9_-]{1,40}$/i.test(body.household || '') ? body.household : 'demo';
        const out = await brain.runTurn({ text, session: { ...(body.session || {}), device: body.device || 'show' }, household });
        return json(200, out);
      }
      if (p === '/tts' && request.method === 'POST') {
        if (!tts) return json(501, { error: 'No server TTS; the browser voice is used.' });
        const { text } = await request.json();
        return new Response(await tts.synthesize(text), { headers: { 'content-type': 'audio/mpeg' } });
      }
      if (p === '/paypal/return') {
        const m = await service.activateMandate(url.searchParams.get('household') || 'demo', url.searchParams.get('mandate'));
        return new Response(`<!doctype html><meta charset="utf-8"><title>Mandat</title><body style="font:20px system-ui;padding:40px">Budget “${m.purpose}” approved in PayPal sandbox. You can close this tab.</body>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (p === '/paypal/cancel') return new Response('Approval cancelled. Nothing was set up.', { status: 200 });
      if (p === '/' || p === '/simulator') return Response.redirect(new URL('/simulator/', url), 302);
      for (const prefix of Object.keys(STATIC)) if (p.startsWith(prefix) && request.method === 'GET') return await serveStatic(prefix, p);
      return new Response('Not found', { status: 404 });
    } catch (e) {
      console.error('[app]', p, e);
      return json(500, { error: 'Server error' });
    }
  };
}
