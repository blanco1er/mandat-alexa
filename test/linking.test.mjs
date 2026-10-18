// Account linking (Amazon "Account Linking for Alexa+ MCP add-ons"): OAuth 2.1 authorization code + PKCE S256,
// resource parameter, refresh token with every access token (rotated), static clients and redirect URIs, 401 on a
// tool call without a token, the household bound to the token (isolation), revoke, and the customer-data permissions.
process.env.MANDAT_AUTH = 'required';
const { boot, sc, text, rpc } = await import('./helpers.mjs');
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { linkHousehold } from '../scripts/link-demo.mjs';
import { connectMcp } from '../src/brain/simulated.mjs';

const srv = await boot();
test.after(() => srv.close());
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });
const asUser = async (token, name = 'linking-tests') => (await connectMcp(srv.mcpUrl, { household: 'someone-else', name, headers: { Authorization: `Bearer ${token}` } })).client;
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } };

test('metadata: RFC 9728 protected resource (first authorization server = us) and RFC 8414 with S256 only', async () => {
  const pr = await (await fetch(`${srv.url}/.well-known/oauth-protected-resource`)).json();
  assert.equal(pr.resource, `${srv.url}/mcp`);
  assert.deepEqual(pr.authorization_servers, [srv.url]);
  assert.deepEqual(pr.scopes_supported, ['household', 'spend']);
  const as = await (await fetch(`${srv.url}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(as.response_types_supported, ['code']);
  assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
  assert.ok(!('registration_endpoint' in as), 'no dynamic client registration');
  assert.equal(as.token_endpoint, `${srv.url}/oauth/token`);
  assert.equal((await fetch(`${srv.url}/privacy`)).status, 200);
});

test('a tool call without a token answers HTTP 401 with WWW-Authenticate; discovery stays public', async () => {
  const init = await rpc(srv.mcpUrl, INIT);
  assert.equal(init.status, 200);
  const list = await rpc(srv.mcpUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': '2025-11-25' });
  assert.equal(list.status, 200);
  const call = await rpc(srv.mcpUrl, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_household_status', arguments: {} } }, { 'mcp-protocol-version': '2025-11-25', 'x-mandat-household': 'demo' });
  assert.equal(call.status, 401);
  assert.match(call.headers.get('www-authenticate'), /^Bearer .*resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/);
  assert.equal((await call.json()).error, 'unauthorized');
  const bad = await rpc(srv.mcpUrl, INIT, { authorization: 'Bearer ' + 'x'.repeat(43) });
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get('www-authenticate'), /error="invalid_token"/);
  // /turn without a link asks the host to start linking
  const turn = await fetch(`${srv.url}/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'How much is left?' }) });
  assert.equal(turn.status, 401);
  assert.equal((await turn.json()).link_required, true);
});

test('authorization code + PKCE S256: demo household pre-filled, refresh token issued, tokens work over MCP', async () => {
  const t = await linkHousehold(srv.url, { choice: 'demo' });
  assert.equal(t.token_type, 'Bearer');
  assert.equal(t.expires_in, 3600);
  assert.ok(t.refresh_token && t.access_token !== t.refresh_token);
  assert.equal(t.scope, 'household spend');
  const c = await asUser(t.access_token);
  const st = sc(await c.callTool({ name: 'get_household_status', arguments: {} }));
  assert.match(st.household_id, /^demo-[0-9a-f]{10}$/);
  assert.deepEqual(st.preferences.map((p) => p.subject).sort(), ['Coffee', 'Max (dog)']);
  await c.close();
});

test('PKCE and request checks: plain refused, wrong verifier refused, code is single use, redirect_uri exact', async () => {
  const redirect = `${srv.url}/simulator/alexa-app.html`;
  const auth = (extra) => fetch(`${srv.url}/oauth/authorize?${new URLSearchParams({ client_id: 'alexa-plus-simulator', redirect_uri: redirect, response_type: 'code', scope: 'household spend', state: 's1', resource: `${srv.url}/mcp`, ...extra })}`, { redirect: 'manual' });
  const plain = await auth({ code_challenge: 'a'.repeat(43), code_challenge_method: 'plain' });
  assert.equal(plain.status, 302);
  assert.match(plain.headers.get('location'), /error=invalid_request/);
  const implicit = await auth({ response_type: 'token', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
  assert.match(implicit.headers.get('location'), /error=unsupported_response_type/);
  const wrongRes = await auth({ code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', resource: 'https://evil.example/mcp' });
  assert.match(wrongRes.headers.get('location'), /error=invalid_target/);
  const foreign = await fetch(`${srv.url}/oauth/authorize?${new URLSearchParams({ client_id: 'alexa-plus-simulator', redirect_uri: 'https://evil.example/cb', response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' })}`, { redirect: 'manual' });
  assert.equal(foreign.status, 400, 'an unregistered redirect_uri is never redirected to');
  assert.equal((await fetch(`${srv.url}/oauth/authorize?client_id=nobody&redirect_uri=${encodeURIComponent(redirect)}`)).status, 400);

  // a real code, then a wrong verifier: refused, and the code is burnt
  const verifier = b64u(crypto.randomBytes(48));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const html = await (await auth({ code_challenge: challenge, code_challenge_method: 'S256' })).text();
  const txn = /name="txn" value="([^"]+)"/.exec(html)[1];
  const back = await fetch(`${srv.url}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: srv.url }, body: new URLSearchParams({ txn, choice: 'new' }) });
  const code = new URL(back.headers.get('location')).searchParams.get('code');
  const wrong = await fetch(`${srv.url}/oauth/token`, form({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: 'alexa-plus-simulator', code_verifier: b64u(crypto.randomBytes(48)) }));
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).error, 'invalid_grant');
  const again = await fetch(`${srv.url}/oauth/token`, form({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: 'alexa-plus-simulator', code_verifier: verifier }));
  assert.equal(again.status, 400, 'a code is used once, even after a failed exchange');
  // a forged transaction is refused
  const forged = await fetch(`${srv.url}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: srv.url }, body: new URLSearchParams({ txn: txn.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), choice: 'demo' }) });
  assert.equal(forged.status, 400);
  // cancel goes back with access_denied
  const html2 = await (await auth({ code_challenge: challenge, code_challenge_method: 'S256' })).text();
  const deny = await fetch(`${srv.url}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: srv.url }, body: new URLSearchParams({ txn: /name="txn" value="([^"]+)"/.exec(html2)[1], choice: 'deny' }) });
  assert.match(deny.headers.get('location'), /error=access_denied&.*state=s1|state=s1.*error=access_denied|error=access_denied/);
});

test('refresh tokens rotate; a reused refresh token revokes the whole link', async () => {
  const t = await linkHousehold(srv.url, { choice: 'new' });
  const r1 = await (await fetch(`${srv.url}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: 'alexa-plus-simulator' }))).json();
  assert.ok(r1.access_token && r1.refresh_token && r1.refresh_token !== t.refresh_token);
  const reuse = await fetch(`${srv.url}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: 'alexa-plus-simulator' }));
  assert.equal(reuse.status, 400);
  const dead = await rpc(srv.mcpUrl, INIT, { authorization: `Bearer ${r1.access_token}` });
  assert.equal(dead.status, 401, 'reuse detection revoked the new access token too');
});

test('households are isolated by the token; a household header cannot reach another household', async () => {
  const a = await linkHousehold(srv.url, { choice: 'new' });
  const b = await linkHousehold(srv.url, { choice: 'new' });
  const ca = await asUser(a.access_token);
  const sa = sc(await ca.callTool({ name: 'set_spending_mandate', arguments: { budget: 300, period: 'once', purpose: 'Party' } }));
  const cb = await asUser(b.access_token);
  const sb = sc(await cb.callTool({ name: 'get_household_status', arguments: {} }));
  assert.notEqual(sa.mandate.id, undefined);
  assert.equal(sb.envelopes.length, 0, 'B never sees A\'s budget');
  const aid = sc(await ca.callTool({ name: 'get_household_status', arguments: {} })).household_id;
  // even naming A's household in the header, B's token stays in B
  const { client: sneaky } = await connectMcp(srv.mcpUrl, { household: aid, headers: { Authorization: `Bearer ${b.access_token}` } });
  assert.equal(sc(await sneaky.callTool({ name: 'get_household_status', arguments: {} })).envelopes.length, 0);
  await Promise.all([ca.close(), cb.close(), sneaky.close()]);
});

test('revoke (Alexa "Unlink") kills every token of the link at once', async () => {
  const t = await linkHousehold(srv.url, { choice: 'new' });
  const r = await fetch(`${srv.url}/oauth/revoke`, form({ token: t.refresh_token, client_id: 'alexa-plus-simulator' }));
  assert.equal(r.status, 200);
  assert.equal((await rpc(srv.mcpUrl, INIT, { authorization: `Bearer ${t.access_token}` })).status, 401);
  assert.equal((await fetch(`${srv.url}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: 'alexa-plus-simulator' }))).status, 400);
});

test('permissions: only what the person allowed is kept; the name greets, the address books; no address, no booking', async () => {
  const t = await linkHousehold(srv.url, { choice: 'demo' });
  const c = await asUser(t.access_token);
  const values = { name: { full: 'Alex Rivera', given: 'Alex' }, email: 'alex.rivera@example.com', address: { line1: '1450 Maple Ave', city: 'Seattle', region: 'WA', postal: '98109' } };
  const p = await c.callTool({ name: 'apply_customer_permissions', arguments: { granted: { name: true, email: false, address: true }, values } });
  assert.match(text(p), /Thanks, Alex\. Mandat now has your name and your address\./);
  assert.equal(sc(p).profile.email, null, 'email not allowed, not kept');
  const s = await c.callTool({ name: 'get_settings', arguments: { first_run: true } });
  assert.match(text(s), /Welcome, Alex/);
  const svc = sc(await c.callTool({ name: 'find_home_services', arguments: { need: 'deep clean', category: 'cleaning', when: 'Friday morning' } }));
  const det = sc(await c.callTool({ name: 'get_offer_details', arguments: { offer_id: svc.offers[0].id } }));
  assert.ok(det.specs.some((x) => /1450 Maple Ave/.test(x.v)));
  // address turned off: the detail is deleted and nothing can be booked at home
  await c.callTool({ name: 'apply_customer_permissions', arguments: { granted: { name: true, email: false, address: false }, values } });
  const plan = sc(await c.callTool({ name: 'propose_plan', arguments: { item_ids: [svc.offers[0].id] } }));
  const no = await c.callTool({ name: 'confirm_plan', arguments: { plan_id: plan.plan.id, confirmation_token: plan.confirmation_token, user_confirmation: 'Yes' } });
  assert.ok(no.isError);
  assert.match(text(no), /need your address/);
  await c.close();
});

test('a read-only link (household scope only) cannot spend', async () => {
  const t = await linkHousehold(srv.url, { choice: 'new', scope: 'household' });
  assert.equal(t.scope, 'household');
  const c = await asUser(t.access_token);
  const r = await c.callTool({ name: 'set_spending_mandate', arguments: { budget: 100, period: 'once', purpose: 'Test' } });
  assert.ok(r.isError);
  assert.match(text(r), /read-only/);
  assert.ok(!(await c.callTool({ name: 'get_household_status', arguments: {} })).isError);
  await c.close();
});

test('delete my data: needs a yes, voids holds, erases the household and revokes its tokens', async () => {
  const t = await linkHousehold(srv.url, { choice: 'demo' });
  const c = await asUser(t.access_token);
  await c.callTool({ name: 'apply_customer_permissions', arguments: { granted: { name: true, email: true, address: true }, values: { name: { full: 'Alex Rivera', given: 'Alex' }, email: 'a@example.com', address: { line1: '1450 Maple Ave' } } } });
  const m = sc(await c.callTool({ name: 'set_spending_mandate', arguments: { budget: 400, period: 'once', purpose: 'Visit' } }));
  const svc = sc(await c.callTool({ name: 'find_home_services', arguments: { need: 'deep clean', category: 'cleaning', when: 'Friday morning' } }));
  const plan = sc(await c.callTool({ name: 'propose_plan', arguments: { item_ids: [svc.offers[0].id], mandate_id: m.mandate.id } }));
  await c.callTool({ name: 'confirm_plan', arguments: { plan_id: plan.plan.id, confirmation_token: plan.confirmation_token, user_confirmation: 'Yes, book it' } });
  const hid = sc(await c.callTool({ name: 'get_household_status', arguments: {} })).household_id;
  assert.ok((await c.callTool({ name: 'delete_my_data', arguments: { user_confirmation: 'maybe' } })).isError);
  const d = await c.callTool({ name: 'delete_my_data', arguments: { user_confirmation: 'Yes, delete it' } });
  assert.ok(!d.isError, text(d));
  assert.match(text(d), /after voiding 1 open hold/);
  assert.equal(sc(d).unlinked, true);
  await c.close();
  assert.equal((await rpc(srv.mcpUrl, INIT, { authorization: `Bearer ${t.access_token}` })).status, 401, 'the token died with the household');
  assert.equal((await srv.service.store.query(`HOUSEHOLD#${hid}`, '')).length, 0, 'nothing left of the household');
});
