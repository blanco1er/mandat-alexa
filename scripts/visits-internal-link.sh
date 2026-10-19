#!/bin/zsh
# Prints the secret link that marks one of YOUR devices as "internal": open it once in each browser you use (Mac,
# iPhone, iPad); afterwards your own visits to the public demo are never logged. Keep the link to yourself.
# The key is derived from the Lambda's network secret, read with your AWS profile; nothing is stored in the repo.
# Usage: AWS_PROFILE=mandat zsh scripts/visits-internal-link.sh
set -euo pipefail
FUNCTION="${MANDAT_FUNCTION:-mandat-alexa}"
REGION="${AWS_REGION:-us-east-1}"
PROFILE="${AWS_PROFILE:-mandat}"
CONF=$(aws lambda get-function-configuration --function-name "$FUNCTION" --region "$REGION" --profile "$PROFILE" --output json)
printf '%s' "$CONF" | node -e '
  const crypto = require("crypto");
  const v = JSON.parse(require("fs").readFileSync(0, "utf8")).Environment.Variables;
  const key = crypto.createHash("sha256").update("mandat-internal-visit:" + v.MANDAT_NETWORK_SECRET).digest("hex").slice(0, 32);
  console.log("Open this link once in each of your browsers (keep it private):\n" + v.MANDAT_PUBLIC_URL + "/visit/internal?k=" + key);
'
