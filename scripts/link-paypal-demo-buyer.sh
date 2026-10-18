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
if echo "$STATUS" | grep -q '"linked":true'; then echo "Un payeur de démo est déjà relié : $(echo "$STATUS" | sed -E 's/.*"payer":"([^"]*)".*/\1/')."; printf "Le remplacer ? (o/N) "; read -r A; [ "$A" = o ] || exit 0; fi
OUT=$(invoke link-demo-buyer)
URL=$(echo "$OUT" | sed -nE 's/.*"approveUrl":"([^"]+)".*/\1/p')
[ -n "$URL" ] || { echo "Échec : $OUT"; exit 1; }
echo "1. Ouvrez ce lien dans le navigateur :"; echo "   $URL"
echo "2. Connectez-vous avec le compte SANDBOX « personal » (developer.paypal.com > Testing Tools > Sandbox accounts), puis acceptez."
echo "J'attends la confirmation (10 minutes au plus)…"
for i in $(seq 1 120); do sleep 5; if invoke demo-buyer-status | grep -q '"linked":true'; then echo "C'est fait : le payeur de démo est relié. Les nouveaux budgets de la démo font de vraies réservations sandbox (argent de test)."; exit 0; fi; done
echo "Pas encore de confirmation. Relancez ce script quand vous aurez accepté dans PayPal."; exit 1
