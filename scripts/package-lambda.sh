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
(cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
(cd "$STAGE/orchestrator" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
rm -f "$ROOT/dist/mandat-alexa-lambda.zip"
(cd "$STAGE" && zip -qr "$ROOT/dist/mandat-alexa-lambda.zip" . -x '*.map' -x '*/test/*')
ls -lh "$ROOT/dist/mandat-alexa-lambda.zip"
