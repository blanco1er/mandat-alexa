// Account linking for Alexa+ (Amazon "Account Linking for MCP add-ons", read 18 Oct 2026):
//   OAuth 2.1 authorization code grant only (no implicit grant), PKCE S256 required, a refresh token with every
//   access token, the `resource` parameter (RFC 8707) = this MCP server's canonical URI, static client
//   registration (no Dynamic Client Registration), all of Alexa's redirect URIs registered, and HTTP 401/403 when a
//   tool is called without a valid token (then Alexa starts the linking flow by itself).
// This is Mandat's own minimal authorization server, on the same Lambda as the MCP server (one domain, one deploy,
// DynamoDB rows for codes and tokens, no extra AWS service). Why not Cognito: see README "Account linking".
//
// Rows (one store, keys like the rest of Mandat; DynamoDB TTL drops the expired ones):
//   OAUTH#CODE#<sha256(code)>  / C   { client_id, redirect_uri, challenge, scope, resource, household, exp }
//   OAUTH#AT#<sha256(token)>   / T   { household, client_id, scope, link_id, exp }
//   OAUTH#RT#<sha256(token)>   / T   { household, client_id, scope, link_id, exp, rotated? }
//   HOUSEHOLD#<id>             / LINK#<link_id>  { id, client_id, scope, created, tokens: [{ pk, exp }] }
// Tokens are opaque random strings; only their SHA-256 is stored, so a table dump links nobody.
import crypto from 'node:crypto';
import { pkOf } from '../store/index.mjs';

export const SCOPES = {
  household: 'See your budgets, orders, settings and household memory',
  spend: 'Find, book and place payment holds inside the rules you set',
};
export const ACCESS_TTL = 3600; // seconds (Amazon's example)
export const REFRESH_TTL = 60 * 86400;
export const REUSE_GRACE = 60; // seconds: a refresh whose answer was lost, or two tabs refreshing at once
const CODE_TTL = 300;
const TXN_TTL = 900;
export const SIM_CLIENT = 'alexa-plus-simulator';

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const s256 = (verifier) => b64u(crypto.createHash('sha256').update(String(verifier)).digest());
const rand = (n = 32) => b64u(crypto.randomBytes(n));
const safeEq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const noStore = { 'cache-control': 'no-store', pragma: 'no-cache' };
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...noStore, ...headers } });

// The canonical resource (MCP endpoint). Amazon: "must exactly match the URL in your add-on manifest — including or
// excluding any trailing slash"; we accept both spellings on input and publish the one without the slash.
export const resourceOf = (publicUrl) => `${String(publicUrl).replace(/\/$/, '')}/mcp`;
const sameResource = (a, b) => String(a || '').replace(/\/$/, '') === String(b || '').replace(/\/$/, '');

// RFC 9728 (Amazon's "well-known metadata document"): Alexa reads it at configure time.
export function protectedResourceMetadata(publicUrl) {
  const base = String(publicUrl).replace(/\/$/, '');
  return {
    resource: resourceOf(base),
    authorization_servers: [base],
    scopes_supported: Object.keys(SCOPES),
    bearer_methods_supported: ['header'],
    resource_name: 'Mandat for Alexa+',
    resource_documentation: `${base}/simulator/`,
    resource_policy_uri: `${base}/privacy`,
  };
}
// RFC 8414: where Alexa discovers the endpoints and checks that S256 is supported.
export function authorizationServerMetadata(publicUrl) {
  const base = String(publicUrl).replace(/\/$/, '');
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    scopes_supported: Object.keys(SCOPES),
    ui_locales_supported: ['en-US', 'fr-FR', 'es-ES'],
    service_documentation: `${base}/simulator/`,
    op_policy_uri: `${base}/privacy`,
  };
}
export const wwwAuthenticate = (publicUrl, error) => `Bearer realm="mandat", resource_metadata="${String(publicUrl).replace(/\/$/, '')}/.well-known/oauth-protected-resource"${error ? `, error="${error}"` : ''}`;

// Static client registration (Amazon: DCR is not supported).
//  - the real Alexa+ client: id MANDAT_OAUTH_CLIENT_ID (default "alexa-plus"), secret MANDAT_OAUTH_CLIENT_SECRET (only
//    its hash is kept in memory), redirect URIs MANDAT_OAUTH_REDIRECT_URIS (comma list, from the Alexa+ Developer Hub);
//  - this repo's simulator: a public client (PKCE, no secret) whose only redirect URI is our own Alexa-app page.
export function staticClients({ publicUrl, origins = [], env = process.env } = {}) {
  const page = (o) => `${String(o).replace(/\/$/, '')}/simulator/alexa-app.html`;
  const clients = {
    [SIM_CLIENT]: { id: SIM_CLIENT, name: 'Alexa+ simulator', public: true, redirect_uris: [...new Set([publicUrl, ...origins].filter(Boolean).map(page))] },
  };
  const id = env.MANDAT_OAUTH_CLIENT_ID || 'alexa-plus';
  const redirects = String(env.MANDAT_OAUTH_REDIRECT_URIS || '').split(',').map((s) => s.trim()).filter((s) => /^https:\/\//.test(s));
  clients[id] = { id, name: 'Alexa+', public: !env.MANDAT_OAUTH_CLIENT_SECRET, secret_hash: env.MANDAT_OAUTH_CLIENT_SECRET ? sha256(env.MANDAT_OAUTH_CLIENT_SECRET) : null, redirect_uris: redirects };
  return clients;
}

// ---------- the linking page (EN / FR / ES, from ui_locales) ----------
const PAGE = {
  en: {
    title: 'Link Mandat with Alexa', lead: 'Alexa is asking to use your Mandat household.', can: 'Alexa will be able to',
    s_household: 'See your budgets, orders, settings and household memory', s_spend: 'Find, book and place payment holds, only inside the rules you set', never: 'Never above your limits, and nothing is charged before a service is done.',
    demo: 'Continue as demo household', demoSub: 'Pre-filled for judges: Max the dog is allergic to chicken, you drink Northbeam coffee. No sign-up.',
    fresh: 'Start an empty household', cancel: 'Cancel', foot: 'You can unlink Mandat anytime in the Alexa app. Mandat never sees your Amazon password.', privacy: 'Privacy',
    bad: 'This link request is not valid', badSub: 'Go back to the Alexa app and try again.', expired: 'This page expired. Go back to the Alexa app and start again.',
  },
  fr: {
    title: 'Lier Mandat à Alexa', lead: 'Alexa demande l’accès à votre foyer Mandat.', can: 'Alexa pourra',
    s_household: 'Voir vos budgets, commandes, réglages et la mémoire de la maison', s_spend: 'Chercher, réserver et bloquer des paiements, seulement dans les règles que vous fixez', never: 'Jamais au-delà de vos limites, et rien n’est débité avant la prestation.',
    demo: 'Continuer avec le foyer de démo', demoSub: 'Prérempli pour le jury : Max le chien est allergique au poulet, vous buvez du café Northbeam. Sans inscription.',
    fresh: 'Créer un foyer vide', cancel: 'Annuler', foot: 'Vous pouvez délier Mandat à tout moment dans l’app Alexa. Mandat ne voit jamais votre mot de passe Amazon.', privacy: 'Confidentialité',
    bad: 'Cette demande de liaison n’est pas valide', badSub: 'Revenez à l’app Alexa et réessayez.', expired: 'Cette page a expiré. Revenez à l’app Alexa et recommencez.',
  },
  es: {
    title: 'Vincular Mandat con Alexa', lead: 'Alexa pide acceso a tu hogar en Mandat.', can: 'Alexa podrá',
    s_household: 'Ver tus presupuestos, pedidos, ajustes y la memoria de la casa', s_spend: 'Buscar, reservar y retener pagos, solo dentro de las reglas que fijes', never: 'Nunca por encima de tus límites, y no se cobra nada antes del servicio.',
    demo: 'Continuar con el hogar de demo', demoSub: 'Preparado para el jurado: Max, el perro, es alérgico al pollo; tomáis café Northbeam. Sin registro.',
    fresh: 'Crear un hogar vacío', cancel: 'Cancelar', foot: 'Puedes desvincular Mandat cuando quieras en la app de Alexa. Mandat nunca ve tu contraseña de Amazon.', privacy: 'Privacidad',
    bad: 'Esta solicitud de vinculación no es válida', badSub: 'Vuelve a la app de Alexa e inténtalo de nuevo.', expired: 'Esta página ha caducado. Vuelve a la app de Alexa y empieza de nuevo.',
  },
};
const langOfUi = (ui) => { const l = String(ui || '').toLowerCase(); return l.startsWith('fr') ? 'fr' : l.startsWith('es') ? 'es' : 'en'; };
const CSS = `
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; background: var(--bg-grouped); color: var(--label); font-family: var(--font-sans); -webkit-font-smoothing: antialiased; display: grid; place-items: start center; }
main { width: min(100%, 440px); padding: 28px 20px 32px; box-sizing: border-box; display: grid; gap: 22px; }
.mark { width: 56px; height: 56px; border-radius: 14px; background: #000; display: grid; place-items: center; box-shadow: 0 0 0 .5px rgba(255,255,255,.18); }
.mark svg { width: 34px; height: 34px; fill: none; stroke: #fff; stroke-width: 3.2; stroke-linecap: round; stroke-linejoin: round; }
h1 { font: 700 var(--text-title1)/1.15 var(--font-display); letter-spacing: var(--tracking-title1); margin: 0; }
.lead { margin: 6px 0 0; color: var(--label-secondary); font-size: var(--text-body); line-height: 1.35; }
.group { background: var(--bg-grouped-secondary); border-radius: 14px; padding: 4px 16px; }
.group h2 { font: 590 var(--text-footnote)/1.3 var(--font-sans); color: var(--label-secondary); margin: 12px 0 2px; }
.group ul { list-style: none; margin: 0; padding: 0; }
.group li { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 10px; align-items: start; padding: 12px 0; border-top: .5px solid var(--separator); font-size: var(--text-body); line-height: 1.3; }
.group li:first-child { border-top: 0; }
.group li svg { width: 22px; height: 22px; fill: none; stroke: var(--accent-text); stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; margin-top: 1px; }
.note { margin: 0 0 12px; font-size: var(--text-footnote); color: var(--label-secondary); line-height: 1.35; }
.actions { display: grid; gap: 10px; }
button { font: inherit; border: 0; cursor: pointer; border-radius: 14px; min-height: 50px; padding: 12px 18px; text-align: center; transition: transform .2s cubic-bezier(.2,.9,.3,1.3), opacity .2s; }
button:active { transform: scale(.97); }
button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.primary { background: var(--accent); color: #fff; font-weight: 590; font-size: var(--text-headline); display: grid; gap: 3px; }
.primary small { font-weight: 400; font-size: var(--text-footnote); opacity: .88; line-height: 1.3; }
.secondary { background: var(--fill-tertiary); color: var(--accent-text); font-weight: 590; font-size: var(--text-body); }
.plain { background: none; color: var(--accent-text); min-height: 44px; font-size: var(--text-body); }
footer { font-size: var(--text-footnote); color: var(--label-secondary); line-height: 1.4; text-align: center; }
footer a { color: var(--accent-text); }
button[aria-busy="true"] { opacity: .6; pointer-events: none; }
`;
const MARK = `<span class="mark" aria-hidden="true"><svg viewBox="0 0 64 64"><path d="M18 44V20l14 15 14-15v24"/></svg></span>`;
function page(lang, body, { formAction = "'self'" } = {}) {
  const t = PAGE[lang];
  return new Response(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(t.title)} · Mandat</title><meta name="robots" content="noindex">
<link rel="stylesheet" href="/simulator/design-system/tokens.css"><style>${CSS}</style></head>
<body><main>${body}</main></body></html>`, {
    headers: {
      'content-type': 'text/html; charset=utf-8', ...noStore,
      // our own pages only; the form may only post here and redirect to the registered redirect URI
      'content-security-policy': `default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action ${formAction}; frame-ancestors 'self'; base-uri 'none'`,
      'x-frame-options': 'SAMEORIGIN', 'referrer-policy': 'same-origin', // (no-referrer would send "Origin: null" with the form)
    },
  });
}
const ICON = {
  household: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/></svg>',
  spend: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10.5h18M7 15h4"/></svg>',
};

export class OAuthServer {
  // store: the Mandat store; seed(kind) -> household id (creates the demo or an empty household).
  constructor({ store, publicUrl, origins = [], secret = process.env.MANDAT_OAUTH_SECRET || process.env.MANDAT_NETWORK_SECRET, clients, seed, now = () => Date.now() }) {
    this.store = store;
    this.publicUrl = String(publicUrl).replace(/\/$/, '');
    this.clients = clients || staticClients({ publicUrl: this.publicUrl, origins });
    // The page's transaction is signed: a stable secret on Lambda (MANDAT_NETWORK_SECRET), a per-process one locally.
    this.key = crypto.createHash('sha256').update(`mandat-oauth:${secret || crypto.randomBytes(32).toString('hex')}`).digest();
    this.seed = seed;
    this.now = now;
  }
  sec() { return Math.floor(this.now() / 1000); }
  sign(obj) { const body = b64u(JSON.stringify(obj)); return `${body}.${b64u(crypto.createHmac('sha256', this.key).update(body).digest())}`; }
  unsign(txn) {
    const [body, mac] = String(txn || '').split('.');
    if (!body || !mac || !safeEq(mac, b64u(crypto.createHmac('sha256', this.key).update(body).digest()))) return null;
    try { return JSON.parse(Buffer.from(body, 'base64').toString('utf8')); } catch { return null; }
  }

  // Validate an authorization request (query of GET /oauth/authorize). Errors before the redirect URI is trusted are
  // shown on our page; after that, they go back to the client as ?error=…&state=… (RFC 6749 §4.1.2.1).
  validate(q) {
    const client = this.clients[q.get('client_id') || ''];
    const redirect = q.get('redirect_uri') || '';
    if (!client) return { page: 'unknown client_id' };
    if (!client.redirect_uris.includes(redirect)) return { page: 'redirect_uri is not registered for this client' };
    const state = q.get('state') || '';
    const back = (error, description) => ({ redirect: withQuery(redirect, { error, error_description: description, state: state || undefined }) });
    if (q.get('response_type') !== 'code') return back('unsupported_response_type', 'Only the authorization code grant is supported (no implicit grant).');
    if (q.get('code_challenge_method') !== 'S256') return back('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    if (!CHALLENGE_RE.test(q.get('code_challenge') || '')) return back('invalid_request', 'code_challenge must be a base64url SHA-256 (43 characters).');
    const resource = q.get('resource');
    if (resource && !sameResource(resource, resourceOf(this.publicUrl))) return back('invalid_target', `This server only issues tokens for ${resourceOf(this.publicUrl)}.`);
    const asked = (q.get('scope') || Object.keys(SCOPES).join(' ')).split(/\s+/).filter(Boolean);
    const scope = asked.filter((s) => SCOPES[s] || s === 'openid' || s === 'offline_access');
    if (!scope.some((s) => SCOPES[s])) return back('invalid_scope', `Ask for ${Object.keys(SCOPES).join(' and ')}.`);
    return { ok: { client_id: client.id, redirect_uri: redirect, state, challenge: q.get('code_challenge'), scope: scope.filter((s) => SCOPES[s]).join(' '), resource: resourceOf(this.publicUrl), ui: q.get('ui_locales') || '' } };
  }

  // GET /oauth/authorize: the Mandat linking page (one tap for judges).
  authorizePage(url) {
    const v = this.validate(url.searchParams);
    const lang = langOfUi(url.searchParams.get('ui_locales'));
    const t = PAGE[lang];
    if (v.page) return this.errorPage(lang, v.page, 400);
    if (v.redirect) return Response.redirect(v.redirect, 302);
    const req = v.ok;
    const txn = this.sign({ ...req, exp: this.sec() + TXN_TTL });
    const scopes = req.scope.split(' ').map((s) => `<li>${ICON[s] || ICON.household}<span>${esc(t['s_' + s])}</span></li>`).join('');
    const body = `${MARK}
<div><h1>${esc(t.title)}</h1><p class="lead">${esc(t.lead)}</p></div>
<section class="group" aria-labelledby="can"><h2 id="can">${esc(t.can)}</h2><ul>${scopes}</ul><p class="note">${esc(t.never)}</p></section>
<form method="post" action="/oauth/authorize" class="actions" id="f">
  <input type="hidden" name="txn" value="${esc(txn)}">
  <button class="primary" name="choice" value="demo" type="submit" autofocus>${esc(t.demo)}<small>${esc(t.demoSub)}</small></button>
  <button class="secondary" name="choice" value="new" type="submit">${esc(t.fresh)}</button>
  <button class="plain" name="choice" value="deny" type="submit">${esc(t.cancel)}</button>
</form>
<footer>${esc(t.foot)} <a href="/privacy" target="_blank" rel="noopener">${esc(t.privacy)}</a></footer>`;
    return page(lang, body, { formAction: `'self' ${new URL(req.redirect_uri).origin}` });
  }
  errorPage(lang, detail, status = 400) {
    const t = PAGE[lang];
    const r = page(lang, `${MARK}<div><h1>${esc(t.bad)}</h1><p class="lead">${esc(t.badSub)}</p><p class="lead"><small>${esc(detail)}</small></p></div>`);
    return new Response(r.body, { status, headers: r.headers });
  }

  // POST /oauth/authorize: the person chose; issue a one-time code bound to the PKCE challenge and redirect back.
  async authorizeSubmit(request) {
    const form = new URLSearchParams(await request.text());
    const req = this.unsign(form.get('txn'));
    if (!req) return this.errorPage('en', 'bad transaction', 400);
    const lang = langOfUi(req.ui);
    if (req.exp < this.sec()) return this.errorPage(lang, PAGE[lang].expired, 400);
    const client = this.clients[req.client_id];
    if (!client || !client.redirect_uris.includes(req.redirect_uri)) return this.errorPage(lang, 'redirect_uri is not registered', 400);
    const choice = form.get('choice');
    if (choice === 'deny') return Response.redirect(withQuery(req.redirect_uri, { error: 'access_denied', error_description: 'The person cancelled linking.', state: req.state || undefined }), 302);
    const household = await this.seed(choice === 'new' ? 'empty' : 'demo');
    const code = rand(32);
    await this.store.put(`OAUTH#CODE#${sha256(code)}`, 'C', { client_id: req.client_id, redirect_uri: req.redirect_uri, challenge: req.challenge, scope: req.scope, resource: req.resource, household, exp: this.sec() + CODE_TTL });
    return Response.redirect(withQuery(req.redirect_uri, { code, state: req.state || undefined }), 302);
  }

  clientFrom(request, form) {
    let id = form.get('client_id') || '', secret = form.get('client_secret') || '';
    const basic = /^Basic\s+(.+)$/i.exec(request.headers.get('authorization') || '');
    if (basic) {
      const [u, p] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
      id = decodeURIComponent(u || ''); secret = decodeURIComponent(p || '');
    }
    const c = this.clients[id];
    if (!c) return null;
    if (!c.public && !(secret && safeEq(sha256(secret), c.secret_hash))) return null;
    return c;
  }

  // POST /oauth/token: authorization_code (with code_verifier) and refresh_token (rotated on every use).
  async token(request) {
    const type = request.headers.get('content-type') || '';
    const raw = await request.text();
    const form = type.includes('json') ? new URLSearchParams(Object.entries(JSON.parse(raw || '{}')).map(([k, v]) => [k, String(v)])) : new URLSearchParams(raw);
    const client = this.clientFrom(request, form);
    if (!client) return json(401, { error: 'invalid_client', error_description: 'Unknown client or wrong client secret.' }, { 'www-authenticate': 'Basic realm="mandat"' });
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      const code = form.get('code') || '';
      const pk = `OAUTH#CODE#${sha256(code)}`;
      const row = code ? await this.store.get(pk, 'C') : null;
      if (!row) return json(400, { error: 'invalid_grant', error_description: 'Unknown or already used authorization code.' });
      await this.store.delete(pk, 'C'); // one use, even if the checks below fail
      if (row.exp < this.sec()) return json(400, { error: 'invalid_grant', error_description: 'The authorization code expired.' });
      if (row.client_id !== client.id) return json(400, { error: 'invalid_grant', error_description: 'This code was issued to another client.' });
      if ((form.get('redirect_uri') || '') !== row.redirect_uri) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri does not match the authorization request.' });
      const verifier = form.get('code_verifier') || '';
      if (!VERIFIER_RE.test(verifier) || !safeEq(s256(verifier), row.challenge)) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed (code_verifier does not match code_challenge).' });
      const resource = form.get('resource');
      if (resource && !sameResource(resource, row.resource)) return json(400, { error: 'invalid_target', error_description: 'resource does not match the authorization request.' });
      return json(200, await this.issue({ household: row.household, client_id: client.id, scope: row.scope }));
    }
    if (grant === 'refresh_token') {
      const rt = form.get('refresh_token') || '';
      const pk = `OAUTH#RT#${sha256(rt)}`;
      const row = rt ? await this.store.get(pk, 'T') : null;
      if (!row || row.exp < this.sec() || row.client_id !== client.id) return json(400, { error: 'invalid_grant', error_description: 'Unknown, expired or revoked refresh token.' });
      if (row.rotated) {
        // A lost answer (a phone that slept, a network that dropped) or two tabs refreshing at once bring the same
        // refresh token back within seconds: inside a short reuse interval the link keeps working (a judge never
        // loses the demo).
        // Any other reuse means someone kept a copy: revoke the whole link (OAuth 2.1 §4.3.1).
        if (this.sec() - (row.rotated_at || 0) <= REUSE_GRACE) {
          console.warn('[oauth] refresh token reused inside the reuse interval: new pair for the same link', row.link_id);
          return json(200, await this.issue({ household: row.household, client_id: client.id, scope: row.scope, link_id: row.link_id }));
        }
        console.warn('[oauth] refresh token reused after the reuse interval: link revoked', row.link_id);
        await this.revokeLink(row.household, row.link_id);
        return json(400, { error: 'invalid_grant', error_description: 'This refresh token was already used; the link was revoked for safety.' });
      }
      await this.store.put(pk, 'T', { ...row, rotated: true, rotated_at: this.sec() });
      return json(200, await this.issue({ household: row.household, client_id: client.id, scope: row.scope, link_id: row.link_id }));
    }
    return json(400, { error: 'unsupported_grant_type', error_description: 'Use authorization_code or refresh_token.' });
  }

  async issue({ household, client_id, scope, link_id }) {
    const at = rand(32), rt = rand(32);
    const now = this.sec();
    const lid = link_id || `lnk_${crypto.randomBytes(6).toString('hex')}`;
    const atRow = { household, client_id, scope, link_id: lid, exp: now + ACCESS_TTL };
    const rtRow = { household, client_id, scope, link_id: lid, exp: now + REFRESH_TTL };
    await this.store.put(`OAUTH#AT#${sha256(at)}`, 'T', atRow);
    await this.store.put(`OAUTH#RT#${sha256(rt)}`, 'T', rtRow);
    const link = (await this.store.get(pkOf(household), `LINK#${lid}`)) || { id: lid, client_id, scope, created: new Date(this.now()).toISOString(), tokens: [] };
    link.tokens = [...link.tokens.filter((t) => t.exp > now), { pk: `OAUTH#AT#${sha256(at)}`, exp: atRow.exp }, { pk: `OAUTH#RT#${sha256(rt)}`, exp: rtRow.exp }].slice(-40);
    link.last_used = new Date(this.now()).toISOString();
    await this.store.put(pkOf(household), `LINK#${lid}`, link);
    return { access_token: at, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: rt, scope };
  }

  // Bearer check for the MCP endpoint (and the simulator's /turn): -> { household, scope: [], client_id, link_id } | null
  async verify(authorization) {
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(String(authorization || '').trim());
    if (!m) return null;
    const row = await this.store.get(`OAUTH#AT#${sha256(m[1])}`, 'T');
    if (!row || row.exp < this.sec()) return null;
    return { household: row.household, scope: String(row.scope || '').split(' ').filter(Boolean), client_id: row.client_id, link_id: row.link_id, expiresAt: row.exp };
  }

  // POST /oauth/revoke (RFC 7009): an access or refresh token; the whole link goes (Alexa "Unlink").
  async revoke(request) {
    const form = new URLSearchParams(await request.text());
    const client = this.clientFrom(request, form);
    if (!client) return json(401, { error: 'invalid_client' });
    const tok = form.get('token') || '';
    for (const kind of ['AT', 'RT']) {
      const row = tok ? await this.store.get(`OAUTH#${kind}#${sha256(tok)}`, 'T') : null;
      if (row && row.client_id === client.id) { await this.revokeLink(row.household, row.link_id); break; }
    }
    return new Response(null, { status: 200, headers: noStore }); // always 200, even for an unknown token (RFC 7009 §2.2)
  }
  async revokeLink(household, lid) {
    const link = await this.store.get(pkOf(household), `LINK#${lid}`);
    for (const t of link?.tokens || []) await this.store.delete(t.pk, 'T');
    await this.store.delete(pkOf(household), `LINK#${lid}`);
  }
  // Every link of a household (used by "delete my data").
  async revokeHousehold(household) {
    for (const { value } of await this.store.query(pkOf(household), 'LINK#')) await this.revokeLink(household, value.id);
  }
}

export function withQuery(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  return u.href;
}

// Minimal privacy policy (Amazon: "A publicly accessible privacy policy that covers account data usage").
export function privacyPage() {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Privacy · Mandat for Alexa+</title>
<link rel="stylesheet" href="/simulator/design-system/tokens.css"><style>body{margin:0;background:var(--bg-grouped);color:var(--label);font:17px/1.5 var(--font-sans)}main{max-width:680px;margin:0 auto;padding:40px 20px}h1{font:700 28px/1.2 var(--font-display)}h2{font:590 17px/1.3 var(--font-sans);margin-top:28px}p,li{color:var(--label-secondary)}</style></head><body><main>
<h1>Mandat for Alexa+ privacy</h1>
<p>This is a hackathon demo. It uses PayPal <b>sandbox</b> test money only; no real payment is ever made.</p>
<h2>What Mandat keeps</h2><ul><li>Your household's budgets, settings, orders and the preferences you ask it to remember.</li><li>The details you allow in the Alexa app (name, email, address), only to greet you, send receipts and book at your address.</li><li>Hashes of the access and refresh tokens Alexa uses; never your Amazon password.</li></ul>
<h2>Where the shops and businesses come from</h2><ul><li>Products are real products and prices from US online stores (through Channel3). Mandat never places an order with a store.</li><li>Local businesses are real businesses near the household (Google Maps or OpenStreetMap). Their price is an estimate, and a booking is only a request that this demo does not send. Mandat never contacts them.</li><li>Demo partners are simulated merchant agents, the only ones that negotiate.</li></ul>
<h2>Anonymous usage of this demo</h2><ul><li>To learn whether and how the demo is used, Mandat logs anonymous events: the time, what was opened or said (the sentence, with e-mail addresses and numbers masked, at most 200 characters), the tools it called, the device and language chosen, your browser and system family, and the site you came from.</li><li>No IP address is stored: a visitor is a salted one-way hash of the IP address and browser, which cannot be turned back into either.</li><li>No password, token, name, e-mail or address is ever logged. The log is kept 120 days, then deleted automatically, and only the project owner can read it. It is never shared or sold.</li></ul>
<h2>What Mandat never does</h2><ul><li>Sell or share your data. Merchants' agents receive only what a quote needs (a day, a time, a number of guests).</li><li>Spend above the rules you set, or move money without a yes when your settings ask for one.</li></ul>
<h2>Your controls</h2><ul><li>Unlink in the Alexa app: every token is revoked at once.</li><li>Turn a permission off: Mandat deletes that detail.</li><li>Say “Alexa, delete my Mandat data”: open holds are voided, then the whole household is erased.</li></ul>
<p>Contact: the project page on Devpost (Mandat for Alexa+).</p><p><a href="/simulator/" style="color:var(--accent-text);display:inline-flex;align-items:center;min-height:44px;padding:0 4px">Back to the simulator</a></p></main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
