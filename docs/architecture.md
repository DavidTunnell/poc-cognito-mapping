# Architecture

## Purpose

Prove that CloudSee Drive can use AWS IAM — not its own in-app permission system — as the source of truth for S3 access. The POC runs standalone in account `592920047652`, has no connection to real CSD infrastructure, and is expected to be torn down in days.

## Two modes, one toggle

The same user sees different data depending on the active scheme:

### IAM-inherited mode

```
Browser ──password──▶ Server /auth/login
                      │
                      └──InitiateAuth──▶ Cognito User Pool
                                          │
                                         ID token
                      ◀──ID token─────────┘
Browser ─Bearer token─▶ Server /api/buckets
                         │
                         ├─GetId────────▶ Cognito Identity Pool
                         ├─GetCredentialsForIdentity
                         │                (role mapping by token:
                         │                 Cognito group → IAM role)
                         ◀──temp AWS creds─┘
                         │
                         └─HeadBucket/ListObjectsV2 with those creds──▶ S3
                                                                         │
                                                                       IAM policy
                                                                       enforced here
```

No permission logic in the app. S3 returns 403 when IAM says so; that 403 bubbles all the way to the UI.

### Custom mode (mirrors CSD today)

```
Browser ─Bearer token─▶ Server /api/buckets
                         │
                         ├─reads data/custom-permissions.json
                         │
                         └─ListObjectsV2 with EC2 instance role (broad access)──▶ S3
                            │
                          Filter results by user's allowed prefixes
                            │
                            ▶ Browser
```

The app decides who sees what. IAM on the role is wide open; the filter is the gate.

### Switching

`PUT /api/admin/scheme { scheme: "iam" | "custom" }` writes a single JSON file. The very next `/api/buckets` request branches on it. No redeploy.

## AWS resources

| Resource | Name / scope | Notes |
|---|---|---|
| Cognito User Pool | `poc-csd-users` | email+password; admin-created users only |
| Cognito groups | `readonly-all`, `rw-bucket-a`, `readonly-prefix-x`, `admin` | each maps to an IAM role except `admin` |
| Cognito Identity Pool | `poc_csd_identity_pool` | role mapping type = Token, so `cognito:preferred_role` in the ID token picks the IAM role |
| IAM role | `poc-csd-readonly-all` | `s3:Get*`, `s3:List*` on buckets a/b/c |
| IAM role | `poc-csd-rw-bucket-a` | full read+write on bucket a |
| IAM role | `poc-csd-readonly-prefix-x` | read on `cloudsee-demo-1/Dogs1/*` only; `ListBucket` conditioned on `s3:prefix` starting with `x/` |
| IAM role | `poc-csd-default-authenticated` | fallback; explicit deny on `s3:*` |
| S3 bucket | `poc-csd-bucket-a-<account>` | seed objects at root + `proj/` |
| S3 bucket | `poc-csd-bucket-b-<account>` | seed objects under `x/` and `y/` |
| S3 bucket | `poc-csd-bucket-c-<account>` | seed objects; used by the custom-mode demo |
| S3 bucket | `poc-csd-deploy-<account>` | holds `app.tar.gz`; 7-day lifecycle |
| EC2 instance | `t4g.nano`, AL2023 ARM | instance role has broad S3 on the 3 buckets (custom mode) + SSM + Cognito admin ops |

Account `592920047652`, region `us-east-1`. CDK bootstrap v31 is already in place.

## Code layout

| Path | Purpose |
|---|---|
| `cdk/lib/s3-stack.ts` | 3 demo buckets + deploy bucket, all with `autoDeleteObjects` for clean teardown |
| `cdk/lib/auth-stack.ts` | User Pool, Identity Pool, IAM roles, Cognito groups, role attachment |
| `cdk/lib/ec2-stack.ts` | VPC (1 AZ public), SG (80 open), EC2 + user data (Node.js, systemd unit, deploy helper) |
| `server/src/iam-credentials.ts` | `GetId` + `GetCredentialsForIdentity` — the heart of IAM-mode |
| `server/src/s3-iam.ts` | S3 client built per-request with user's assumed creds |
| `server/src/s3-custom.ts` | S3 client using the instance role; filters results via the permission JSON |
| `server/src/scheme-store.ts` | JSON-file storage for the active scheme + custom perms |
| `server/src/routes/buckets.ts` | Single entrypoint that branches on scheme |
| `server/src/routes/admin.ts` | Scheme toggle, custom permissions editor, user/group listings |
| `web/src/pages/Admin.tsx` | UI for the toggle + JSON editor for custom perms |

## Why this design

1. **No permission logic in app code when IAM is on.** If IAM changes in the console, the POC picks it up immediately — no re-deploy, no DynamoDB edit. This is the entire point.
2. **Cognito group → IAM role via token-type role mapping.** The `roleArn` set on each Cognito group is encoded into the ID token as `cognito:preferred_role`; the Identity Pool uses that claim. Admins in the Cognito console can move users between groups and perms move with them.
3. **JSON-file storage (not DynamoDB).** Scheme + custom perms change rarely. A file on disk is trivial to reason about for a POC, and trivially replaceable later.
4. **Two-mode runtime toggle.** Forces the architectural comparison onto one screen. Same user, two behaviors — the tradeoff between "IAM-drives-S3" and "app-drives-S3" becomes concrete.

## Known POC limitations

- **HTTP only.** Passwords cross the wire in plaintext. Do not run with real users. Add TLS via CloudFront + ACM before anything real.
- **No refresh-token handling on the client.** When the ID token expires (1h), the user has to log in again.
- **HeadBucket per bucket to check access.** Works for 3 buckets. For CSD-scale (hundreds of buckets), swap for a cached policy simulation or a maintained allowlist.
- **Custom-mode prefix filter is simple.** It mirrors the `startsWith` semantics from CSD's folder-permissions analysis but doesn't implement the full ID-based pointer model (CSD-537). Deliberately out of scope.
- **No audit logging.** Real CSD should log who saw what via which scheme; POC does not.

## Applicability to CSD

- **IAM-inherited mode is a plausible path for the "inherit existing IAM" admin request.** Admins who already maintain IAM per engineer/group would stop double-entering permissions in CSD.
- **Custom mode remains valuable for non-IAM tenants.** Customers without mature IAM hygiene, or with their own external identity system, need the app-layer model.
- **The toggle is probably the shipping answer.** Per-tenant configuration, default `custom` for legacy tenants, opt-in `iam` for tenants that want it. The POC validates this is cleanly separable.
- **Folder-level perms (CSD-537) compose with both modes.** In IAM mode, folder restrictions are baked into the IAM policy. In custom mode, they go into the JSON table. Same union semantics either way.
