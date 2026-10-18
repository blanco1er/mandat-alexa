// Interfaces built for AWS, tested without AWS: DynamoDB commands, Bedrock Converse input, Polly input,
// the Lambda Function URL handler (same router, in-memory store), policy parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers.mjs';
import { commands } from '../src/store/dynamodb.mjs';
import { converseInput, merchantSystemPrompt, BEDROCK_MODELS } from '../src/providers/bedrock.mjs';
import { pollyInput } from '../src/providers/tts.mjs';
import { merchant, parseGuests, parseWhen } from '../src/core/merchants.mjs';
import { classify, wishes } from '../src/brain/policy.mjs';
import { createStore } from '../src/store/index.mjs';

test('DynamoDB: single-table keys and the conditional put used for idempotency', () => {
  assert.deepEqual(commands.get('HOUSEHOLD#a', 'PLAN#p').Key, { PK: 'HOUSEHOLD#a', SK: 'PLAN#p' });
  assert.equal(commands.putIfAbsent('HOUSEHOLD#a', 'IDEMP#p', {}).ConditionExpression, 'attribute_not_exists(PK)');
  assert.match(commands.query('HOUSEHOLD#a', 'ORDER#').KeyConditionExpression, /begins_with\(SK, :p\)/);
  assert.equal(commands.get('x', 'y').TableName, process.env.MANDAT_TABLE || 'mandat');
});

test('local store: putIfAbsent is exclusive and query is prefix-sorted', async () => {
  const s = createStore('memory');
  assert.equal(await s.putIfAbsent('P', 'IDEMP#1', { a: 1 }), true);
  assert.equal(await s.putIfAbsent('P', 'IDEMP#1', { a: 2 }), false);
  await s.put('P', 'ORDER#b', 2); await s.put('P', 'ORDER#a', 1); await s.put('P', 'PLAN#z', 3);
  assert.deepEqual((await s.query('P', 'ORDER#')).map((r) => r.value), [1, 2]);
});

test('Bedrock: Converse input for a merchant agent carries its private terms and the chosen model', () => {
  const m = merchant('m_hearth');
  const input = converseInput({ modelId: BEDROCK_MODELS.merchant, system: merchantSystemPrompt(m), user: 'dinner for six' });
  assert.equal(input.modelId, 'us.amazon.nova-lite-v1:0');
  assert.match(input.system[0].text, /Closed Sunday and Monday/);
  assert.equal(input.messages[0].role, 'user');
  assert.equal(BEDROCK_MODELS.brain, 'us.amazon.nova-2-lite-v1:0', 'Amazon Nova by default (Claude is optional)');
});

test('Polly: neural mp3 request', () => {
  assert.deepEqual(pollyInput('Hello'), { Engine: 'neural', OutputFormat: 'mp3', VoiceId: 'Danielle', Text: 'Hello', TextType: 'text' });
});

test('Lambda Function URL handler answers MCP initialize with 2025-11-25', async () => {
  const { handler } = await import('../src/lambda.mjs');
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lambda-test', version: '1' } } });
  const out = await handler({ rawPath: '/mcp', rawQueryString: '', headers: { host: 'abc.lambda-url.us-east-1.on.aws', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, requestContext: { http: { method: 'POST' } }, body, isBase64Encoded: false });
  assert.equal(out.statusCode, 200);
  assert.equal(JSON.parse(out.body).result.protocolVersion, '2025-11-25');
  const bad = await handler({ rawPath: '/mcp', headers: { host: 'abc.lambda-url.us-east-1.on.aws', origin: 'https://evil.example', 'content-type': 'application/json' }, requestContext: { http: { method: 'POST' } }, body });
  assert.equal(bad.statusCode, 403);
});

test('Echo Show wallpapers: every photo in wallpaper.js exists in both sizes, ≤ 250 KB, served as WebP through the Lambda', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../simulator/wallpaper.js', import.meta.url), 'utf8');
  const names = [...src.matchAll(/name: '([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 4);
  for (const size of [1920, 1280]) for (const n of names) {
    const st = fs.statSync(new URL(`../simulator/wallpapers/${size}/${n}.webp`, import.meta.url));
    assert.ok(st.size <= 250 * 1024, `${size}/${n}.webp is ${st.size} bytes`);
  }
  const { handler } = await import('../src/lambda.mjs');
  const out = await handler({ rawPath: `/simulator/wallpapers/1920/${names[0]}.webp`, rawQueryString: '', headers: { host: 'abc.lambda-url.us-east-1.on.aws' }, requestContext: { http: { method: 'GET' } } });
  assert.equal(out.statusCode, 200);
  assert.equal(out.headers['content-type'], 'image/webp');
  assert.equal(out.isBase64Encoded, true);
  assert.equal(Buffer.from(out.body, 'base64').subarray(8, 12).toString(), 'WEBP');
  assert.match(out.headers['cache-control'], /max-age=86400/);
});

test('policy: intents and wishes from the demo sentences', () => {
  assert.equal(classify('Alexa, my in-laws land Saturday. Get the guest room ready: a cleaner Friday, fresh bedding, and dinner for six at home Saturday. Keep it under $400.'), 'big_plan');
  assert.equal(classify("We're almost out of dog food and coffee."), 'restock');
  assert.equal(classify('Their flight moved to Sunday.'), 'plans_change');
  assert.equal(classify('yes', { pending: { plan_id: 'p' } }), 'confirm');
  assert.deepEqual(wishes('a cleaner Friday, fresh bedding, and dinner for six at home Saturday').map((w) => w.category || w.kind), ['cleaning', 'product', 'catering']);
  assert.equal(parseGuests('dinner for six at home'), 6);
  assert.deepEqual(parseWhen('Saturday 7pm'), { day: 'sat', part: 'evening', hour: 19 });
});

test('en-US voice: merchant times are spoken the American way (Sunday at 7:30 PM, not 19:30)', async () => {
  const { usTime } = await import('../src/core/merchants.mjs');
  assert.equal(usTime('Sunday 19:30'), 'Sunday 7:30 PM');
  assert.equal(usTime('We only have 09:00, 12:30, 18:00.'), 'We only have 9 AM, 12:30 PM, 6 PM.');
  assert.equal(usTime('at 7:30 pm'), 'at 7:30 pm');
});
