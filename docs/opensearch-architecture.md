# OpenSearch extension — architecture

## Why

The baseline POC proved Cognito → Identity Pool → IAM → S3: S3 enforces. Simple and elegant *for S3*.

OpenSearch is the harder case. It doesn't understand IAM. Indexed documents are just JSON — the API returns whatever matches the query, regardless of who's asking. If CSD's Fast Buckets service is to inherit IAM permissions without duplicating logic, the app has to:

1. Work out each user's effective S3 scope.
2. Express that scope as an OpenSearch filter.
3. Append it to every query.

This extension proves that pattern end-to-end against the existing `cloudseedrive-uat` OpenSearch domain. Admins continue to maintain only IAM; the POC does the translation on the hot path.

## The path

```
Browser ──search q──▶ Server /api/search?q=...
                       │
                       ├─ verify ID token
                       │
                       ├─ resolveScope(username, idToken)
                       │    └─ cache miss? In IAM mode:
                       │       • getCredentialsForIdToken  (Identity Pool exchange)
                       │       • for each known bucket:
                       │         - try ListObjectsV2 (no prefix)  — whole bucket?
                       │         - else try ListObjectsV2 for each probe prefix
                       │       Cache as Map<sha256(token), scope> with TTL ≤ token life
                       │
                       ├─ buildSearchQuery(scope, q)
                       │    └─ { bool: { must: [multi_match], filter: [scope DSL] }}
                       │
                       └─ osCall POST /poc-csd-objects/_search  (AWS4-signed by instance role)
                          │
                         OpenSearch
                          │
                         ─ returns only docs whose {bucket, key-prefix} match the scope
                          │
                         ▼
                        hits → UI  (click → presigned GET via user's IAM creds, same as Browse)
```

## Scope → OpenSearch DSL (the whole trick)

```ts
scope = {
  buckets: {
    "poc-csd-bucket-a-…": { allowedPrefixes: [] },        // whole bucket
    "poc-csd-bucket-b-…": { allowedPrefixes: ["x/"] },    // partial
  },
  source: "iam" | "custom",
}

// ⇣ translates to

{
  bool: {
    should: [
      { term: { bucket: "poc-csd-bucket-a-…" } },                     // whole-bucket branch
      { bool: {                                                       // partial branch
          must: [
            { term: { bucket: "poc-csd-bucket-b-…" } },
            { bool: { should: [{ prefix: { key: "x/" } }], minimum_should_match: 1 } },
          ],
      }},
    ],
    minimum_should_match: 1,
  },
}
```

Empty scope (`buckets: {}`) produces a `match_none` — a user with zero S3 access sees zero OpenSearch hits. That's deliberate.

## Scope resolution — two modes, shared interface

| Scheme | Where scope comes from | Cost per login |
|---|---|---|
| `iam` | Probe `ListObjectsV2` against known buckets with the user's assumed role creds | 1 + N prefix probes, N ≤ `PROBE_PREFIXES.length` |
| `custom` | Read `data/custom-permissions.json` for the username | zero AWS calls |

Both produce the same `Scope` shape, which is what `buildSearchQuery` consumes. The `/api/search` route never branches on scheme — only on whether the scope came back non-empty.

## Why not `iam:SimulatePrincipalPolicy`?

It's better. It handles conditions we don't know about, evaluates deny statements correctly, and doesn't require us to enumerate candidate prefixes. For production, that's the move.

For a POC with four known demo users and a small bucket set, prefix probing is a) instantly understandable, b) zero IAM permissions needed on the prober (just the user's own creds), c) tangible — you can watch the `ListObjectsV2` calls in CloudTrail.

The interface is behind a single `resolveScope` call — swapping the implementation from probing → SimulatePrincipalPolicy is additive.

## Trust boundary (what the app is trusted with)

| Is the server trusted to... | Yes / No | Why |
|---|---|---|
| Decide what the user should see? | **No** in IAM mode | S3 (via the user's role) decides during probing; the server's job is to faithfully encode the result. Turn the server's filter injection off (`SEARCH_BYPASS_SCOPE=1`) and the user gets everything in the index, regardless of their IAM — demonstrating that the filter is the gate. |
| Open documents on behalf of the user? | Yes, but only via presigned URLs signed with the *user's* creds | The presigned URL has the user's IAM scope baked in. If their role disallows the `GetObject`, the URL 403s. Server never proxies bytes. |
| Write to OpenSearch? | Only during seed | Runtime is read-only. Bulk indexing uses the instance role; production would use an SQS-fan-out-to-Lambda pattern like CSD's Fast Buckets already has. |

## UAT domain changes (surgical)

The UAT domain had one access-policy principal: `user/webapper-cloudsee-opensearch` (the master). Bootstrap adds one statement:

```json
{
  "Sid": "PocCsdOpenSearchAccess",
  "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::592920047652:role/<PocCsd instance role>" },
  "Action": "es:*",
  "Resource": "arn:aws:es:us-east-1:592920047652:domain/cloudseedrive-uat/*"
}
```

Plus one OpenSearch role (`poc_csd_rw`, scoped to index pattern `poc-csd-*`) and one backend role mapping (POC role ARN → `poc_csd_rw`). All created, owned, and removed by `scripts/bootstrap-opensearch.sh` and `scripts/teardown-opensearch.sh`. No touching of CSD's existing indexes.

## Limitations

- Scope cache is per-process; if we had multiple instances behind an LB, they'd each cache independently. Fine for one EC2.
- Prefix probing is a heuristic. Real policies with `s3:ExistingObjectTag`, time-based conditions, MFA, etc. won't be captured. Swap for `iam:SimulatePrincipalPolicy` when that matters.
- No index updates on S3 change events. Batch seed only — deliberately.
- HTTP only on the POC EC2. Still.

## What to pitch to the CSD team

- **Yes, IAM-inherited permissions work for OpenSearch queries** — the filter-injection pattern is clean and the two scope-resolution paths share one query builder.
- **Prefix probing at login is the POC shortcut.** Production should use `iam:SimulatePrincipalPolicy` via a narrow helper role that Fast Buckets' Lambda assumes.
- **The filter lives in one pure function.** Ship that one file into Fast Buckets and the rest of the query code doesn't change.
- **Teardown is surgical** — one access-policy statement, one index, one role mapping. No CSD-side cleanup required if our script runs first.
