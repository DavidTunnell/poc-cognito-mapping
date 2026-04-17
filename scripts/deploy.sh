#!/usr/bin/env bash
# Build the app, upload to the deploy bucket, and tell EC2 to fetch + restart.
# Requires: AWS_PROFILE (or default creds) for account 592920047652, and a deployed Ec2Stack.
set -euo pipefail

PROFILE="${AWS_PROFILE:-poc-csd}"
REGION="${AWS_REGION:-us-east-1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ Reading CDK stack outputs"
DEPLOY_BUCKET=$(aws cloudformation describe-stacks --stack-name PocCsd-S3 --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='DeployBucketName'].OutputValue" --output text)
INSTANCE_ID=$(aws cloudformation describe-stacks --stack-name PocCsd-Ec2 --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)

if [[ -z "$DEPLOY_BUCKET" || -z "$INSTANCE_ID" ]]; then
  echo "ERROR: could not read DeployBucket or InstanceId from CDK outputs. Did you run 'npm run deploy:infra'?" >&2
  exit 1
fi

echo "  deploy bucket: $DEPLOY_BUCKET"
echo "  instance id:   $INSTANCE_ID"

echo "→ Building server + web"
(cd "$ROOT/server" && npm ci --silent && npm run build)
(cd "$ROOT/web" && npm ci --silent && npm run build)

echo "→ Packaging tarball"
STAGE="$ROOT/.deploy-stage"
rm -rf "$STAGE"
mkdir -p "$STAGE/server" "$STAGE/web"
cp -r "$ROOT/server/dist" "$STAGE/server/"
cp -r "$ROOT/server/package.json" "$ROOT/server/package-lock.json" "$STAGE/server/" 2>/dev/null || true
cp -r "$ROOT/web/dist" "$STAGE/web/"
tar -C "$STAGE" -czf "$ROOT/app.tar.gz" .

echo "→ Uploading to s3://$DEPLOY_BUCKET/app.tar.gz"
aws s3 cp "$ROOT/app.tar.gz" "s3://$DEPLOY_BUCKET/app.tar.gz" --region "$REGION" --profile "$PROFILE"

echo "→ Triggering deploy on $INSTANCE_ID via SSM"
CMD_ID=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "poc-csd deploy" \
  --parameters 'commands=["/usr/local/bin/poc-csd-deploy"]' \
  --region "$REGION" --profile "$PROFILE" \
  --query "Command.CommandId" --output text)
echo "  command id: $CMD_ID"

echo "→ Waiting for command to finish"
aws ssm wait command-executed --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --region "$REGION" --profile "$PROFILE" || true

STATUS=$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --region "$REGION" --profile "$PROFILE" --query "Status" --output text)
echo "  status: $STATUS"
if [[ "$STATUS" != "Success" ]]; then
  aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --region "$REGION" --profile "$PROFILE" \
    --query "{Out:StandardOutputContent, Err:StandardErrorContent}" --output text >&2
  exit 1
fi

APP_URL=$(aws cloudformation describe-stacks --stack-name PocCsd-Ec2 --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='AppUrl'].OutputValue" --output text)
echo
echo "✓ Deployed. Open: $APP_URL"

rm -rf "$STAGE"
