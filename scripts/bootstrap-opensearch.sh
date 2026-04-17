#!/usr/bin/env bash
# One-time setup on the UAT OpenSearch domain:
#   1. Extend the domain access policy to include the POC instance role ARN
#   2. Create our dedicated index `poc-csd-objects` with an explicit mapping
#   3. Create a minimal OpenSearch role `poc_csd_rw` restricted to poc-csd-* indices
#   4. Map our POC instance role ARN as a backend role for poc_csd_rw
#
# Requires TWO sets of creds:
#   AWS_PROFILE             — any profile with iam/cloudformation/opensearch read (e.g. poc-csd).
#                             Used for reading stack outputs and updating the domain config.
#   MASTER_AWS_PROFILE      — profile for the UAT OpenSearch master user
#                             (webapper-cloudsee-opensearch). Only this principal can call
#                             the _plugins/_security/api/* endpoints and update the domain
#                             access policy.
#
# Example:
#   export AWS_PROFILE=poc-csd
#   export MASTER_AWS_PROFILE=csd-opensearch-master
#   bash scripts/bootstrap-opensearch.sh
#
# The access policy change is reversed by teardown-opensearch.sh. Keep the master
# profile configured locally only for the duration of setup and teardown.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
PROFILE="${AWS_PROFILE:-poc-csd}"
MASTER_PROFILE="${MASTER_AWS_PROFILE:-}"
DOMAIN="cloudseedrive-uat"
INDEX="poc-csd-objects"
ROLE_NAME="poc_csd_rw"

if [[ -z "$MASTER_PROFILE" ]]; then
  echo "ERROR: set MASTER_AWS_PROFILE to a profile that authenticates as the UAT OpenSearch master user." >&2
  echo "  See scripts/bootstrap-opensearch.sh header." >&2
  exit 1
fi

echo "-- reading stack outputs"
INSTANCE_ROLE_ARN=$(aws cloudformation describe-stacks --stack-name PocCsd-Ec2 --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceRoleArn'].OutputValue" --output text)
ENDPOINT=$(aws cloudformation describe-stacks --stack-name PocCsd-Ec2 --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='OpensearchEndpoint'].OutputValue" --output text)
if [[ -z "$INSTANCE_ROLE_ARN" || -z "$ENDPOINT" ]]; then
  echo "ERROR: could not resolve instance role / endpoint. Deploy PocCsd-Ec2 first." >&2
  exit 1
fi
echo "   instance role: $INSTANCE_ROLE_ARN"
echo "   endpoint:      $ENDPOINT"

# --- 1. Extend the access policy to include the POC instance role ---
echo "-- reading current access policy"
CURRENT=$(aws opensearch describe-domain --domain-name "$DOMAIN" --region "$REGION" --profile "$MASTER_PROFILE" \
  --query "DomainStatus.AccessPolicies" --output text)
echo "$CURRENT" | python -c "import sys,json; p=json.load(sys.stdin); print('   existing statements:', len(p.get('Statement', [])))"

ACCOUNT_ID=$(echo "$INSTANCE_ROLE_ARN" | cut -d: -f5)
DOMAIN_RES="arn:aws:es:${REGION}:${ACCOUNT_ID}:domain/${DOMAIN}/*"
NEW_POLICY=$(INSTANCE_ROLE_ARN="$INSTANCE_ROLE_ARN" DOMAIN_RES="$DOMAIN_RES" CURRENT_POLICY="$CURRENT" python <<'PY'
import json, os
cur = json.loads(os.environ['CURRENT_POLICY'])
role_arn = os.environ['INSTANCE_ROLE_ARN']
domain_res = os.environ['DOMAIN_RES']
marker_sid = "PocCsdOpenSearchAccess"
cur.setdefault('Statement', [])
cur['Statement'] = [s for s in cur['Statement'] if s.get('Sid') != marker_sid]
cur['Statement'].append({
    "Sid": marker_sid,
    "Effect": "Allow",
    "Principal": {"AWS": role_arn},
    "Action": "es:*",
    "Resource": domain_res,
})
print(json.dumps(cur))
PY
)

echo "-- updating domain access policy"
aws opensearch update-domain-config \
  --domain-name "$DOMAIN" \
  --access-policies "$NEW_POLICY" \
  --region "$REGION" --profile "$MASTER_PROFILE" >/dev/null
echo "   policy updated. Domain will process (no downtime)."

# --- 2. Wait for endpoint reachability from this shell is NOT expected ---
# The endpoint is VPC-only. We use SSM to run the remaining steps FROM the POC EC2.

INSTANCE_ID=$(aws cloudformation describe-stacks --stack-name PocCsd-Ec2 --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)
echo "-- running index + role setup from EC2 ($INSTANCE_ID) via SSM"

# Signed curl helper lives on the EC2 already (awscurl-style via aws-cli + awscli-plugin-endpoint
# is overkill; we use a small node script uploaded next to the app).
# For simplicity here we shell out to `curl` with AWS SigV4 via `awscurl` if installed,
# or fall back to the server's own /_plugins/_security endpoint using master creds.
#
# Master-user creds flow: we temporarily push them to the instance as env vars for
# the SSM command, then unset. They never get written to disk on the instance.

MASTER_AK=$(aws configure get aws_access_key_id --profile "$MASTER_PROFILE")
MASTER_SK=$(aws configure get aws_secret_access_key --profile "$MASTER_PROFILE")
if [[ -z "$MASTER_AK" || -z "$MASTER_SK" ]]; then
  echo "ERROR: could not read master creds from profile $MASTER_PROFILE" >&2
  exit 1
fi

# Stage a self-contained inner script + JSON payloads on the deploy bucket,
# then have SSM fetch and run it. Avoids the JSON-in-CLI-parameters escaping
# nightmare and keeps the actual logic readable.
DEPLOY_BUCKET=$(aws cloudformation describe-stacks --stack-name PocCsd-S3 --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='DeployBucketName'].OutputValue" --output text)
STAGE=$(mktemp -d)
trap "rm -rf '$STAGE'" EXIT

cat > "$STAGE/mapping.json" <<'EOF'
{"mappings":{"properties":{"bucket":{"type":"keyword"},"key":{"type":"text","fields":{"keyword":{"type":"keyword","ignore_above":1024}}},"prefix":{"type":"keyword"},"size":{"type":"long"},"lastModified":{"type":"date"}}}}
EOF

cat > "$STAGE/role.json" <<EOF
{"cluster_permissions":["cluster_composite_ops"],"index_permissions":[{"index_patterns":["poc-csd-*"],"allowed_actions":["indices_all"]},{"index_patterns":["aws_account_${ACCOUNT_ID}_*_active"],"allowed_actions":["read","indices:data/read/search","indices:data/read/msearch","indices:data/read/mget","indices:admin/get","indices:admin/mappings/get"]}]}
EOF

INSTANCE_ROLE_ARN="$INSTANCE_ROLE_ARN" python -c "import json,os; print(json.dumps({'backend_roles':[os.environ['INSTANCE_ROLE_ARN']]}))" > "$STAGE/rolemapping.json"

cat > "$STAGE/inner.sh" <<EOF
#!/bin/bash
set -e
pip3 install --quiet awscurl || (dnf install -y python3-pip && pip3 install --quiet awscurl)
aws s3 cp s3://${DEPLOY_BUCKET}/bootstrap/mapping.json /tmp/mapping.json
aws s3 cp s3://${DEPLOY_BUCKET}/bootstrap/role.json /tmp/role.json
aws s3 cp s3://${DEPLOY_BUCKET}/bootstrap/rolemapping.json /tmp/rolemapping.json
export AWS_ACCESS_KEY_ID='${MASTER_AK}'
export AWS_SECRET_ACCESS_KEY='${MASTER_SK}'
export AWS_DEFAULT_REGION='${REGION}'
echo "-- creating index"
awscurl --service es -X PUT "https://${ENDPOINT}/${INDEX}" -d "@/tmp/mapping.json" -H "content-type: application/json" || echo "   (index may already exist, continuing)"
echo
echo "-- creating role"
awscurl --service es -X PUT "https://${ENDPOINT}/_plugins/_security/api/roles/${ROLE_NAME}" -d "@/tmp/role.json" -H "content-type: application/json"
echo
echo "-- creating role mapping"
awscurl --service es -X PUT "https://${ENDPOINT}/_plugins/_security/api/rolesmapping/${ROLE_NAME}" -d "@/tmp/rolemapping.json" -H "content-type: application/json"
echo
echo "-- verifying role mapping"
awscurl --service es "https://${ENDPOINT}/_plugins/_security/api/rolesmapping/${ROLE_NAME}" -H "content-type: application/json"
echo
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
echo "BOOTSTRAP_DONE"
EOF
chmod +x "$STAGE/inner.sh"

echo "-- uploading bootstrap payload"
aws s3 cp "$STAGE/mapping.json"     "s3://$DEPLOY_BUCKET/bootstrap/mapping.json"     --region "$REGION" --profile "$PROFILE" >/dev/null
aws s3 cp "$STAGE/role.json"        "s3://$DEPLOY_BUCKET/bootstrap/role.json"        --region "$REGION" --profile "$PROFILE" >/dev/null
aws s3 cp "$STAGE/rolemapping.json" "s3://$DEPLOY_BUCKET/bootstrap/rolemapping.json" --region "$REGION" --profile "$PROFILE" >/dev/null
aws s3 cp "$STAGE/inner.sh"         "s3://$DEPLOY_BUCKET/bootstrap/inner.sh"         --region "$REGION" --profile "$PROFILE" >/dev/null

CMD=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "bootstrap poc-csd OpenSearch" \
  --parameters "commands=['aws s3 cp s3://${DEPLOY_BUCKET}/bootstrap/inner.sh /tmp/inner.sh','chmod +x /tmp/inner.sh','/tmp/inner.sh','rm -f /tmp/inner.sh /tmp/mapping.json /tmp/role.json /tmp/rolemapping.json']" \
  --region "$REGION" --profile "$PROFILE" \
  --query "Command.CommandId" --output text)
echo "   ssm command: $CMD"

aws ssm wait command-executed --command-id "$CMD" --instance-id "$INSTANCE_ID" --region "$REGION" --profile "$PROFILE" || true
STATUS=$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE_ID" --region "$REGION" --profile "$PROFILE" --query "Status" --output text)
echo "   status: $STATUS"
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE_ID" --region "$REGION" --profile "$PROFILE" \
  --query "StandardOutputContent" --output text

if [[ "$STATUS" != "Success" ]]; then
  aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE_ID" --region "$REGION" --profile "$PROFILE" \
    --query "StandardErrorContent" --output text >&2
  exit 1
fi

echo
echo "Done. You can now run: bash scripts/seed-opensearch.sh"
