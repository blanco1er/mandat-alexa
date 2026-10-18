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
import { spendViewShared } from './core/spend.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = { '/simulator/': path.join(ROOT, 'simulator'), '/media/': path.join(ROOT, 'media') };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp', '.avif': 'image/avif' };

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// Per-IP limits for the public demo (per warm process; the shared LLM budget in core/spend.mjs is the global cap).
// MANDAT_LIMIT_TURNS (turns per IP per hour, default 60), MANDAT_LIMIT_TTS (120), MANDAT_LIMIT_MCP (MCP POSTs, 600).
// The brain's own MCP calls carry X-Mandat-Internal (derived from MANDAT_NETWORK_SECRET) and are not counted.
export function createLimiter({ perHour, windowMs = 3_600_000, now = () => Date.now() }) {
  const hits = new Map();
  return (key) => {
    if (!perHour) return { ok: true };
    const t = now();
    const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (list.length >= perHour) { hits.set(key, list); return { ok: false, retryAfter: Math.ceil((windowMs - (t - list[0])) / 1000) }; }
    list.push(t);
    hits.set(key, list);
    if (hits.size > 5000) hits.delete(hits.keys().next().value);
    return { ok: true };
  };
}
const limitOf = (name, dflt) => { const v = process.env[name]; return v === undefined || v === '' ? dflt : Math.max(0, Number(v) || 0); };
export const clientIp = (request) => request.headers.get('x-mandat-client-ip') || 'local';
const tooMany = (retryAfter, speech) => json(429, { error: 'Too many requests', speech }, { 'retry-after': String(retryAfter) });

// MCP 2025-11-25 transports: servers MUST validate Origin and answer 403 when it is invalid.
// Requests without Origin (server-to-server: the orchestrator, Strands, MCP Inspector CLI, curl) are allowed.
export function originAllowed(origin, allowed) {
  if (!origin) return true;
  return allowed.includes(origin);
}

export function createApp({ service, brain = null, allowedOrigins, demoToken = process.env.MANDAT_DEMO_TOKEN || '', tts = createTts(), internalKey = '' }) {
  const origins = allowedOrigins || (process.env.MANDAT_ALLOWED_ORIGINS || 'http://localhost:8787,http://127.0.0.1:8787').split(',').map((s) => s.trim()).filter(Boolean);
  const limits = { turn: createLimiter({ perHour: limitOf('MANDAT_LIMIT_TURNS', 60) }), tts: createLimiter({ perHour: limitOf('MANDAT_LIMIT_TTS', 120) }), mcp: createLimiter({ perHour: limitOf('MANDAT_LIMIT_MCP', 600) }) };
  const internal = (request) => !!internalKey && request.headers.get('x-mandat-internal') === internalKey;

  async function mcp(request) {
    if (!originAllowed(request.headers.get('origin'), origins)) return json(403, { jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden origin' }, id: null });
    if (demoToken && request.headers.get('authorization') !== `Bearer ${demoToken}`) return json(401, { jsonrpc: '2.0', error: { code: -32001, message: 'Missing or wrong bearer token' }, id: null }, { 'www-authenticate': 'Bearer' });
    if (request.method === 'POST' && !internal(request)) {
      const l = limits.mcp(clientIp(request));
      if (!l.ok) return json(429, { jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests from this address; try again later.' }, id: null }, { 'retry-after': String(l.retryAfter) });
    }
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
      const ext = path.extname(file);
      // photos never change under the same name: let the browser keep them for a day; code stays no-store
      const cache = /^\.(webp|avif)$/.test(ext) ? 'public, max-age=86400' : 'no-store';
      return new Response(body, { headers: { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': cache } });
    } catch { return new Response('Not found', { status: 404 }); }
  }

  return async function fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === '/mcp') return await mcp(request);
      if (p === '/healthz') return json(200, { ok: true, protocol: LATEST_PROTOCOL_VERSION, model: service.provider.name, store: service.store.kind, paypal: PAYPAL_MODE, brain: brain?.name || null, tts: tts?.name || 'browser', llm_budget: (({ usd, budget, left, paused }) => ({ usd, budget, left, paused }))(await spendViewShared()) });
      if (p === '/turn' && request.method === 'POST') {
        if (!originAllowed(request.headers.get('origin'), origins)) return json(403, { error: 'Forbidden origin' });
        if (!brain) return json(501, { error: 'No orchestrator configured' });
        const body = await request.json().catch(() => ({}));
        const text = String(body.text || '').slice(0, 500);
        if (!text.trim()) return json(400, { error: 'Say something.' });
        const household = /^[a-z0-9_-]{1,40}$/i.test(body.household || '') ? body.household : 'demo';
        const l = limits.turn(clientIp(request));
        if (!l.ok) return tooMany(l.retryAfter, 'That is a lot of requests from here in one hour. Please try again a little later; nothing was booked or charged.');
        try {
          const out = await brain.runTurn({ text, session: { ...(body.session || {}), device: body.device || 'show' }, household });
          return json(200, out);
        } catch (e) {
          if (e.code === 'LLM_BUDGET') return json(503, { error: 'Model budget used up', speech: e.message });
          throw e;
        }
      }
      if (p === '/tts' && request.method === 'POST') {
        if (!tts) return json(501, { error: 'No server TTS; the browser voice is used.' });
        if (!originAllowed(request.headers.get('origin'), origins)) return json(403, { error: 'Forbidden origin' });
        const l = limits.tts(clientIp(request));
        if (!l.ok) return tooMany(l.retryAfter);
        const { text } = await request.json().catch(() => ({}));
        if (!String(text || '').trim()) return json(400, { error: 'Nothing to say.' });
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
