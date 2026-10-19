#!/bin/zsh
# Turns on Google Places for the real local businesses of the live Lambda (ratings, reviews, opening hours, photos),
# without ever printing the key. Without it, the demo still shows real businesses from OpenStreetMap.
# The owner pastes the key himself (hidden input), or reuses the one already saved on this Mac. Nothing is written to
# the repository. Google Cloud: enable "Places API (New)"; the key must allow server calls (no HTTP-referrer
# restriction; an API restriction to "Places API (New)" is fine).
# Usage: AWS_PROFILE=mandat zsh scripts/set-google-places.sh
set -euo pipefail
FUNCTION="${MANDAT_FUNCTION:-mandat-alexa}"
REGION="${AWS_REGION:-us-east-1}"
PROFILE="${AWS_PROFILE:-mandat}"
SAVED="${GOOGLE_PLACES_KEY_FILE:-$HOME/Library/Application Support/StudioPilot/secrets/google-places.json}"

KEY=""
if [ -r "$SAVED" ]; then
  printf "A Google Places key is saved on this Mac. Use it? [y/N] "; read -r USE_SAVED
  if [[ "$USE_SAVED" == [yYoO]* ]]; then
    KEY=$(node -e 'try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).api_key || "").trim()) } catch {}' "$SAVED")
  fi
fi
if [ -z "$KEY" ]; then
  echo "Google Places API key (console.cloud.google.com > APIs & Services > Credentials)."
  printf "Paste the key, then Enter (nothing is shown): "; read -rs KEY; echo
fi
# Forgive common copy slips: "GOOGLE_PLACES_KEY=" prefix, quotes, spaces.
KEY="${KEY#GOOGLE_PLACES_KEY=}"; KEY="${KEY//\"/}"; KEY="${KEY//\'/}"; KEY="${KEY// /}"
[ -n "$KEY" ] || { echo "Empty value: nothing was changed."; exit 1; }
echo "Key received: ${#KEY} characters (not shown)."

# One real Text Search (ids and names only, the cheapest fields) to check the key, without printing it.
# Google's own error message is shown, never the key.
RESP=$(mktemp); trap 'rm -f "$RESP"' EXIT
CODE=$(curl -s -o "$RESP" -w "%{http_code}" -X POST https://places.googleapis.com/v1/places:searchText \
  -H "X-Goog-Api-Key: $KEY" -H "X-Goog-FieldMask: places.id,places.displayName" -H "content-type: application/json" \
  -d '{"textQuery":"house cleaning service in Capitol Hill, Seattle","pageSize":1}')
if [ "$CODE" != 200 ]; then
  MSG=$(node -e 'try { const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(j.error?.message || "").slice(0, 300)) } catch {}' "$RESP")
  echo "Google refused this key (HTTP $CODE). Google says: ${MSG:-$(head -c 300 "$RESP" | tr -d '\n')}"
  echo "Nothing was changed."; exit 1
fi
FOUND=$(node -e 'try { const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(j.places?.[0]?.displayName?.text || "") } catch {}' "$RESP")
echo "Key accepted by Google Places${FOUND:+ (test search found: $FOUND)}."

rm -f "$RESP"; TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; umask 077
aws lambda get-function-configuration --function-name "$FUNCTION" --region "$REGION" --profile "$PROFILE" \
  --query 'Environment.Variables' --output json > "$TMP/cur.json"
KEY="$KEY" node -e '
  const fs = require("fs");
  const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8") || "{}") || {};
  v.GOOGLE_PLACES_KEY = process.env.KEY; v.MANDAT_PLACES = "live";
  fs.writeFileSync(process.argv[2], JSON.stringify({ Variables: v }));
' "$TMP/cur.json" "$TMP/env.json"
aws lambda update-function-configuration --function-name "$FUNCTION" --region "$REGION" --profile "$PROFILE" \
  --environment "file://$TMP/env.json" >/dev/null
aws lambda wait function-updated-v2 --function-name "$FUNCTION" --region "$REGION" --profile "$PROFILE"
unset KEY
echo "Done: Google Places is on for the public demo (real ratings, hours and photos). The key is stored on the server only."
echo "Daily caps: 30 searches, 6 per person, 60 photos (MANDAT_GOOGLE_SEARCHES_PER_DAY, _PER_USER_DAY, MANDAT_GOOGLE_PHOTOS_PER_DAY)."
