#!/bin/zsh
# Turns on real products (Channel3) on the live Lambda without ever printing the key.
# The owner pastes the key himself (hidden input). Nothing is written to the repository.
# Usage: AWS_PROFILE=mandat zsh scripts/set-channel3.sh
set -euo pipefail
FUNCTION="${MANDAT_FUNCTION:-mandat-alexa}"
REGION="${AWS_REGION:-us-east-1}"
PROFILE="${AWS_PROFILE:-mandat}"

echo "Channel3 API key (trychannel3.com, your account > API keys)."
printf "Paste the key, then Enter (nothing is shown): "; read -rs KEY; echo
# Forgive common copy slips: "CHANNEL3_API_KEY=" prefix, quotes, spaces.
KEY="${KEY#CHANNEL3_API_KEY=}"; KEY="${KEY//\"/}"; KEY="${KEY//\'/}"; KEY="${KEY// /}"
[ -n "$KEY" ] || { echo "Empty value: nothing was changed."; exit 1; }
echo "Key received: ${#KEY} characters (not shown)."

# One real search to check the key works, without printing it (Channel3's own error message is shown, never the key).
RESP=$(mktemp); trap 'rm -f "$RESP"' EXIT
CODE=$(curl -s -o "$RESP" -w "%{http_code}" -X POST https://api.trychannel3.com/v1/search \
  -H "x-api-key: $KEY" -H "content-type: application/json" -d '{"query":"queen sheet set","limit":3}')
if [ "$CODE" != 200 ]; then
  echo "Channel3 refused this key (HTTP $CODE). Channel3 says: $(head -c 300 "$RESP" | tr -d '\n')"
  echo "Nothing was changed."; exit 1
fi
echo "Key accepted by Channel3."

rm -f "$RESP"; TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; umask 077
aws lambda get-function-configuration --function-name "$FUNCTION" --region "$REGION" --profile "$PROFILE" \
  --query 'Environment.Variables' --output json > "$TMP/cur.json"
KEY="$KEY" node -e '
  const fs = require("fs");
  const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8") || "{}") || {};
  v.CHANNEL3_API_KEY = process.env.KEY; v.MANDAT_SHOP = "live";
  fs.writeFileSync(process.argv[2], JSON.stringify({ Variables: v }));
' "$TMP/cur.json" "$TMP/env.json"
aws lambda update-function-configuration --function-name "$FUNCTION" --region "$REGION" --profile "$PROFILE" \
  --environment "file://$TMP/env.json" >/dev/null
aws lambda wait function-updated-v2 --function-name "$FUNCTION" --region "$REGION" --profile "$PROFILE"
unset KEY
echo "Done: real products (Channel3) are on for the public demo. The key is stored on the server only."
