#!/usr/bin/env bash
# One command from an empty AWS account to a public Mandat for Alexa+ endpoint:
#   DynamoDB table -> IAM role (least privilege) -> Lambda nodejs22.x arm64 -> Function URL -> env -> smoke test.
# Idempotent: run it again to ship new code or settings (existing resources are updated, never duplicated).
#
#   DRY_RUN=1 npm run deploy:aws                     # prints every AWS call, calls nothing (no credentials needed)
#   AWS_PROFILE=mandat npm run deploy:aws            # tier A: simulated brain + merchants, DynamoDB, PayPal offline
#   AWS_PROFILE=mandat DEPLOY_STAGE=bedrock npm run deploy:aws   # Strands + Amazon Nova brain, Nova merchants, Polly
# (npm run deploy:aws = bash scripts/deploy-aws.sh)
#
# Settings are read from environment variables, by NAME only. Nothing secret lives in this file or in git:
#   AWS_PROFILE, AWS_REGION (us-east-1)            which account / region (credentials come from the AWS CLI)
#   MANDAT_FUNCTION (mandat-alexa), MANDAT_TABLE (mandat), MANDAT_ROLE (mandat-alexa-role)
#   DEPLOY_STAGE (simulated | bedrock)             simulated first, bedrock once model access is granted
#   MANDAT_BEDROCK_BRAIN_ID (us.amazon.nova-2-lite-v1:0), MANDAT_BRAIN_FALLBACK_ID (global.amazon.nova-2-lite-v1:0)
#   MANDAT_MERCHANT_MODEL (us.amazon.nova-lite-v1:0), MANDAT_MERCHANT_FALLBACK_ID (global.amazon.nova-2-lite-v1:0)
#                                                  Amazon Nova by default; Claude (us.anthropic.*) works where enabled
#   MANDAT_POLLY_VOICE (Danielle), MANDAT_LLM_BUDGET_USD (15, hard ceiling shared by every container)
#   MANDAT_LIMIT_TURNS (60), MANDAT_LIMIT_TTS (120), MANDAT_LIMIT_MCP (600)   per-IP, per-hour demo limits
#   MANDAT_RESERVED_CONCURRENCY (5)                skipped when the account's Lambda limit is too small to reserve
#   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET         sandbox keys, from your shell only; absent = payments stay simulated
#   MANDAT_DEMO_TOKEN                              optional bearer token on /mcp
#   MANDAT_NETWORK_SECRET                          optional; generated once and then kept from the live function
#   MANDAT_ZIP                                     use this zip instead of running `npm run package`
#   IAM_WAIT (12), SKIP_SMOKE (0)                  seconds to let a new role propagate; skip the final curl checks
# Needs: aws CLI v2, jq, zip, node >= 22, curl.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_REGION:-us-east-1}"
FUNCTION="${MANDAT_FUNCTION:-mandat-alexa}"
TABLE="${MANDAT_TABLE:-mandat}"
ROLE="${MANDAT_ROLE:-mandat-alexa-role}"
STAGE="${DEPLOY_STAGE:-simulated}"
BRAIN_ID="${MANDAT_BEDROCK_BRAIN_ID:-us.amazon.nova-2-lite-v1:0}"
BRAIN_FALLBACK="${MANDAT_BRAIN_FALLBACK_ID-global.amazon.nova-2-lite-v1:0}"
MERCHANT_ID="${MANDAT_MERCHANT_MODEL:-us.amazon.nova-lite-v1:0}"
MERCHANT_FALLBACK="${MANDAT_MERCHANT_FALLBACK_ID-global.amazon.nova-2-lite-v1:0}"
CONCURRENCY="${MANDAT_RESERVED_CONCURRENCY:-5}"
TIMEOUT="${MANDAT_TIMEOUT:-90}" # one voice turn = several model calls + nested MCP calls; throttling retries back off
DRY="${DRY_RUN:-0}"
TMP="$(mktemp -d)"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
exec 3>&2 # dry-run lines always reach the terminal, even when a call's own stderr is captured

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'deploy-aws: %s\n' "$*" >&2; exit 1; }
# Every AWS call goes through here: printed in dry-run, executed otherwise. Never prints file contents.
aws_() {
  if [ "$DRY" = 1 ]; then printf '[dry-run] aws %s\n' "$*" >&3; return 0; fi
  aws --region "$REGION" --output json "$@"
}
exists() { [ "$DRY" = 1 ] && return 1; aws --region "$REGION" --output json "$@" >/dev/null 2>&1; }

case "$STAGE" in simulated|bedrock) ;; *) die "DEPLOY_STAGE must be simulated or bedrock (got $STAGE)";; esac
for bin in jq zip node; do command -v "$bin" >/dev/null || die "$bin is required"; done
[ "$DRY" = 1 ] || command -v aws >/dev/null || die "AWS CLI v2 is required (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || die "Node.js 22 or newer is required"

# ---------- 0. who am I ----------
if [ "$DRY" = 1 ]; then ACCOUNT=123456789012; else ACCOUNT="$(aws_ sts get-caller-identity | jq -r .Account)"; fi
[ -n "$ACCOUNT" ] || die "no AWS identity: run 'aws configure sso' (profile in AWS_PROFILE) first"
say "account $ACCOUNT, region $REGION, function $FUNCTION, stage $STAGE$( [ "$DRY" = 1 ] && echo ' (dry run, nothing is called)')"

# ---------- 1. package ----------
ZIP="${MANDAT_ZIP:-$ROOT/dist/mandat-alexa-lambda.zip}"
if [ -z "${MANDAT_ZIP:-}" ]; then say "packaging (npm run package)"; (cd "$ROOT" && sh scripts/package-lambda.sh >/dev/null); fi
[ -f "$ZIP" ] || die "zip not found: $ZIP"
if unzip -l "$ZIP" | grep -E '(\.network-secret|store\.json|/\.env)$' >/dev/null; then die "refusing to ship $ZIP: it holds local state or secrets"; fi

# ---------- 2. DynamoDB (one table, on demand) ----------
if exists dynamodb describe-table --table-name "$TABLE"; then say "table $TABLE exists"; else
  say "creating table $TABLE"
  aws_ dynamodb create-table --table-name "$TABLE" \
    --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
    --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST --tags Key=project,Value=mandat-alexa >/dev/null
  aws_ dynamodb wait table-exists --table-name "$TABLE"
fi
# Live-activity rows carry a "ttl" attribute (epoch seconds): let DynamoDB drop them after a day. Idempotent.
TTL_ON=DISABLED; [ "$DRY" = 1 ] || TTL_ON="$(aws_ dynamodb describe-time-to-live --table-name "$TABLE" | jq -r '.TimeToLiveDescription.TimeToLiveStatus // "DISABLED"')"
if [ "$TTL_ON" = DISABLED ]; then aws_ dynamodb update-time-to-live --table-name "$TABLE" --time-to-live-specification Enabled=true,AttributeName=ttl >/dev/null; fi

# ---------- 3. IAM role, least privilege ----------
cat > "$TMP/trust.json" <<'JSON'
{ "Version": "2012-10-17", "Statement": [ { "Effect": "Allow", "Principal": { "Service": "lambda.amazonaws.com" }, "Action": "sts:AssumeRole" } ] }
JSON
# Inference profiles (us.* geo, global.*) route to several regions: allow each profile and its underlying model in
# every region (a global profile's model ARN has no region, which "*" also matches). Plain model ids: the model only.
MODEL_IDS="$(printf '%s\n' "$BRAIN_ID" "$BRAIN_FALLBACK" "$MERCHANT_ID" "$MERCHANT_FALLBACK" | sed '/^$/d' | sort -u | paste -sd, -)"
jq -n --arg region "$REGION" --arg account "$ACCOUNT" --arg table "$TABLE" --arg ids "$MODEL_IDS" '
  ($ids | split(",")) as $ids |
  [ $ids[] | if test("^(us|eu|apac|global|us-gov|jp|au)\\.") then
      ("arn:aws:bedrock:\($region):\($account):inference-profile/\(.)", "arn:aws:bedrock:*::foundation-model/\(sub("^[a-z-]+\\."; ""))*")
    else "arn:aws:bedrock:*::foundation-model/\(.)*" end ] as $models | {
  Version: "2012-10-17",
  Statement: [
    { Sid: "Table", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:DeleteItem", "dynamodb:UpdateItem"],
      Resource: "arn:aws:dynamodb:\($region):\($account):table/\($table)" },
    { Sid: "Models", Effect: "Allow", Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], Resource: ($models | unique) },
    { Sid: "Voice", Effect: "Allow", Action: "polly:SynthesizeSpeech", Resource: "*" }
  ] }' > "$TMP/policy.json"
NEW_ROLE=0
if exists iam get-role --role-name "$ROLE"; then say "role $ROLE exists"; else
  say "creating role $ROLE"
  aws_ iam create-role --role-name "$ROLE" --assume-role-policy-document "file://$TMP/trust.json" --tags Key=project,Value=mandat-alexa >/dev/null
  aws_ iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  NEW_ROLE=1
fi
aws_ iam put-role-policy --role-name "$ROLE" --policy-name mandat-least-privilege --policy-document "file://$TMP/policy.json"
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE"
if [ "$NEW_ROLE" = 1 ] && [ "$DRY" != 1 ]; then say "waiting ${IAM_WAIT:-12}s for the new role to propagate"; sleep "${IAM_WAIT:-12}"; fi

# ---------- 4. Lambda function ----------
if exists lambda get-function --function-name "$FUNCTION"; then
  say "updating code of $FUNCTION"
  aws_ lambda update-function-code --function-name "$FUNCTION" --zip-file "fileb://$ZIP" --architectures arm64 >/dev/null
else
  say "creating $FUNCTION (nodejs22.x, arm64, 1024 MB, ${TIMEOUT} s)"
  aws_ lambda create-function --function-name "$FUNCTION" --runtime nodejs22.x --architectures arm64 \
    --handler src/lambda.handler --memory-size 1024 --timeout "$TIMEOUT" --role "$ROLE_ARN" \
    --zip-file "fileb://$ZIP" --tags project=mandat-alexa >/dev/null
  aws_ lambda wait function-active-v2 --function-name "$FUNCTION"
fi
aws_ lambda wait function-updated-v2 --function-name "$FUNCTION"
# Reserved concurrency caps the bill, but Lambda keeps at least min(100, account limit) unreserved: a new account
# (limit 10) cannot reserve anything. Then the per-IP limits and the LLM budget are the caps.
LIMIT=1000; [ "$DRY" = 1 ] || LIMIT="$(aws_ lambda get-account-settings | jq -r '.AccountLimit.ConcurrentExecutions // 1000')"
MIN_FREE=$(( LIMIT < 100 ? LIMIT : 100 ))
if [ $(( LIMIT - CONCURRENCY )) -ge "$MIN_FREE" ]; then
  aws_ lambda put-function-concurrency --function-name "$FUNCTION" --reserved-concurrent-executions "$CONCURRENCY" >/dev/null
else
  say "account Lambda limit is $LIMIT: reserved concurrency skipped (per-IP limits + LLM budget cap the demo)"
fi

# ---------- 5. Function URL (public, buffered: JSON responses, no SSE) ----------
if exists lambda get-function-url-config --function-name "$FUNCTION"; then say "function URL exists"; else
  say "creating the function URL"
  aws_ lambda create-function-url-config --function-name "$FUNCTION" --auth-type NONE --invoke-mode BUFFERED >/dev/null
fi
# Public URLs need lambda:InvokeFunctionUrl, and (functions created since Oct 2025) lambda:InvokeFunction limited to
# calls that come through the URL. Re-running is harmless: an existing statement answers ResourceConflictException.
aws_ lambda add-permission --function-name "$FUNCTION" --statement-id public-url --action lambda:InvokeFunctionUrl \
  --principal '*' --function-url-auth-type NONE >/dev/null 2>"$TMP/perm1.err" || grep -q ResourceConflict "$TMP/perm1.err" || { cat "$TMP/perm1.err" >&2; exit 1; }
if [ "$DRY" = 1 ] || aws lambda add-permission help 2>/dev/null | grep -q -- '--invoked-via-function-url'; then
  aws_ lambda add-permission --function-name "$FUNCTION" --statement-id public-url-invoke --action lambda:InvokeFunction \
    --principal '*' --invoked-via-function-url >/dev/null 2>"$TMP/perm2.err" || grep -q ResourceConflict "$TMP/perm2.err" || { cat "$TMP/perm2.err" >&2; exit 1; }
else
  say "warning: this AWS CLI has no --invoked-via-function-url; if the URL answers 403, update the AWS CLI and run again"
fi
if [ "$DRY" = 1 ]; then URL="https://example.lambda-url.$REGION.on.aws"; else
  URL="$(aws_ lambda get-function-url-config --function-name "$FUNCTION" | jq -r .FunctionUrl)"; URL="${URL%/}"
fi

# ---------- 6. environment (names from the shell, values never printed) ----------
CURRENT='{}'
[ "$DRY" = 1 ] || CURRENT="$(aws_ lambda get-function-configuration --function-name "$FUNCTION" | jq '.Environment.Variables // {}')"
NETWORK_SECRET="${MANDAT_NETWORK_SECRET:-$(printf '%s' "$CURRENT" | jq -r '.MANDAT_NETWORK_SECRET // empty')}"
[ -n "$NETWORK_SECRET" ] || NETWORK_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
if [ "$STAGE" = bedrock ]; then MODEL=bedrock; BRAIN=strands; BRAIN_MODEL=bedrock; TTS=polly; else MODEL=simulated; BRAIN=simulated; BRAIN_MODEL=scripted; TTS=browser; fi
umask 077
# PayPal sandbox keys: from the shell when given, else KEPT from the live function (set once with
# scripts/set-paypal-sandbox.sh). A redeploy never wipes them; payments are forced offline only when no keys exist.
CURRENT_ENV="$CURRENT" NETWORK_SECRET="$NETWORK_SECRET" MODEL="$MODEL" BRAIN="$BRAIN" BRAIN_MODEL="$BRAIN_MODEL" TTS="$TTS" URL="$URL" TABLE="$TABLE" \
BRAIN_ID="$BRAIN_ID" MERCHANT_ID="$MERCHANT_ID" BRAIN_FALLBACK="$BRAIN_FALLBACK" MERCHANT_FALLBACK="$MERCHANT_FALLBACK" node -e '
  const e = process.env;
  let cur = {}; try { cur = JSON.parse(e.CURRENT_ENV || "{}") || {}; } catch {}
  const ppId = e.PAYPAL_CLIENT_ID || cur.PAYPAL_CLIENT_ID, ppSecret = e.PAYPAL_CLIENT_SECRET || cur.PAYPAL_CLIENT_SECRET;
  const PAYPAL_MODE = ppId && ppSecret ? "" : "offline";
  const v = {
    MANDAT_STORE: "dynamodb", MANDAT_TABLE: e.TABLE, MANDAT_MODEL: e.MODEL, MANDAT_BRAIN: e.BRAIN, MANDAT_BRAIN_MODEL: e.BRAIN_MODEL,
    MANDAT_BEDROCK_BRAIN_ID: e.BRAIN_ID, MANDAT_MERCHANT_MODEL: e.MERCHANT_ID, MANDAT_TTS: e.TTS, MANDAT_POLLY_VOICE: e.MANDAT_POLLY_VOICE || "Danielle",
    MANDAT_BRAIN_FALLBACK_ID: e.BRAIN_FALLBACK, MANDAT_MERCHANT_FALLBACK_ID: e.MERCHANT_FALLBACK, MANDAT_BRAIN_REASONING: e.MANDAT_BRAIN_REASONING,
    MANDAT_LIMIT_TURNS: e.MANDAT_LIMIT_TURNS, MANDAT_LIMIT_TTS: e.MANDAT_LIMIT_TTS, MANDAT_LIMIT_MCP: e.MANDAT_LIMIT_MCP,
    MANDAT_PUBLIC_URL: e.URL, MANDAT_ALLOWED_ORIGINS: e.URL, MANDAT_NETWORK_SECRET: e.NETWORK_SECRET,
    MANDAT_LLM_BUDGET_USD: e.MANDAT_LLM_BUDGET_USD || "15", MANDAT_PAYPAL: PAYPAL_MODE,
    PAYPAL_CLIENT_ID: ppId, PAYPAL_CLIENT_SECRET: ppSecret, MANDAT_DEMO_TOKEN: e.MANDAT_DEMO_TOKEN || cur.MANDAT_DEMO_TOKEN,
    // account linking (OAuth 2.1 + PKCE): required on the public demo; the real Alexa+ client is optional and kept
    MANDAT_AUTH: e.MANDAT_AUTH || "required",
    MANDAT_OAUTH_CLIENT_ID: e.MANDAT_OAUTH_CLIENT_ID || cur.MANDAT_OAUTH_CLIENT_ID, MANDAT_OAUTH_CLIENT_SECRET: e.MANDAT_OAUTH_CLIENT_SECRET || cur.MANDAT_OAUTH_CLIENT_SECRET,
    MANDAT_OAUTH_REDIRECT_URIS: e.MANDAT_OAUTH_REDIRECT_URIS || cur.MANDAT_OAUTH_REDIRECT_URIS,
    NODE_OPTIONS: "--enable-source-maps",
  };
  for (const k of Object.keys(v)) if (v[k] === undefined || v[k] === "") delete v[k];
  process.stdout.write(JSON.stringify({ Variables: v }));
' > "$TMP/env.json"
say "setting $(jq -r '.Variables | keys | join(", ")' "$TMP/env.json")"
aws_ lambda update-function-configuration --function-name "$FUNCTION" --timeout "$TIMEOUT" --environment "file://$TMP/env.json" >/dev/null
aws_ lambda wait function-updated-v2 --function-name "$FUNCTION"

# ---------- 7. smoke test ----------
if [ "$DRY" != 1 ] && [ "${SKIP_SMOKE:-0}" != 1 ]; then
  say "smoke test"
  curl -fsS "$URL/healthz" | jq -c . || die "healthz failed"
  AUTH=(); [ -n "${MANDAT_DEMO_TOKEN:-}" ] && AUTH=(-H "authorization: Bearer $MANDAT_DEMO_TOKEN")
  PROTO="$(curl -fsS "$URL/mcp" ${AUTH[@]+"${AUTH[@]}"} -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"deploy-smoke","version":"1"}}}' | jq -r .result.protocolVersion)"
  [ "$PROTO" = "2025-11-25" ] || die "MCP initialize answered '$PROTO'"
  say "MCP initialize over the public URL: $PROTO"
  S256="$(curl -fsS "$URL/.well-known/oauth-authorization-server" | jq -r '.code_challenge_methods_supported | join(",")')"
  [ "$S256" = "S256" ] || die "authorization server metadata answered '$S256' (S256 expected)"
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "$URL/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2025-11-25' -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_household_status","arguments":{}}}')"
  say "account linking: metadata S256, tool call without a token -> HTTP $CODE"
fi

say "done"
echo "  Simulator   $URL/simulator/"
echo "  MCP         $URL/mcp      (Streamable HTTP, 2025-11-25)"
echo "  Inspector   MCP_URL=$URL/mcp npm run inspect"
