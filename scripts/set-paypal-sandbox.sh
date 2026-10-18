#!/bin/zsh
# Range les clés PayPal SANDBOX dans la configuration de la Lambda, sans jamais les afficher.
# Le propriétaire colle lui-même les deux valeurs (saisie masquée). Rien n'est écrit dans le dépôt.
# Usage : AWS_PROFILE=mandat zsh scripts/set-paypal-sandbox.sh
set -euo pipefail
FUNCTION="${MANDAT_FUNCTION:-mandat-alexa}"
REGION="${AWS_REGION:-us-east-1}"
PROFILE="${AWS_PROFILE:-mandat}"

echo "Clés PayPal SANDBOX (developer.paypal.com > Apps & Credentials > Sandbox)."
printf "Collez le Client ID puis Entrée (rien ne s'affiche) : "; read -rs CID; echo
printf "Collez le Secret puis Entrée (rien ne s'affiche) : "; read -rs SEC; echo
[ -n "$CID" ] && [ -n "$SEC" ] || { echo "Valeur vide : rien n'a été modifié."; exit 1; }

# Vérifie que ce sont bien des clés sandbox qui marchent (jeton OAuth), sans rien afficher.
CODE=$(curl -s -o /dev/null -w "%{http_code}" -u "$CID:$SEC" -d "grant_type=client_credentials" https://api-m.sandbox.paypal.com/v1/oauth2/token)
[ "$CODE" = 200 ] || { echo "PayPal sandbox refuse ces clés (code $CODE). Vérifiez qu'elles viennent bien de l'onglet Sandbox. Rien n'a été modifié."; exit 1; }
echo "Clés sandbox valides."

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; umask 077
aws lambda get-function-configuration --function-name "$FUNCTION" --region "$REGION" --profile "$PROFILE" \
  --query 'Environment.Variables' --output json > "$TMP/cur.json"
CID="$CID" SEC="$SEC" node -e '
  const fs = require("fs");
  const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8") || "{}") || {};
  v.PAYPAL_CLIENT_ID = process.env.CID; v.PAYPAL_CLIENT_SECRET = process.env.SEC; delete v.MANDAT_PAYPAL; // "offline" forçait le mode simulé
  fs.writeFileSync(process.argv[2], JSON.stringify({ Variables: v }));
' "$TMP/cur.json" "$TMP/env.json"
aws lambda update-function-configuration --function-name "$FUNCTION" --region "$REGION" --profile "$PROFILE" \
  --environment "file://$TMP/env.json" >/dev/null
aws lambda wait function-updated-v2 --function-name "$FUNCTION" --region "$REGION" --profile "$PROFILE"
unset CID SEC
echo "C'est fait : les clés PayPal sandbox sont rangées dans la configuration du serveur (jamais affichées)."
