#!/usr/bin/env bash
# Empty POC buckets and destroy all CDK stacks in 592920047652/us-east-1.
set -euo pipefail

PROFILE="${AWS_PROFILE:-poc-csd}"
REGION="${AWS_REGION:-us-east-1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ Emptying S3 buckets (so they can be deleted)"
for KEY in BucketAName BucketBName BucketCName DeployBucketName; do
  BUCKET=$(aws cloudformation describe-stacks --stack-name PocCsd-S3 --region "$REGION" --profile "$PROFILE" \
    --query "Stacks[0].Outputs[?OutputKey=='$KEY'].OutputValue" --output text 2>/dev/null || true)
  if [[ -n "$BUCKET" && "$BUCKET" != "None" ]]; then
    echo "  $BUCKET"
    aws s3 rm "s3://$BUCKET" --recursive --region "$REGION" --profile "$PROFILE" >/dev/null 2>&1 || true
  fi
done

echo "→ cdk destroy --all"
(cd "$ROOT/cdk" && AWS_PROFILE="$PROFILE" AWS_REGION="$REGION" npx cdk destroy --all --force)

echo
echo "✓ Teardown complete. Check the AWS console to confirm nothing lingers."
echo "  Also: delete the IAM user whose keys you configured locally (poc-csd profile)."
