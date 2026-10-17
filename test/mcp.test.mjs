// MCP protocol surface: initialize (2025-11-25), Origin check, tools/list, resources (MCP Apps), every tool's happy path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, client, inLawsPlan, rpc, sc, text } from './helpers.mjs';

const srv = await boot();
test.after(() => srv.close());

const TOOLS = ['get_household_status', 'set_spending_mandate', 'remember_preference', 'find_home_services', 'find_products', 'negotiate_offer', 'propose_plan', 'confirm_plan', 'change_order', 'close_order'];

test('initialize negotiates 2025-11-25 over Streamable HTTP and announces the UI extension', async () => {
  const r = await rpc(srv.mcpUrl, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } }, clientInfo: { name: 't', version: '1' } } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  const d = await r.json();
  assert.equal(d.result.protocolVersion, '2025-11-25');
  assert.ok(d.result.capabilities.tools && d.result.capabilities.resources);
  assert.ok(d.result.capabilities.extensions['io.modelcontextprotocol/ui']);
  assert.equal(d.result.serverInfo.name, 'mandat-for-alexa-plus');
  assert.match(d.result.instructions, /confirm_plan/);
});

test('an unknown future protocol version falls back to 2025-11-25', async () => {
  const d = await (await rpc(srv.mcpUrl, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json();
  assert.equal(d.result.protocolVersion, '2025-11-25');
});

test('the SDK client negotiates 2025-11-25 too', async () => {
  const { connectMcp } = await import('../src/brain/simulated.mjs');
  const { client: c, transport } = await connectMcp(srv.mcpUrl, { household: 'proto' });
  assert.equal(transport.protocolVersion, '2025-11-25');
  await c.close();
});

test('a request from a foreign Origin is refused with 403 (2025-11-25 transport rule)', async () => {
  const r = await rpc(srv.mcpUrl, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('tools/list: 10 intent tools + 1 app-only tool, each with a schema and a ui:// resourceUri', async () => {
  const c = await client(srv.mcpUrl);
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOLS, 'refresh_card'].sort());
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.match(t._meta.ui.resourceUri, /^ui:\/\/mandat\/(status|mandate|offers|plan|receipt)-[0-9a-f]{10}\.html$/, t.name);
    assert.ok(t._meta.ui.invoking && t._meta.ui.invoked, t.name);
    assert.ok(t.description.length > 40, t.name);
  }
  assert.deepEqual(tools.find((t) => t.name === 'refresh_card')._meta.ui.visibility, ['app']);
  assert.ok(tools.find((t) => t.name === 'close_order').annotations.destructiveHint);
  assert.ok(tools.find((t) => t.name === 'confirm_plan').annotations.idempotentHint);
  assert.deepEqual(tools.find((t) => t.name === 'confirm_plan').inputSchema.required.sort(), ['confirmation_token', 'plan_id']);
  await c.close();
});

test('resources: 5 MCP Apps views, text/html;profile=mcp-app, self-contained, with _meta.ui', async () => {
  const c = await client(srv.mcpUrl);
  const { resources } = await c.listResources();
  assert.equal(resources.length, 5);
  for (const r of resources) {
    assert.equal(r.mimeType, 'text/html;profile=mcp-app');
    const { contents } = await c.readResource({ uri: r.uri });
    assert.equal(contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.deepEqual(contents[0]._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
    const html = contents[0].text;
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /ui\/initialize/);
    assert.match(html, /ui\/notifications\/initialized/);
    assert.match(html, /ui\/notifications\/size-changed/);
    assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|\/\*BRIDGE_JS\*\/|\/\*SHARED_CSS\*\//, r.uri);
  }
  await c.close();
});

test('every tool works on its happy path and returns voice text + structuredContent + a card', async () => {
  const c = await client(srv.mcpUrl);
  const check = (r, name) => {
    assert.ok(!r.isError, `${name}: ${text(r)}`);
    assert.ok(text(r).length > 5, name);
    assert.doesNotMatch(text(r), /\|/, `${name} speech has no pipes`);
    assert.doesNotMatch(text(r), /\b(off|plan|ord|mdt)_[0-9a-f]{10}\b/, `${name} speech has no ids`);
    assert.match(r._meta.ui.resourceUri, /^ui:\/\/mandat\//, name);
    assert.ok(r.structuredContent, name);
    return r;
  };
  check(await c.callTool({ name: 'remember_preference', arguments: { subject: 'Max (dog)', fact: 'allergic to chicken' } }), 'remember_preference');
  const { m, clean, bed, food, plan } = await inLawsPlan(c);
  for (const [r, n] of [[m, 'set_spending_mandate'], [clean, 'find_home_services'], [bed, 'find_products'], [food, 'find_home_services'], [plan, 'propose_plan']]) check(r, n);
  const neg = check(await c.callTool({ name: 'negotiate_offer', arguments: { offer_id: sc(clean).offers[1].id, ask: 'Can you do Friday morning for $90?' } }), 'negotiate_offer');
  assert.ok(sc(neg).offer.total <= sc(clean).offers[1].total);
  const conf = check(await c.callTool({ name: 'confirm_plan', arguments: { plan_id: sc(plan).plan.id, confirmation_token: sc(plan).confirmation_token, user_confirmation: 'Yes, book it' } }), 'confirm_plan');
  const orders = sc(conf).receipt.orders;
  assert.equal(orders.length, 3);
  const cleaning = orders.find((o) => /BrightNest/.test(o.merchant));
  check(await c.callTool({ name: 'change_order', arguments: { order_id: cleaning.id, change: { field: 'date', value: 'Saturday' } } }), 'change_order');
  check(await c.callTool({ name: 'close_order', arguments: { order_id: cleaning.id, action: 'capture', confirmation_token: cleaning.close_token } }), 'close_order');
  const st = check(await c.callTool({ name: 'get_household_status', arguments: {} }), 'get_household_status');
  assert.equal(sc(st).open_orders.length, 2);
  assert.equal(sc(st).preferences.length, 1);
  await c.close();
});

test('tool results carry the Alexa+ invoking/invoked convention and ids for the assistant in content[1]', async () => {
  const c = await client(srv.mcpUrl);
  const r = await c.callTool({ name: 'find_home_services', arguments: { need: 'fix a leak', category: 'plumbing', when: 'Monday morning' } });
  assert.equal(r._meta.ui.invoking, 'Asking local pros…');
  assert.match(r.content[1].text, /^Assistant data \(do not read aloud\): /);
  const ids = JSON.parse(r.content[1].text.replace(/^[^{]*/, ''));
  assert.match(ids.offers[0].offer_id, /^off_/);
  await c.close();
});

test('errors are tool execution errors with one next step', async () => {
  const c = await client(srv.mcpUrl);
  const r = await c.callTool({ name: 'find_home_services', arguments: { need: 'deep clean', category: 'cleaning', when: 'Sunday', max_price: 20 } });
  assert.equal(r.isError, true);
  assert.match(text(r), /Next step:/);
  await c.close();
});
