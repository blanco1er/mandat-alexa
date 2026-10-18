// The one-command AWS deploy script, validated without AWS: a fake `aws` on PATH records every call and answers
// like an empty account. Checks the order of operations, idempotent re-runs, the IAM policy, the Lambda settings,
// and that no secret value is ever printed. No network, no credentials, no AWS call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'deploy-aws.sh');

function fakeAws(dir, { existing = false } = {}) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  // Answers: an empty account (every describe/get fails) or one where everything already exists.
  fs.writeFileSync(path.join(bin, 'aws'), `#!/usr/bin/env bash
STATE="${dir}"
echo "$*" >> "$STATE/calls.log"
for a in "$@"; do case "$a" in file://*) f="\${a#file://}"; cp "$f" "$STATE/$(basename "$f")";; esac; done
args=" $* "
case "$args" in
  *" sts get-caller-identity "*) echo '{"Account":"111122223333"}';;
  *" add-permission help "*) echo "  --invoked-via-function-url | --no-invoked-via-function-url";;
  *" dynamodb describe-table "*|*" iam get-role "*|*" lambda get-function --function-name "*)
    ${existing ? 'echo "{}"' : 'echo "ResourceNotFoundException" >&2; exit 254'};;
  *" get-function-url-config "*)
    if ${existing ? 'true' : '[ -f "$STATE/url" ]'}; then echo '{"FunctionUrl":"https://abc123.lambda-url.us-east-1.on.aws/"}'; else touch "$STATE/url"; echo "ResourceNotFoundException" >&2; exit 254; fi;;
  *" get-function-configuration "*) ${existing ? `echo '{"Environment":{"Variables":{"MANDAT_NETWORK_SECRET":"${'k'.repeat(64)}"}}}'` : `echo '{}'`};;
  *" add-permission "*) ${existing ? 'echo "An error occurred (ResourceConflictException)" >&2; exit 254' : 'echo "{}"'};;
  *) echo '{}';;
esac
`, { mode: 0o755 });
  return bin;
}

function run(env, dir) {
  const zip = path.join(dir, 'fake.zip');
  if (!fs.existsSync(zip)) { fs.writeFileSync(path.join(dir, 'index.txt'), 'x'); execFileSync('zip', ['-q', zip, 'index.txt'], { cwd: dir }); }
  return spawnSync('bash', [SCRIPT], { env: { PATH: process.env.PATH, HOME: os.tmpdir(), MANDAT_ZIP: zip, SKIP_SMOKE: '1', IAM_WAIT: '0', ...env }, encoding: 'utf8' });
}

test('deploy: empty account -> table, role, function, URL, permissions, env, in that order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandat-deploy-'));
  const bin = fakeAws(dir);
  const secret = 'sandbox-secret-value-' + Date.now();
  const r = run({ PATH: `${bin}:${process.env.PATH}`, PAYPAL_CLIENT_ID: 'sandbox-client-id', PAYPAL_CLIENT_SECRET: secret }, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(secret), 'a secret value was printed');
  const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n');
  assert.ok(calls.every((c) => c.startsWith('--region us-east-1 --output json') || / help$/.test(c)), 'every call is pinned to the region');
  const idx = (re) => calls.findIndex((c) => re.test(c));
  const order = [/dynamodb create-table --table-name mandat/, /iam create-role --role-name mandat-alexa-role/, /iam put-role-policy/, /lambda create-function --function-name mandat-alexa --runtime nodejs22\.x --architectures arm64 --handler src\/lambda\.handler/, /create-function-url-config .*--auth-type NONE --invoke-mode BUFFERED/, /add-permission .*lambda:InvokeFunctionUrl .*--function-url-auth-type NONE/, /add-permission .*lambda:InvokeFunction .*--invoked-via-function-url/, /update-function-configuration .*--environment file:\/\//];
  const at = order.map(idx);
  assert.ok(at.every((i) => i >= 0), `missing call: ${order[at.indexOf(-1)]}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'calls out of order');

  const policy = JSON.parse(fs.readFileSync(path.join(dir, 'policy.json'), 'utf8'));
  assert.deepEqual(policy.Statement.map((s) => s.Sid), ['Table', 'Models', 'Voice']);
  assert.equal(policy.Statement[0].Resource, 'arn:aws:dynamodb:us-east-1:111122223333:table/mandat');
  assert.ok(!JSON.stringify(policy).includes('"dynamodb:*"') && !JSON.stringify(policy).includes('"bedrock:*"'), 'least privilege');
  const models = policy.Statement[1].Resource;
  assert.ok(models.includes('arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.amazon.nova-2-lite-v1:0'), 'Nova 2 Lite brain (US profile)');
  assert.ok(models.includes('arn:aws:bedrock:us-east-1:111122223333:inference-profile/global.amazon.nova-2-lite-v1:0'), 'global fallback profile');
  assert.ok(models.includes('arn:aws:bedrock:*::foundation-model/amazon.nova-2-lite-v1:0*'));
  assert.ok(models.includes('arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0*'), 'Nova Lite merchants');
  assert.ok(!models.some((m) => /anthropic/.test(m)), 'no third-party model by default');
  assert.ok(policy.Statement[0].Action.includes('dynamodb:UpdateItem'), 'shared LLM spend counter');
  assert.equal(new Set(models).size, models.length, 'no duplicate ARN');

  const env = JSON.parse(fs.readFileSync(path.join(dir, 'env.json'), 'utf8')).Variables;
  assert.equal(env.MANDAT_STORE, 'dynamodb');
  assert.equal(env.MANDAT_PUBLIC_URL, 'https://abc123.lambda-url.us-east-1.on.aws');
  assert.equal(env.MANDAT_ALLOWED_ORIGINS, env.MANDAT_PUBLIC_URL);
  assert.match(env.MANDAT_NETWORK_SECRET, /^[0-9a-f]{64}$/);
  assert.equal(env.PAYPAL_CLIENT_SECRET, secret);
  assert.equal(env.MANDAT_PAYPAL, undefined, 'sandbox keys given: payments are not forced offline');
  assert.equal(env.MANDAT_MODEL, 'simulated');
  assert.equal(env.MANDAT_LLM_BUDGET_USD, '15', 'hard LLM ceiling on by default');
  assert.equal(env.MANDAT_BEDROCK_BRAIN_ID, 'us.amazon.nova-2-lite-v1:0');
  assert.ok(!('AWS_REGION' in env), 'AWS_REGION is reserved by Lambda');
});

test('deploy: a second run updates in place and keeps the network secret', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandat-deploy-'));
  const bin = fakeAws(dir, { existing: true });
  const r = run({ PATH: `${bin}:${process.env.PATH}`, DEPLOY_STAGE: 'bedrock' }, dir);
  assert.equal(r.status, 0, r.stderr);
  const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8');
  assert.doesNotMatch(calls, /create-table|create-role|create-function |create-function-url-config/);
  assert.match(calls, /update-function-code --function-name mandat-alexa/);
  const env = JSON.parse(fs.readFileSync(path.join(dir, 'env.json'), 'utf8')).Variables;
  assert.equal(env.MANDAT_NETWORK_SECRET, 'k'.repeat(64));
  assert.deepEqual([env.MANDAT_MODEL, env.MANDAT_BRAIN, env.MANDAT_BRAIN_MODEL, env.MANDAT_TTS, env.MANDAT_PAYPAL], ['bedrock', 'strands', 'bedrock', 'polly', 'offline']);
});

test('deploy: an account with a 10-execution Lambda limit skips reserved concurrency instead of failing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandat-deploy-'));
  const bin = fakeAws(dir);
  const aws = path.join(bin, 'aws');
  fs.writeFileSync(aws, fs.readFileSync(aws, 'utf8').replace('case "$args" in', 'case "$args" in\n  *" get-account-settings "*) echo \'{"AccountLimit":{"ConcurrentExecutions":10}}\';;'));
  const r = run({ PATH: `${bin}:${process.env.PATH}` }, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'calls.log'), 'utf8'), /put-function-concurrency/);
  assert.match(r.stdout, /reserved concurrency skipped/);
});

test('deploy: DRY_RUN prints the plan and calls nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandat-deploy-'));
  const bin = fakeAws(dir);
  const r = run({ PATH: `${bin}:${process.env.PATH}`, DRY_RUN: '1' }, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(dir, 'calls.log')), 'aws was called during a dry run');
  assert.match(r.stderr, /\[dry-run\] aws lambda create-function .*nodejs22\.x/);
  assert.match(r.stderr, /\[dry-run\] aws lambda add-permission .*--invoked-via-function-url/);
});

test('deploy: refuses a zip that carries local state or secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandat-deploy-'));
  fs.mkdirSync(path.join(dir, 'src/core/data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/core/data/.network-secret'), 'x');
  execFileSync('zip', ['-qr', path.join(dir, 'bad.zip'), 'src'], { cwd: dir });
  const r = run({ PATH: `${fakeAws(dir)}:${process.env.PATH}`, MANDAT_ZIP: path.join(dir, 'bad.zip') }, dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing to ship/);
});
