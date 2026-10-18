#!/bin/sh
# Builds dist/mandat-alexa-lambda.zip for AWS Lambda (nodejs22.x, arm64, handler src/lambda.handler).
# Local only: installs production dependencies into a clean staging folder and zips it. No AWS call.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/dist/stage"
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp -R "$ROOT/src" "$ROOT/simulator" "$ROOT/skill" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/LICENSE" "$STAGE/"
mkdir -p "$STAGE/orchestrator"
cp "$ROOT/orchestrator/brain.mjs" "$ROOT/orchestrator/scripted-model.mjs" "$ROOT/orchestrator/package.json" "$ROOT/orchestrator/package-lock.json" "$STAGE/orchestrator/"
# Never ship local state or secrets: the git-ignored data folders (store.json, .network-secret) and any .env.
find "$STAGE" \( -name data -type d -o -name '.env' -o -name '.env.*' -o -name '.DS_Store' \) -prune -exec rm -rf {} +
(cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
(cd "$STAGE/orchestrator" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
rm -f "$ROOT/dist/mandat-alexa-lambda.zip"
(cd "$STAGE" && zip -qr "$ROOT/dist/mandat-alexa-lambda.zip" . -x '*.map' -x '*/test/*')
if unzip -l "$ROOT/dist/mandat-alexa-lambda.zip" | grep -E '(\.network-secret|store\.json|\.env)$' >/dev/null; then echo "refusing: secret or state file in the zip" >&2; exit 1; fi
ls -lh "$ROOT/dist/mandat-alexa-lambda.zip"
