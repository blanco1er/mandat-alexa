// One web-standard router (Request -> Response) for both runtimes: the local Node server (src/server.mjs) and
// AWS Lambda behind a Function URL (src/lambda.mjs). Routes:
//   POST|GET|DELETE /mcp   MCP Streamable HTTP, stateless, JSON responses (protocol 2025-11-25)
//   POST /turn             one user utterance -> orchestrator (simulated, or Strands/Bedrock) -> speech + tool results
//   GET  /activity         live activity of one voice turn (?household=&turn=), read while /turn runs
//   POST /tts              Polly when MANDAT_TTS=polly, else 501 (the browser speaks)
//   GET  /paypal/return    PayPal sandbox vault approval comes back here
//   GET  /healthz          liveness + which providers are on
//   GET  /.well-known/oauth-protected-resource   RFC 9728 metadata Alexa reads for account linking (+ /mcp suffix)
//   GET  /.well-known/oauth-authorization-server RFC 8414 metadata (endpoints, S256)
//   GET|POST /oauth/authorize, POST /oauth/token, POST /oauth/revoke   Mandat's OAuth 2.1 server (src/core/oauth.mjs)
//   GET  /privacy          the privacy policy account linking needs
// MANDAT_AUTH=required (the deployed demo): tools/call without a valid access token answers HTTP 401 with
// WWW-Authenticate (Alexa then starts account linking), and the household always comes from the token.
// MANDAT_AUTH=optional (default, local and tests): a token is verified when present; without one the old
// X-Mandat-Household header still picks a household.
//   GET  /simulator/*      the Alexa+ web simulator (static)
//   GET  /img              photos of real products (Channel3) and real businesses (Google Places), signed links only
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './mcp/server.mjs';
import { createTts } from './providers/tts.mjs';
import { MODE as PAYPAL_MODE } from './core/paypal.mjs';
import { spendViewShared } from './core/spend.mjs';
import { readFeed } from './core/activity.mjs';
import { TURN_RE } from './core/context.mjs';
import { authorizationServerMetadata, OAuthServer, privacyPage, protectedResourceMetadata, wwwAuthenticate } from './core/oauth.mjs';
import { runHostIntent } from './brain/host-intents.mjs';
import { tr } from './core/i18n.mjs';
import { serveImg } from './core/imgproxy.mjs';
import { shopEnabled } from './core/shop.mjs';
import { googleEnabled, placesMode } from './core/places.mjs';

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

export function createApp({ service, brain = null, allowedOrigins, demoToken = process.env.MANDAT_DEMO_TOKEN || '', tts = createTts(), internalKey = '', authMode = process.env.MANDAT_AUTH || 'optional', oauth = null, mcpUrl = null }) {
  const origins = allowedOrigins || (process.env.MANDAT_ALLOWED_ORIGINS || 'http://localhost:8787,http://127.0.0.1:8787').split(',').map((s) => s.trim()).filter(Boolean);
  const limits = { turn: createLimiter({ perHour: limitOf('MANDAT_LIMIT_TURNS', 60) }), tts: createLimiter({ perHour: limitOf('MANDAT_LIMIT_TTS', 120) }), mcp: createLimiter({ perHour: limitOf('MANDAT_LIMIT_MCP', 600) }), activity: createLimiter({ perHour: limitOf('MANDAT_LIMIT_ACTIVITY', 3000) }), oauth: createLimiter({ perHour: limitOf('MANDAT_LIMIT_OAUTH', 300) }) };
  const internal = (request) => !!internalKey && request.headers.get('x-mandat-internal') === internalKey;
  const required = authMode === 'required';
  const auth = oauth || new OAuthServer({ store: service.store, publicUrl: service.publicUrl, origins, seed: (kind) => service.seedHousehold(kind) });
  const selfMcp = () => mcpUrl || `${String(service.publicUrl).replace(/\/$/, '')}/mcp`;
  const unauthorized = (error, message, id = null) => json(401, { error: 'unauthorized', message, ...(id !== undefined ? { jsonrpc: '2.0', id } : {}) }, { 'www-authenticate': wwwAuthenticate(service.publicUrl, error) });
  // The account link behind a request: null when there is no bearer token; false when one came but is not valid.
  const linkOf = async (request) => {
    const h = request.headers.get('authorization') || '';
    if (!/^Bearer\s/i.test(h) || (demoToken && h === `Bearer ${demoToken}`)) return null;
    return (await auth.verify(h)) || false;
  };

  async function mcp(request) {
    if (!originAllowed(request.headers.get('origin'), origins)) return json(403, { jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden origin' }, id: null });
    const link = await linkOf(request);
    if (link === false) return unauthorized('invalid_token', 'The access token is invalid or expired. Alexa refreshes it or links the account again.');
    if (!link && demoToken && request.headers.get('authorization') !== `Bearer ${demoToken}`) return json(401, { jsonrpc: '2.0', error: { code: -32001, message: 'Missing or wrong bearer token' }, id: null }, { 'www-authenticate': 'Bearer' });
    if (request.method === 'POST' && !internal(request)) {
      const l = limits.mcp(clientIp(request));
      if (!l.ok) return json(429, { jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests from this address; try again later.' }, id: null }, { 'retry-after': String(l.retryAfter) });
    }
    // Amazon (account linking for MCP add-ons): a tool called without a valid token answers 401, and Alexa starts
    // the linking flow. initialize, tools/list and resources stay public, so an add-on can still be discovered.
    if (required && !link && request.method === 'POST') {
      const body = await request.clone().json().catch(() => null);
      const msgs = Array.isArray(body) ? body : [body];
      const call = msgs.find((m) => m && m.method === 'tools/call');
      if (call) return unauthorized(undefined, 'Access token required to use this tool. Link Mandat in the Alexa app first.', call.id ?? null);
    }
    // The household comes from the token; a household header is only honoured in optional mode without a token.
    if (required || link) {
      const h = new Headers(request.headers);
      h.delete('x-mandat-household');
      request = new Request(request, { headers: h, ...(request.body ? { duplex: 'half' } : {}) });
    }
    const server = createMcpServer({ service });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      const authInfo = link ? { token: 'verified', clientId: link.client_id, scopes: link.scope, expiresAt: link.expiresAt, extra: { household: link.household, link_id: link.link_id } } : undefined;
      return await transport.handleRequest(request, { authInfo });
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
      // ---------- account linking (OAuth 2.1 + PKCE S256) ----------
      if (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp') return json(200, protectedResourceMetadata(service.publicUrl), { 'access-control-allow-origin': '*', 'cache-control': 'max-age=300' });
      if (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/oauth-authorization-server/mcp') return json(200, authorizationServerMetadata(service.publicUrl), { 'access-control-allow-origin': '*', 'cache-control': 'max-age=300' });
      if (p.startsWith('/oauth/')) {
        const l = limits.oauth(clientIp(request));
        if (!l.ok) return tooMany(l.retryAfter);
        if (p === '/oauth/authorize' && request.method === 'GET') return auth.authorizePage(url);
        if (p === '/oauth/authorize' && request.method === 'POST') {
          if (!originAllowed(request.headers.get('origin'), origins)) return json(403, { error: 'Forbidden origin' });
          return await auth.authorizeSubmit(request);
        }
        if (p === '/oauth/token' && request.method === 'POST') return await auth.token(request);
        if (p === '/oauth/revoke' && request.method === 'POST') return await auth.revoke(request);
        return json(405, { error: 'method not allowed' });
      }
      if (p === '/privacy') return privacyPage();
      if (p === '/healthz') return json(200, { ok: true, protocol: LATEST_PROTOCOL_VERSION, auth: required ? 'oauth2.1 required' : 'oauth2.1 optional', model: service.provider.name, store: service.store.kind, paypal: PAYPAL_MODE, paypal_buyer: PAYPAL_MODE === 'sandbox' ? ((await service.demoBuyer().catch(() => null)) ? 'linked' : 'not linked') : undefined, brain: brain?.name || null, tts: tts?.name || 'browser', products: shopEnabled() ? 'channel3' : 'test catalogue', places: placesMode() === 'live' ? (googleEnabled() ? 'google+osm' : 'osm') : placesMode(), llm_budget: (({ usd, budget, left, paused }) => ({ usd, budget, left, paused }))(await spendViewShared()) });
      if (p === '/turn' && request.method === 'POST') {
        if (!originAllowed(request.headers.get('origin'), origins)) return json(403, { error: 'Forbidden origin' });
        if (!brain) return json(501, { error: 'No orchestrator configured' });
        const body = await request.json().catch(() => ({}));
        const text = String(body.text || '').slice(0, 500);
        if (!text.trim()) return json(400, { error: 'Say something.' });
        const locale = typeof body.locale === 'string' ? body.locale.slice(0, 12) : undefined;
        // Like Alexa: the add-on is used with the person's linked account; without one, the host starts linking.
        const link = await linkOf(request);
        if (link === false || (required && !link)) return json(401, { error: link === false ? 'invalid_token' : 'link_required', link_required: true, speech: tr(locale, 'link_needed') }, { 'www-authenticate': wwwAuthenticate(service.publicUrl, link === false ? 'invalid_token' : undefined) });
        const household = link ? link.household : /^[a-z0-9_-]{1,40}$/i.test(body.household || '') ? body.household : 'demo';
        const l = limits.turn(clientIp(request));
        if (!l.ok) return tooMany(l.retryAfter, 'That is a lot of requests from here in one hour. Please try again a little later; nothing was booked or charged.');
        try {
          const turn = TURN_RE.test(body.turn || '') ? body.turn : undefined;
          const authorization = link ? request.headers.get('authorization') : undefined;
          const session = { ...(body.session || {}), device: body.device || 'show' };
          // Settings by voice, the emergency stop and "delete my data" never depend on a model (src/brain/host-intents.mjs).
          const fast = await runHostIntent({ text, session, locale, household, turn, authorization, mcpUrl: selfMcp(), headers: internalKey ? { 'X-Mandat-Internal': internalKey } : {} });
          if (fast) return json(200, fast);
          // anything else is the model's turn: the settings card and the first-run questions are left behind
          const out = await brain.runTurn({ text, session: { ...session, settingsOpen: false, onboarding: null, pendingDelete: false }, household, turn, locale, authorization });
          return json(200, out);
        } catch (e) {
          if (e.code === 'LLM_BUDGET') return json(503, { error: 'Model budget used up', speech: e.message });
          throw e;
        }
      }
      // Live activity of one voice turn (what Mandat is doing right now), read by the host while /turn runs.
      if (p === '/activity' && request.method === 'GET') {
        if (!originAllowed(request.headers.get('origin'), origins)) return json(403, { error: 'Forbidden origin' });
        const l = limits.activity(clientIp(request));
        if (!l.ok) return tooMany(l.retryAfter);
        const link = await linkOf(request);
        if (link === false || (required && !link)) return unauthorized(link === false ? 'invalid_token' : undefined, 'Link Mandat first.', undefined);
        const household = link ? link.household : /^[a-z0-9_-]{1,40}$/i.test(url.searchParams.get('household') || '') ? url.searchParams.get('household') : 'demo';
        return json(200, { events: await readFeed(service.store, household, url.searchParams.get('turn')) }, { 'cache-control': 'no-store' });
      }
      if (p === '/tts' && request.method === 'POST') {
        if (!tts) return json(501, { error: 'No server TTS; the browser voice is used.' });
        if (!originAllowed(request.headers.get('origin'), origins)) return json(403, { error: 'Forbidden origin' });
        const l = limits.tts(clientIp(request));
        if (!l.ok) return tooMany(l.retryAfter);
        const { text, locale } = await request.json().catch(() => ({}));
        if (!String(text || '').trim()) return json(400, { error: 'Nothing to say.' });
        return new Response(await tts.synthesize(text, typeof locale === 'string' ? locale.slice(0, 12) : undefined), { headers: { 'content-type': 'audio/mpeg' } });
      }
      if (p === '/paypal/return') {
        const m = await service.activateMandate(url.searchParams.get('household') || 'demo', url.searchParams.get('mandate'));
        return new Response(`<!doctype html><meta charset="utf-8"><title>Mandat</title><body style="font:20px system-ui;padding:40px">Budget “${m.purpose}” approved in PayPal sandbox. You can close this tab.</body>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (p === '/paypal/cancel') return new Response('Approval cancelled. Nothing was set up.', { status: 200 });
      // The owner's one-time demo buyer link (scripts/link-paypal-demo-buyer.sh): PayPal comes back here.
      if (p === '/paypal/demo-buyer/return') {
        const page = (msg, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mandat</title><body style="font:20px/1.4 system-ui;padding:40px;max-width:640px">${msg}</body>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
        try {
          const r = await service.finishDemoBuyerLink(url.searchParams.get('approval_token_id') || url.searchParams.get('token') || '');
          return page(`<b>Demo buyer linked</b> (PayPal sandbox, ${r.payer.replace(/[<>&]/g, '')}). Every new budget of the public demo now places real sandbox holds with test money. You can close this tab.`);
        } catch (e) { return page(`Not linked: ${String(e.message || e).replace(/[<>&]/g, '')}`, 400); }
      }
      if (p === '/paypal/demo-buyer/cancel') return new Response('Demo buyer link cancelled. Nothing changed.', { status: 200 });
      // photos of real products and real businesses, through Mandat's own origin (src/core/imgproxy.mjs)
      if (p === '/img' && request.method === 'GET') return await serveImg(url);
      if (p === '/' || p === '/simulator') return Response.redirect(new URL('/simulator/', url), 302);
      for (const prefix of Object.keys(STATIC)) if (p.startsWith(prefix) && request.method === 'GET') return await serveStatic(prefix, p);
      return new Response('Not found', { status: 404 });
    } catch (e) {
      console.error('[app]', p, e);
      return json(500, { error: 'Server error' });
    }
  };
}
