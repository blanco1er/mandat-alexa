#!/bin/zsh
# One-time owner step: link ONE PayPal sandbox buyer to the public demo, so judges never need a PayPal account.
# Prerequisites: sandbox keys already in the Lambda (scripts/set-paypal-sandbox.sh) and, in developer.paypal.com >
# Apps & Credentials > (sandbox app) > Features, "Save payment methods" (Vault) turned on.
# Usage: AWS_PROFILE=mandat zsh scripts/link-paypal-demo-buyer.sh
# Prints a PayPal approval link (not a secret). Open it, log in with the SANDBOX PERSONAL account shown in
# developer.paypal.com > Sandbox accounts (…@personal.example.com), approve. No key or token is ever printed.
set -euo pipefail
FUNCTION="${MANDAT_FUNCTION:-mandat-alexa}"; REGION="${AWS_REGION:-us-east-1}"; PROFILE="${AWS_PROFILE:-mandat}"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
invoke() { aws lambda invoke --function-name "$FUNCTION" --region "$REGION" --profile "$PROFILE" --cli-binary-format raw-in-base64-out --payload "{\"mandat_admin\":\"$1\"}" "$TMP/out.json" >/dev/null && cat "$TMP/out.json"; }
STATUS=$(invoke demo-buyer-status)
if echo "$STATUS" | grep -q '"linked":true'; then echo "A demo buyer is already linked: $(echo "$STATUS" | sed -E 's/.*"payer":"([^"]*)".*/\1/')."; printf "Replace it? (y/N) "; read -r A; [ "$A" = y ] || exit 0; fi
OUT=$(invoke link-demo-buyer)
URL=$(echo "$OUT" | sed -nE 's/.*"approveUrl":"([^"]+)".*/\1/p')
[ -n "$URL" ] || { echo "Failed: $OUT"; exit 1; }
echo "1. Open this link in a browser:"; echo "   $URL"
echo "2. Log in with the SANDBOX personal account (developer.paypal.com > Testing Tools > Sandbox accounts), then approve."
echo "Waiting for the approval (10 minutes at most)…"
for i in $(seq 1 120); do sleep 5; if invoke demo-buyer-status | grep -q '"linked":true'; then echo "Done: the demo buyer is linked. New demo budgets now place real PayPal sandbox holds (test money)."; exit 0; fi; done
echo "No approval yet. Run this script again once you have approved in PayPal."; exit 1
