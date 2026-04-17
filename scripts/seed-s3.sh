#!/usr/bin/env bash
# Seed the 3 demo S3 buckets with sample objects that prove scoping.
set -euo pipefail

PROFILE="${AWS_PROFILE:-poc-csd}"
REGION="${AWS_REGION:-us-east-1}"

BUCKET_A=$(aws cloudformation describe-stacks --stack-name PocCsd-S3 --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketAName'].OutputValue" --output text)
BUCKET_B=$(aws cloudformation describe-stacks --stack-name PocCsd-S3 --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketBName'].OutputValue" --output text)
BUCKET_C=$(aws cloudformation describe-stacks --stack-name PocCsd-S3 --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketCName'].OutputValue" --output text)

TMP=$(mktemp -d)
trap "rm -rf '$TMP'" EXIT

seed() {
  local path="$1"
  local content="$2"
  mkdir -p "$(dirname "$TMP/$path")"
  printf '%s\n' "$content" > "$TMP/$path"
}

seed "a-root.txt"            "bucket-a root object"
seed "proj/readme.md"        "bucket-a / proj / readme"
seed "proj/notes.md"         "bucket-a / proj / notes"

seed "x/permitted-1.txt"     "bucket-b/x/* — carol can see"
seed "x/permitted-2.txt"     "bucket-b/x/* — carol can see"
seed "x/nested/deep.txt"     "bucket-b/x/nested — still allowed"
seed "y/hidden.txt"          "bucket-b/y/* — carol cannot see"
seed "y/secret.txt"          "bucket-b/y/* — carol cannot see"

seed "c-root.txt"            "bucket-c root — used for custom-mode demo"
seed "shared/note.md"        "bucket-c shared note"

echo "→ $BUCKET_A"
aws s3 cp --recursive "$TMP/" "s3://$BUCKET_A/" --region "$REGION" --profile "$PROFILE" --exclude "*" --include "a-root.txt" --include "proj/*" >/dev/null

echo "→ $BUCKET_B"
aws s3 cp --recursive "$TMP/" "s3://$BUCKET_B/" --region "$REGION" --profile "$PROFILE" --exclude "*" --include "x/*" --include "y/*" >/dev/null

echo "→ $BUCKET_C"
aws s3 cp --recursive "$TMP/" "s3://$BUCKET_C/" --region "$REGION" --profile "$PROFILE" --exclude "*" --include "c-root.txt" --include "shared/*" >/dev/null

echo
echo "✓ Seed complete."
