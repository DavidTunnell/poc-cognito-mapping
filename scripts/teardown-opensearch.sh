#!/usr/bin/env bash
# Reverse everything bootstrap-opensearch.sh did, in inverse order:
#   1. Delete the poc-csd-objects index (from the EC2, signed as instance role)
#   2. Delete the OpenSearch role and its backend role mapping (master creds)
#   3. Remove the PocCsdOpenSearchAccess statement from the domain access policy
#
# Run this BEFORE `npm run teardown`. Once the EC2 stack is destroyed the SSM path
# disappears and cleanup becomes manual.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
PROFILE="${AWS_PROFILE:-poc-csd}"
MASTER_PROFILE="${MASTER_AWS_PROFILE:-}"
DOMAIN="cloudseedrive-uat"
INDEX="poc-csd-objects"
ROLE_NAME="poc_csd_rw"

if [[ -z "$MASTER_PROFILE" ]]; then
  echo "ERROR: set MASTER_AWS_PROFILE — same as bootstrap." >&2
  exit 1
fi

INSTANCE_ID=$(aws cloudformation describe-stacks --stack-name PocCsd-Ec2 --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text 2>/dev/null || echo "")
ENDPOINT=$(aws cloudformation describe-stacks --stack-name PocCsd-Ec2 --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='OpensearchEndpoint'].OutputValue" --output text 2>/dev/null || echo "")

MASTER_AK=$(aws configure get aws_access_key_id --profile "$MASTER_PROFILE")
MASTER_SK=$(aws configure get aws_secret_access_key --profile "$MASTER_PROFILE")

if [[ -n "$INSTANCE_ID" && -n "$ENDPOINT" ]]; then
  echo "-- deleting index, role, and role mapping via EC2"
  CMD=$(aws ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name "AWS-RunShellScript" \
    --comment "teardown poc-csd OpenSearch" \
    --parameters commands="[\"set -e\",\"pip3 install --quiet awscurl || (dnf install -y python3-pip && pip3 install --quiet awscurl)\",\"export AWS_ACCESS_KEY_ID='$MASTER_AK' AWS_SECRET_ACCESS_KEY='$MASTER_SK' AWS_DEFAULT_REGION='$REGION'\",\"awscurl --service es -X DELETE 'https://$ENDPOINT/$INDEX' || true\",\"awscurl --service es -X DELETE 'https://$ENDPOINT/_plugins/_security/api/rolesmapping/$ROLE_NAME' || true\",\"awscurl --service es -X DELETE 'https://$ENDPOINT/_plugins/_security/api/roles/$ROLE_NAME' || true\",\"unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY\",\"echo OPENSEARCH_TEARDOWN_DONE\"]" \
    --region "$REGION" --profile "$PROFILE" \
    --query "Command.CommandId" --output text)
  aws ssm wait command-executed --command-id "$CMD" --instance-id "$INSTANCE_ID" --region "$REGION" --profile "$PROFILE" || true
  aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE_ID" --region "$REGION" --profile "$PROFILE" \
    --query "StandardOutputContent" --output text
else
  echo "   (EC2 stack already gone — skipping in-VPC cleanup)"
fi

# --- Revert access policy: drop the PocCsdOpenSearchAccess statement ---
echo "-- reverting UAT OpenSearch access policy"
CURRENT=$(aws opensearch describe-domain --domain-name "$DOMAIN" --region "$REGION" --profile "$MASTER_PROFILE" \
  --query "DomainStatus.AccessPolicies" --output text)
REVERTED=$(python <<PY
import json,sys
p = json.loads('''$CURRENT''')
p['Statement'] = [s for s in p.get('Statement', []) if s.get('Sid') != 'PocCsdOpenSearchAccess']
print(json.dumps(p))
PY
)
aws opensearch update-domain-config \
  --domain-name "$DOMAIN" \
  --access-policies "$REVERTED" \
  --region "$REGION" --profile "$MASTER_PROFILE" >/dev/null

echo
echo "Done. Now safe to run: npm run teardown"
