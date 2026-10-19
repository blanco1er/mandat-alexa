#!/bin/zsh
# E-mail alert when an outside visitor uses the public demo (at most one e-mail an hour), through Amazon SNS.
# The owner types his e-mail address (hidden input); it lives only in the SNS subscription, never in the code, the
# repository or the Lambda: the Lambda only gets the topic ARN (MANDAT_ALERT_TOPIC). Confirm the subscription from
# the e-mail Amazon sends, or nothing is delivered. Cost: SNS e-mail is free for the first 1,000 e-mails a month.
# Usage: AWS_PROFILE=mandat zsh scripts/set-visit-alert.sh
set -euo pipefail
FUNCTION="${MANDAT_FUNCTION:-mandat-alexa}"
REGION="${AWS_REGION:-us-east-1}"
PROFILE="${AWS_PROFILE:-mandat}"
AWS=(aws --region "$REGION" --profile "$PROFILE" --output json)

printf "E-mail address for the visit alerts, then Enter (nothing is shown): "; read -rs EMAIL; echo
EMAIL="${EMAIL// /}"
[[ "$EMAIL" == *@*.* ]] || { echo "That does not look like an e-mail address: nothing was changed."; exit 1; }
echo "Address received (${#EMAIL} characters, not shown)."

TOPIC=$("${AWS[@]}" sns create-topic --name mandat-visits --tags Key=project,Value=mandat-alexa --query TopicArn --output text)
EXISTING=$("${AWS[@]}" sns list-subscriptions-by-topic --topic-arn "$TOPIC" --query 'Subscriptions[].Endpoint' --output text)
if [[ " $EXISTING " == *" $EMAIL "* ]]; then echo "This address is already subscribed."; else
  "${AWS[@]}" sns subscribe --topic-arn "$TOPIC" --protocol email --notification-endpoint "$EMAIL" >/dev/null
  echo "Subscription created: open the e-mail from AWS Notifications and click « Confirm subscription »."
fi
unset EMAIL

# The Lambda may publish to this topic only (scripts/deploy-aws.sh keeps the same permission on every deploy).
ROLE="${MANDAT_ROLE:-mandat-alexa-role}"
"${AWS[@]}" iam put-role-policy --role-name "$ROLE" --policy-name mandat-visit-alerts --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"Alerts\",\"Effect\":\"Allow\",\"Action\":\"sns:Publish\",\"Resource\":\"$TOPIC\"}]}"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; umask 077
"${AWS[@]}" lambda get-function-configuration --function-name "$FUNCTION" --query 'Environment.Variables' > "$TMP/cur.json"
TOPIC="$TOPIC" node -e '
  const fs = require("fs");
  const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8") || "{}") || {};
  v.MANDAT_ALERT_TOPIC = process.env.TOPIC;
  fs.writeFileSync(process.argv[2], JSON.stringify({ Variables: v }));
' "$TMP/cur.json" "$TMP/env.json"
"${AWS[@]}" lambda update-function-configuration --function-name "$FUNCTION" --environment "file://$TMP/env.json" >/dev/null
"${AWS[@]}" lambda wait function-updated-v2 --function-name "$FUNCTION"
echo "Done: a new outside visitor who makes at least one turn sends you one e-mail (at most one an hour)."
