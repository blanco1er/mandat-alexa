#!/bin/zsh
# Stores the PayPal SANDBOX keys in the Lambda function's configuration without ever printing them.
# The owner pastes both values (hidden input). Nothing is written to the repository.
# Usage: AWS_PROFILE=mandat zsh scripts/set-paypal-sandbox.sh
set -euo pipefail
FUNCTION="${MANDAT_FUNCTION:-mandat-alexa}"
REGION="${AWS_REGION:-us-east-1}"
PROFILE="${AWS_PROFILE:-mandat}"

echo "PayPal SANDBOX keys (developer.paypal.com > Apps & Credentials > Sandbox)."
printf "Paste the Client ID, then Enter (nothing is shown): "; read -rs CID; echo
printf "Paste the Secret, then Enter (nothing is shown): "; read -rs SEC; echo
[ -n "$CID" ] && [ -n "$SEC" ] || { echo "Empty value: nothing was changed."; exit 1; }

# Checks that these are working sandbox keys (OAuth token request), without printing anything.
CODE=$(curl -s -o /dev/null -w "%{http_code}" -u "$CID:$SEC" -d "grant_type=client_credentials" https://api-m.sandbox.paypal.com/v1/oauth2/token)
[ "$CODE" = 200 ] || { echo "PayPal sandbox refused these keys (HTTP $CODE). Check that they come from the Sandbox tab. Nothing was changed."; exit 1; }
echo "Sandbox keys are valid."

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; umask 077
aws lambda get-function-configuration --function-name "$FUNCTION" --region "$REGION" --profile "$PROFILE" \
  --query 'Environment.Variables' --output json > "$TMP/cur.json"
CID="$CID" SEC="$SEC" node -e '
  const fs = require("fs");
  const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8") || "{}") || {};
  v.PAYPAL_CLIENT_ID = process.env.CID; v.PAYPAL_CLIENT_SECRET = process.env.SEC; delete v.MANDAT_PAYPAL; // "offline" forced simulated payments
  fs.writeFileSync(process.argv[2], JSON.stringify({ Variables: v }));
' "$TMP/cur.json" "$TMP/env.json"
aws lambda update-function-configuration --function-name "$FUNCTION" --region "$REGION" --profile "$PROFILE" \
  --environment "file://$TMP/env.json" >/dev/null
aws lambda wait function-updated-v2 --function-name "$FUNCTION" --region "$REGION" --profile "$PROFILE"
unset CID SEC
echo "Done: the PayPal sandbox keys are stored in the function configuration (never printed)."
