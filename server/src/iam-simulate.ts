import {
  IAMClient,
  SimulatePrincipalPolicyCommand,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
  GetRolePolicyCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
} from '@aws-sdk/client-iam';
import { config } from './config';
import { PolicyDocument } from './iam-policy';

/**
 * AWS-facing half of the scope resolver. Fetches a role's effective policies
 * and asks IAM to evaluate `s3:ListBucket` for specific (bucket, prefix)
 * combinations. No heuristics here — IAM has the last word.
 */

const iam = new IAMClient({ region: config.region });

function roleNameFromArn(roleArn: string): string {
  const slash = roleArn.lastIndexOf('/');
  return slash < 0 ? roleArn : roleArn.slice(slash + 1);
}

function parsePolicyDocument(encoded?: string): PolicyDocument | null {
  if (!encoded) return null;
  try {
    return JSON.parse(decodeURIComponent(encoded)) as PolicyDocument;
  } catch {
    try { return JSON.parse(encoded) as PolicyDocument; } catch { return null; }
  }
}

export async function fetchRolePolicies(roleArn: string): Promise<PolicyDocument[]> {
  const roleName = roleNameFromArn(roleArn);
  const docs: PolicyDocument[] = [];

  const inline = await iam.send(new ListRolePoliciesCommand({ RoleName: roleName }));
  await Promise.all((inline.PolicyNames ?? []).map(async name => {
    const res = await iam.send(new GetRolePolicyCommand({ RoleName: roleName, PolicyName: name }));
    const doc = parsePolicyDocument(res.PolicyDocument);
    if (doc) docs.push(doc);
  }));

  const attached = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }));
  await Promise.all((attached.AttachedPolicies ?? []).map(async ap => {
    if (!ap.PolicyArn) return;
    const meta = await iam.send(new GetPolicyCommand({ PolicyArn: ap.PolicyArn }));
    const version = meta.Policy?.DefaultVersionId;
    if (!version) return;
    const res = await iam.send(new GetPolicyVersionCommand({ PolicyArn: ap.PolicyArn, VersionId: version }));
    const doc = parsePolicyDocument(res.PolicyVersion?.Document);
    if (doc) docs.push(doc);
  }));

  return docs;
}

/**
 * For each candidate prefix, ask Simulate whether the role could call
 * s3:ListBucket on the given bucket with that prefix in scope. An empty
 * string prefix means "no s3:prefix context entry" (unconditioned list).
 *
 * Returns only the prefixes that Simulate resolved to `allowed`.
 */
export async function simulateListBucketPrefixes(
  roleArn: string,
  bucketArn: string,
  prefixes: string[],
): Promise<string[]> {
  if (prefixes.length === 0) return [];
  const results = await Promise.all(prefixes.map(async prefix => {
    try {
      const r = await iam.send(new SimulatePrincipalPolicyCommand({
        PolicySourceArn: roleArn,
        ActionNames: ['s3:ListBucket'],
        ResourceArns: [bucketArn],
        ContextEntries: prefix === '' ? [] : [{
          ContextKeyName: 's3:prefix',
          ContextKeyType: 'string',
          ContextKeyValues: [prefix],
        }],
      }));
      const decision = r.EvaluationResults?.[0]?.EvalDecision;
      return decision === 'allowed' ? prefix : null;
    } catch {
      return null;
    }
  }));
  return results.filter((p): p is string => p !== null);
}
