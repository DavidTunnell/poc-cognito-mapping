#!/usr/bin/env bash
# Empty POC buckets and destroy all CDK stacks in 592920047652/us-east-1.
# If the OpenSearch extension is deployed, run `scripts/teardown-opensearch.sh`
# FIRST to revert the UAT domain access policy and remove the poc-csd index.
set -euo pipefail

PROFILE="${AWS_PROFILE:-poc-csd}"
REGION="${AWS_REGION:-us-east-1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# If a UAT access policy still has our sentinel statement, block teardown — otherwise
# we'd lose the only SSM path to clean it up.
OS_STATEMENT=$(aws opensearch describe-domain --domain-name cloudseedrive-uat --region "$REGION" --profile "$PROFILE" \
  --query "DomainStatus.AccessPolicies" --output text 2>/dev/null | grep -c PocCsdOpenSearchAccess || true)
if [[ "$OS_STATEMENT" -gt 0 ]]; then
  echo "ERROR: UAT OpenSearch access policy still contains the POC statement." >&2
  echo "       Run scripts/teardown-opensearch.sh first, or accept that cleanup of that" >&2
  echo "       policy must be done manually after this teardown." >&2
  echo "       Set ALLOW_OS_LEFTOVER=1 to proceed anyway." >&2
  if [[ "${ALLOW_OS_LEFTOVER:-0}" != "1" ]]; then exit 1; fi
fi

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
