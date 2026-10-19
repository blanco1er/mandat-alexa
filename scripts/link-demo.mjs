// Links a fresh household to a Mandat server the way Alexa does (OAuth 2.1 authorization code + PKCE S256, the
// resource parameter, the simulator's registered redirect URI) and returns its tokens. Used by the tests, the
// MCP Inspector battery and the live checks, so none of them needs a person to tap the linking page.
//   node scripts/link-demo.mjs https://<function-url> [demo|new] [--token]
// Without --token it prints the household and the expiry only (never a token); with --token it prints only the
// access token (for a shell variable: AT="$(node scripts/link-demo.mjs "$URL" demo --token)").
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// our own scripts never count as visits of the public demo (src/core/visits.mjs)
export const INTERNAL = { 'X-Mandat-Visit': 'internal' };
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function linkHousehold(base, { choice = 'demo', clientId = 'alexa-plus-simulator', scope = 'household spend', locale = 'en-US' } = {}) {
  base = base.replace(/\/$/, '');
  const redirect = `${base}/simulator/alexa-app.html`;
  const verifier = b64u(crypto.randomBytes(48));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const state = b64u(crypto.randomBytes(12));
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope, state, code_challenge: challenge, code_challenge_method: 'S256', resource: `${base}/mcp`, ui_locales: locale });
  const page = await fetch(`${base}/oauth/authorize?${q}`, { headers: INTERNAL });
  const html = await page.text();
  const txn = /name="txn" value="([^"]+)"/.exec(html)?.[1];
  if (!page.ok || !txn) throw new Error(`authorize page: HTTP ${page.status}`);
  const back = await fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, ...INTERNAL }, body: new URLSearchParams({ txn, choice }) });
  const loc = new URL(back.headers.get('location') || 'about:blank');
  if (loc.searchParams.get('state') !== state) throw new Error('state mismatch');
  const code = loc.searchParams.get('code');
  if (!code) throw new Error(`no code: ${loc.searchParams.get('error') || back.status}`);
  const tok = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier, resource: `${base}/mcp` }) });
  const body = await tok.json();
  if (!tok.ok) throw new Error(`token: ${body.error} ${body.error_description || ''}`);
  return { ...body, redirect, verifier, challenge };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, choice = 'demo', flag] = process.argv.slice(2);
  if (!base) { console.error('usage: node scripts/link-demo.mjs <base-url> [demo|new] [--token]'); process.exit(2); }
  const t = await linkHousehold(base, { choice });
  if (flag === '--token') process.stdout.write(t.access_token);
  else console.log(`linked a ${choice} household; access token expires in ${t.expires_in} s; scope "${t.scope}"; refresh token issued: ${!!t.refresh_token}`);
}
