#!/usr/bin/env bash
# List every object in the POC buckets and bulk-index them into poc-csd-objects.
# Runs from this shell: enumerates via S3, then pushes a bulk payload through
# the POC EC2 (signed by instance role — no master creds needed).
#
# Requires: bootstrap-opensearch.sh has been run once.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
PROFILE="${AWS_PROFILE:-poc-csd}"
INDEX="poc-csd-objects"

BUCKET_A=$(aws cloudformation describe-stacks --stack-name PocCsd-S3 --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketAName'].OutputValue" --output text)
BUCKET_B=$(aws cloudformation describe-stacks --stack-name PocCsd-S3 --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketBName'].OutputValue" --output text)
BUCKET_C=$(aws cloudformation describe-stacks --stack-name PocCsd-S3 --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketCName'].OutputValue" --output text)
INSTANCE_ID=$(aws cloudformation describe-stacks --stack-name PocCsd-Ec2 --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)
ENDPOINT=$(aws cloudformation describe-stacks --stack-name PocCsd-Ec2 --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='OpensearchEndpoint'].OutputValue" --output text)
DEPLOY_BUCKET=$(aws cloudformation describe-stacks --stack-name PocCsd-S3 --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='DeployBucketName'].OutputValue" --output text)

STAGE=$(mktemp -d)
trap "rm -rf '$STAGE'" EXIT
BULK="$STAGE/bulk.ndjson"

build_docs_for_bucket() {
  local bucket="$1"
  aws s3api list-objects-v2 --bucket "$bucket" --region "$REGION" --profile "$PROFILE" \
    --query "Contents[].[Key,Size,LastModified]" --output text 2>/dev/null | while IFS=$'\t' read -r KEY SIZE LAST; do
    [[ -z "$KEY" ]] && continue
    # derive "prefix" as the first path component (e.g. "x/" from "x/nested/deep.txt")
    local PREFIX
    if [[ "$KEY" == */* ]]; then
      PREFIX="${KEY%%/*}/"
    else
      PREFIX=""
    fi
    local ID
    ID=$(printf '%s/%s' "$bucket" "$KEY" | python -c "import sys,hashlib; print(hashlib.sha1(sys.stdin.read().encode()).hexdigest())")
    printf '{"index":{"_id":"%s"}}\n' "$ID" >> "$BULK"
    printf '{"bucket":"%s","key":"%s","prefix":"%s","size":%s,"lastModified":"%s"}\n' \
      "$bucket" "$KEY" "$PREFIX" "$SIZE" "$LAST" >> "$BULK"
  done
}

echo "-- listing objects"
build_docs_for_bucket "$BUCKET_A"
build_docs_for_bucket "$BUCKET_B"
build_docs_for_bucket "$BUCKET_C"

if [[ ! -s "$BULK" ]]; then
  echo "ERROR: no documents to index" >&2
  exit 1
fi
echo "   prepared $(grep -c '^{"index"' "$BULK") documents"

echo "-- staging bulk payload to deploy bucket"
aws s3 cp "$BULK" "s3://$DEPLOY_BUCKET/bulk.ndjson" --region "$REGION" --profile "$PROFILE" >/dev/null

echo "-- indexing via EC2 (instance role signs requests)"
CMD=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "seed poc-csd index" \
  --parameters commands="[\"set -e\",\"pip3 install --quiet awscurl || (dnf install -y python3-pip && pip3 install --quiet awscurl)\",\"aws s3 cp s3://$DEPLOY_BUCKET/bulk.ndjson /tmp/bulk.ndjson\",\"awscurl --service es -X POST 'https://$ENDPOINT/$INDEX/_bulk' --data-binary @/tmp/bulk.ndjson -H 'content-type: application/x-ndjson' | head -c 500\",\"echo\",\"awscurl --service es -X POST 'https://$ENDPOINT/$INDEX/_refresh' -H 'content-type: application/json'\",\"awscurl --service es 'https://$ENDPOINT/$INDEX/_count' -H 'content-type: application/json'\"]" \
  --region "$REGION" --profile "$PROFILE" \
  --query "Command.CommandId" --output text)

aws ssm wait command-executed --command-id "$CMD" --instance-id "$INSTANCE_ID" --region "$REGION" --profile "$PROFILE" || true
STATUS=$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE_ID" --region "$REGION" --profile "$PROFILE" --query "Status" --output text)
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE_ID" --region "$REGION" --profile "$PROFILE" \
  --query "StandardOutputContent" --output text
if [[ "$STATUS" != "Success" ]]; then
  aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE_ID" --region "$REGION" --profile "$PROFILE" \
    --query "StandardErrorContent" --output text >&2
  exit 1
fi

echo
echo "Done."
