#!/usr/bin/env bash
# Create 4 demo Cognito users and assign them to groups.
# Each user gets a temp password (printed below) and must change it on first login.
set -euo pipefail

PROFILE="${AWS_PROFILE:-poc-csd}"
REGION="${AWS_REGION:-us-east-1}"

USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name PocCsd-Auth --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
if [[ -z "$USER_POOL_ID" ]]; then
  echo "ERROR: PocCsd-Auth stack not found. Run 'npm run deploy:infra' first." >&2
  exit 1
fi

TEMP_PASSWORD="Temp-Poc-123"

create_user() {
  local username="$1"
  local email="$2"
  local group="$3"
  echo "-> $username ($email)  -> group: $group"

  if aws cognito-idp admin-get-user --user-pool-id "$USER_POOL_ID" --username "$username" --region "$REGION" --profile "$PROFILE" >/dev/null 2>&1; then
    echo "   (user exists, skipping create)"
  else
    aws cognito-idp admin-create-user \
      --user-pool-id "$USER_POOL_ID" \
      --username "$username" \
      --user-attributes Name=email,Value="$email" Name=email_verified,Value=true \
      --temporary-password "$TEMP_PASSWORD" \
      --message-action SUPPRESS \
      --region "$REGION" --profile "$PROFILE" >/dev/null
  fi

  aws cognito-idp admin-add-user-to-group \
    --user-pool-id "$USER_POOL_ID" \
    --username "$username" \
    --group-name "$group" \
    --region "$REGION" --profile "$PROFILE" >/dev/null
}

create_user "alice" "alice@poc.local" "readonly-all"
create_user "bob"   "bob@poc.local"   "rw-bucket-a"
create_user "carol" "carol@poc.local" "readonly-prefix-x"
create_user "admin" "admin@poc.local" "admin"

echo
echo "Done. Sign in with username (alice, bob, carol, admin) OR email."
echo "Temporary password: $TEMP_PASSWORD"
echo "First login will force NEW_PASSWORD_REQUIRED - the UI handles this."
