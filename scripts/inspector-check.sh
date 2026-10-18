#!/usr/bin/env bash
# Runs the official MCP Inspector (CLI mode) against the Mandat MCP server and records every answer.
#   sh scripts/inspector-check.sh                 # starts a local server (memory store, simulated providers)
#   MCP_URL=https://<function-url>/mcp sh scripts/inspector-check.sh   # any deployed server
# Output: docs/inspector/*.json (raw answers) and a pass/fail line per check on stdout.
# Needs: node >= 22, npx (downloads @modelcontextprotocol/inspector once), jq. No AWS call, no paid API.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${INSPECTOR_OUT:-$ROOT/docs/inspector}"
mkdir -p "$OUT"
INSPECTOR="${INSPECTOR:-@modelcontextprotocol/inspector@2.11.0}"
HH="inspector-$(date +%s)"
PASS=0; FAIL=0
SERVER_PID=""

if [ -z "${MCP_URL:-}" ]; then
  PORT="${PORT:-8797}"
  (cd "$ROOT" && MANDAT_AUTH=required MANDAT_STORE=memory MANDAT_MODEL=simulated MANDAT_PAYPAL=offline MANDAT_BRAIN=none PORT="$PORT" exec node src/server.mjs >/dev/null 2>&1) & # exec: the trap then stops node itself
  SERVER_PID=$!
  trap '[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null' EXIT
  MCP_URL="http://127.0.0.1:$PORT/mcp"
  for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 0.25; done
fi

BASE="${MCP_URL%/mcp}"
# Account linking (OAuth 2.1 + PKCE S256), like Alexa: link a fresh empty household, then every call carries its token.
AT="$(cd "$ROOT" && node scripts/link-demo.mjs "$BASE" new --token)"
insp() { npx -y "$INSPECTOR" --cli "$MCP_URL" --transport http --header "Authorization: Bearer $AT" --format json -q "$@"; }
check() { # name, condition (shell test result 0/1), detail
  local line
  if [ "$2" = 0 ]; then PASS=$((PASS + 1)); line="PASS  $1"; else FAIL=$((FAIL + 1)); line="FAIL  $1  ${3:-}"; fi
  echo "$line" | tee -a "$OUT/summary.txt"
}
call() { # file, tool, json args
  insp --method tools/call --tool-name "$2" --tool-args-json "$3" > "$OUT/$1.json" 2>"$OUT/$1.err"
}
ok_result() { jq -e '.result and (.result.isError | not) and (.result.content[0].text | length > 0) and .result.structuredContent and .result._meta.ui.resourceUri' "$OUT/$1.json" >/dev/null; echo $?; }

echo "MCP Inspector $INSPECTOR -> $MCP_URL (account link: a fresh empty household, OAuth 2.1 + PKCE), $(date -u +%Y-%m-%dT%H:%MZ)" | tee "$OUT/summary.txt"

insp --method initialize > "$OUT/01-initialize.json" 2>&1
check "initialize: protocol 2025-11-25" "$(jq -e '.result.protocolVersion == "2025-11-25"' "$OUT/01-initialize.json" >/dev/null; echo $?)"
check "initialize: MCP Apps extension io.modelcontextprotocol/ui announced" "$(jq -e '.result.capabilities.extensions["io.modelcontextprotocol/ui"]' "$OUT/01-initialize.json" >/dev/null; echo $?)"
check "initialize: listChanged false (stateless, fixed lists)" "$(jq -e '.result.capabilities.tools.listChanged == false and .result.capabilities.resources.listChanged == false' "$OUT/01-initialize.json" >/dev/null; echo $?)"

insp --method tools/list > "$OUT/02-tools-list.json" 2>&1
check "tools/list: 23 tools (21 intents + 2 app-only)" "$(jq -e '.result.tools | length == 23' "$OUT/02-tools-list.json" >/dev/null; echo $?)"
check "tools/list: every tool has annotations and _meta.ui.resourceUri" "$(jq -e '[.result.tools[] | (.annotations != null and (._meta.ui.resourceUri | startswith("ui://")))] | all' "$OUT/02-tools-list.json" >/dev/null; echo $?)"
npx -y "$INSPECTOR" --cli "$MCP_URL" --transport http --method tools/list --strict -q >/dev/null 2>"$OUT/03-strict.txt"
check "tools/list --strict: no schema portability error" "$?" "$(head -c 300 "$OUT/03-strict.txt")"
npx -y "$INSPECTOR" --cli "$MCP_URL" --transport http --method tools/list --app-info --advertise-apps -q > "$OUT/04-app-info.ndjson" 2>&1
check "--app-info: 23/23 tools have an MCP App (text/html;profile=mcp-app)" "$( [ "$(grep -c '"resourceMimeType":"text/html;profile=mcp-app"' "$OUT/04-app-info.ndjson")" = 23 ]; echo $?)"
check "--app-info: refresh_card is app-only (visibility [\"app\"])" "$(grep '"toolName":"refresh_card"' "$OUT/04-app-info.ndjson" | grep -q '"visibility":\["app"\]'; echo $?)"

insp --method resources/list > "$OUT/05-resources-list.json" 2>&1
check "resources/list: 7 ui:// cards with mimeType text/html;profile=mcp-app" "$(jq -e '[.result.resources[] | select(.mimeType == "text/html;profile=mcp-app" and (.uri | startswith("ui://mandat/")))] | length == 7' "$OUT/05-resources-list.json" >/dev/null; echo $?)"
URI="$(jq -r '.result.resources[] | select(.uri | contains("/plan-")) | .uri' "$OUT/05-resources-list.json")"
insp --method resources/read --uri "$URI" > "$OUT/06-resources-read-plan.json" 2>&1
check "resources/read: plan card is self-contained HTML with _meta.ui.csp" "$(jq -e '.result.contents[0].mimeType == "text/html;profile=mcp-app" and (.result.contents[0].text | contains("ui/initialize")) and (.result.contents[0]._meta.ui.csp != null)' "$OUT/06-resources-read-plan.json" >/dev/null; echo $?)"

# Story 1 through the Inspector, one tool call at a time (ids come from the previous answers)
call 10-set_spending_mandate set_spending_mandate '{"budget":400,"period":"once","purpose":"In-laws visit","auto_approve_under":0}'
check "tools/call set_spending_mandate" "$(ok_result 10-set_spending_mandate)"
MID="$(jq -r '.result.structuredContent.mandate.id' "$OUT/10-set_spending_mandate.json")"
call 11-remember_preference remember_preference '{"subject":"Max (dog)","fact":"allergic to chicken"}'
check "tools/call remember_preference" "$(ok_result 11-remember_preference)"
call 12-find_home_services find_home_services '{"need":"deep clean of the guest room","category":"cleaning","when":"Friday morning"}'
check "tools/call find_home_services (3 agents, verified cards)" "$(jq -e '.result.structuredContent.asked == 3 and ([.result.structuredContent.offers[].card_verified] | all)' "$OUT/12-find_home_services.json" >/dev/null; echo $?)"
CLEAN="$(jq -r '.result.structuredContent.offers[0].id' "$OUT/12-find_home_services.json")"
call 13-negotiate_offer negotiate_offer "{\"offer_id\":\"$CLEAN\",\"ask\":\"Friday morning for \$70?\"}"
check "tools/call negotiate_offer (never below the floor)" "$(jq -e '.result.structuredContent.offers[0].total >= 85' "$OUT/13-negotiate_offer.json" >/dev/null; echo $?)"
call 14-find_products find_products '{"query":"queen bedding sheets for the guest room"}'
check "tools/call find_products" "$(ok_result 14-find_products)"
SHEETS="$(jq -r '.result.structuredContent.offers[0].id' "$OUT/14-find_products.json")"
call 15-propose_plan propose_plan "{\"item_ids\":[\"$CLEAN\",\"$SHEETS\"],\"mandate_id\":\"$MID\"}"
check "tools/call propose_plan (needs a yes, token issued, no money moved)" "$(jq -e '.result.structuredContent.needs_user_yes == true and (.result.structuredContent.confirmation_token | length > 8)' "$OUT/15-propose_plan.json" >/dev/null; echo $?)"
PLAN="$(jq -r '.result.structuredContent.plan.id' "$OUT/15-propose_plan.json")"
TOKEN="$(jq -r '.result.structuredContent.confirmation_token' "$OUT/15-propose_plan.json")"
call 16-confirm_plan-no-yes confirm_plan "{\"plan_id\":\"$PLAN\",\"confirmation_token\":\"$TOKEN\"}"
check "confirm_plan without the user's yes is refused (isError + next step)" "$(jq -e '.result.isError == true and (.result.content[0].text | contains("Next step"))' "$OUT/16-confirm_plan-no-yes.json" >/dev/null; echo $?)"
call 17-confirm_plan-wrong-token confirm_plan "{\"plan_id\":\"$PLAN\",\"confirmation_token\":\"0000000000000000\",\"user_confirmation\":\"Yes, book it\"}"
check "confirm_plan with a wrong token is refused" "$(jq -e '.result.isError == true' "$OUT/17-confirm_plan-wrong-token.json" >/dev/null; echo $?)"
call 18-confirm_plan confirm_plan "{\"plan_id\":\"$PLAN\",\"confirmation_token\":\"$TOKEN\",\"user_confirmation\":\"Yes, book it\"}"
check "tools/call confirm_plan (holds placed)" "$(jq -e '[.result.structuredContent.receipt.orders[].state] | all(. == "held")' "$OUT/18-confirm_plan.json" >/dev/null; echo $?)"
call 19-confirm_plan-retry confirm_plan "{\"plan_id\":\"$PLAN\",\"confirmation_token\":\"$TOKEN\",\"user_confirmation\":\"Yes, book it\"}"
check "confirm_plan retry is idempotent (same orders)" "$( [ "$(jq -c '[.result.structuredContent.receipt.orders[].id]' "$OUT/18-confirm_plan.json")" = "$(jq -c '[.result.structuredContent.receipt.orders[].id]' "$OUT/19-confirm_plan-retry.json")" ]; echo $?)"
ORDER="$(jq -r '.result.structuredContent.receipt.orders[] | select(.kind == "service") | .id' "$OUT/18-confirm_plan.json")"
CTOKEN="$(jq -r ".result.structuredContent.receipt.orders[] | select(.id == \"$ORDER\") | .close_token" "$OUT/18-confirm_plan.json")"
call 20-change_order change_order "{\"order_id\":\"$ORDER\",\"change\":{\"field\":\"date\",\"value\":\"Saturday\"}}"
check "tools/call change_order (merchant agent answers)" "$(ok_result 20-change_order)"
call 21-close_order close_order "{\"order_id\":\"$ORDER\",\"action\":\"capture\",\"amount\":80,\"confirmation_token\":\"$CTOKEN\"}"
check "tools/call close_order partial capture (rest released)" "$(jq -e '[.result.structuredContent.receipt.orders[0].timeline[].state] | index("released") != null' "$OUT/21-close_order.json" >/dev/null; echo $?)"
call 22-get_household_status get_household_status '{}'
check "tools/call get_household_status" "$(ok_result 22-get_household_status)"
call 23-bad-input find_home_services '{"need":"x","category":"astrology","when":"now"}'
check "invalid input is rejected with an error, no crash" "$(jq -e '.result.isError == true or .error != null' "$OUT/23-bad-input.json" >/dev/null; echo $?)"

npx -y "$INSPECTOR" --cli "$MCP_URL" --transport http --header "Origin: https://evil.example" --method tools/list --format json -q > "$OUT/24-foreign-origin.json" 2>&1
check "foreign Origin is refused (403, MCP 2025-11-25 transport rule)" "$(grep -q '403\|Forbidden' "$OUT/24-foreign-origin.json"; echo $?)"
npx -y "$INSPECTOR" --cli "$MCP_URL" --transport http --protocol-era auto --method tools/list --format json -q > "$OUT/25-era-auto.json" 2>&1
check "--protocol-era auto falls back to 2025-11-25 and lists tools" "$(jq -e '.result.tools | length == 23' "$OUT/25-era-auto.json" >/dev/null; echo $?)"

# ---------- account linking (Amazon: OAuth 2.1, PKCE S256, 401 on a tool call without a token) ----------
curl -s -D "$OUT/30-no-token.headers" -o "$OUT/30-no-token.json" "$MCP_URL" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2025-11-25' \
  -d '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"get_household_status","arguments":{}}}'
check "tools/call without a token: HTTP 401 + WWW-Authenticate resource_metadata" "$(grep -qi '^HTTP/[0-9.]* 401' "$OUT/30-no-token.headers" && grep -qi 'www-authenticate: Bearer .*resource_metadata=' "$OUT/30-no-token.headers"; echo $?)"
curl -s "$BASE/.well-known/oauth-protected-resource" > "$OUT/31-protected-resource.json"
check "RFC 9728 metadata: resource = MCP URL, first authorization server = this server" "$(jq -e --arg r "$MCP_URL" --arg b "$BASE" '.resource == $r and .authorization_servers[0] == $b' "$OUT/31-protected-resource.json" >/dev/null; echo $?)"
curl -s "$BASE/.well-known/oauth-authorization-server" > "$OUT/32-authorization-server.json"
check "RFC 8414 metadata: code only, S256 only, refresh tokens, no registration endpoint" "$(jq -e '.response_types_supported == ["code"] and .code_challenge_methods_supported == ["S256"] and (.grant_types_supported | index("refresh_token")) and (has("registration_endpoint") | not)' "$OUT/32-authorization-server.json" >/dev/null; echo $?)"
call 33-get_settings get_settings '{"first_run":true}'
check "tools/call get_settings (first-run settings card)" "$(ok_result 33-get_settings)"
call 34-update_settings update_settings '{"weekly_budget":200,"autonomy":"ask"}'
check "tools/call update_settings (Ask me first, \$200 a week)" "$(jq -e '.result.structuredContent.settings.autonomy == "ask" and .result.structuredContent.settings.weekly_budget == 200' "$OUT/34-update_settings.json" >/dev/null; echo $?)"
call 35-pause_spending pause_spending '{}'
check "tools/call pause_spending (emergency stop)" "$(jq -e '.result.structuredContent.settings.paused == true' "$OUT/35-pause_spending.json" >/dev/null; echo $?)"
call 36-resume_spending resume_spending '{}'
check "tools/call resume_spending" "$(ok_result 36-resume_spending)"

rm -f "$OUT"/*.err
printf -- '----\n%s passed, %s failed\n' "$PASS" "$FAIL" | tee -a "$OUT/summary.txt"
[ "$FAIL" = 0 ]
