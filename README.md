# POC: Cognito → IAM Permission Inheritance

A disposable demo validating whether CloudSee Drive can inherit S3 permissions directly from AWS IAM (via a Cognito Identity Pool) instead of maintaining a second permission system inside the app. Built in AWS account **592920047652**, us-east-1, runs ~$5/month.

- **Architecture:** [`docs/architecture.md`](docs/architecture.md) (base) and [`docs/opensearch-architecture.md`](docs/opensearch-architecture.md) (v2 extension)
- **Walkthrough:** [`docs/demo-script.md`](docs/demo-script.md)

> **Status:** Deployed and smoke-tested end-to-end. Browse + Search both served from CSD's real UAT OpenSearch index, filtered by each user's IAM-derived scope. S3 is only touched for presigned GET/PUT URLs.

---

## What this proves

CSD today:
- Authenticates users via Cognito
- Enforces S3 access through its own DynamoDB-backed permission system (account + bucket grants)

Admins configure permissions twice — once in AWS IAM for engineers/scripts, once in CSD for end users — and the two drift.

This POC validates a simpler model: federate each Cognito user to a per-group IAM role via a Cognito Identity Pool. In the S3 path, S3 enforces natively. In the OpenSearch path, the server resolves each user's effective scope at login (by probing `ListObjectsV2` with their assumed creds), caches it per token, and injects it as a `bool.filter` on every query. IAM remains the source of truth end-to-end, even though OpenSearch has no idea what IAM is.

A runtime admin toggle flips between **IAM-inherited** mode (as above) and **Custom** mode (CSD's current app-layer JSON permission table). Same user, same UI, different filter source.

---

## Live demo

**URL:** http://ec2-54-158-15-145.compute-1.amazonaws.com (HTTP only, disposable)

### Demo users

All four users share the password **`Poc-Demo-123`** (set permanent via `admin-set-user-password` — no first-login challenge).

| Username | Email | Cognito group | IAM role | AWS access |
|---|---|---|---|---|
| `alice` | alice@poc.local | `readonly-all` | `poc-csd-readonly-all` | Read on all 5 demo buckets |
| `bob` | bob@poc.local | `rw-bucket-a` | `poc-csd-rw-bucket-a` | Read + write on `cloudsee-demo` only |
| `carol` | carol@poc.local | `readonly-prefix-x` | `poc-csd-readonly-prefix-x` | Read on `cloudsee-demo-1` scoped to `Dogs1/*` only |
| `admin` | admin@poc.local | `admin` | (no IAM mapping — fallback denies S3) | Admin page only: toggle IAM ↔ Custom, edit custom-mode JSON |

Carol's role uses an `s3:prefix` condition on `s3:ListBucket`. She can only list under `Dogs1/` — that's the folder-level-permissions pattern CSD is planning for production (CSD-537).

### Real buckets

All five live in 592920047652 and are indexed by Fast Buckets in the existing `aws_account_592920047652_uat_active` OpenSearch index (58M docs total):

| Bucket | Docs indexed | Structure |
|---|---|---|
| `cloudsee-demo` | 819 | Folders at root: Birds/, Dogs/, Exotic Cars/, Extract/, File Types/, SMH/ + surf-001..004.jpg |
| `cloudsee-demo-1` | 77 | Dogs1/, Puppies/ subfolders (Parent values inconsistent — some with leading slash) |
| `cloudsee-demo-2` | 19 | Small; Ferrari/ folder |
| `s3-file-1000k` | 1,000,002 | Large test dataset |
| `henry-drive-test-1000k` | 3,257,274 | Large test dataset |

### Expected behavior in IAM mode

Browse (folder-level listing via OpenSearch):

| Path | alice | bob | carol |
|---|---|---|---|
| Bucket list (`/api/buckets`) | All 5 | `cloudsee-demo` only | `cloudsee-demo-1` only |
| `cloudsee-demo/` root | 9 folders + 4 files | same | empty |
| `cloudsee-demo-1/` root | folders (incl. Dogs1/, Puppies/) + files | empty | Dogs1/ subfolder only |
| `cloudsee-demo-1/Dogs1/` | 21 files + Puppies/ | empty | 21 files + Puppies/ |
| `cloudsee-demo-1/Puppies/` | 16 files | empty | empty |

Search (free-text over the real index):

| Query | alice | bob | carol | Why carol is what she is |
|---|---|---|---|---|
| `surf` | 8 | 8 (cloudsee-demo only) | **0** | No `surf*` under `Dogs1/` |
| `beagle` | 13 | 4 | **3** | Only `Dogs1/beagle-*` + `Dogs1/Puppies/Beagle-002` |
| `ferrari` | 22 | 9 | **0** | Ferrari files exist but not under `Dogs1/` |
| `puppies` | 63 | 26 | **9** | Only `Dogs1/Puppies/*` |

Upload:
- alice → 403 on every bucket (read-only role)
- bob → succeeds on `cloudsee-demo`, 403 elsewhere
- carol → 403 everywhere (read-only role; no `s3:PutObject`)

**Proof the filter is the gate:** set `SEARCH_BYPASS_SCOPE=1` in the server env and restart. Carol's `ferrari` search now returns 22 results — the same as alice. That demonstrates the scope filter is the only thing keeping her from the rest of the index; turn it off and OpenSearch returns everything the instance role has read access to.

Full walkthrough in [`docs/demo-script.md`](docs/demo-script.md).

---

## Layout

| Dir | Purpose |
|---|---|
| `cdk/` | AWS CDK v2 (TypeScript). Three stacks: `PocCsd-S3`, `PocCsd-Auth`, `PocCsd-Ec2`. |
| `server/` | Express + TypeScript, AWS SDK v3. Cognito login, Identity Pool creds exchange, scope resolver, OpenSearch-backed Browse and Search. |
| `web/` | Vite + React. Login / Browse / Search / Admin pages. |
| `scripts/` | `bootstrap-opensearch.sh`, `seed-opensearch.sh`, `teardown-opensearch.sh`, `deploy.sh`, `seed-users.sh`, `teardown.sh`. |
| `docs/` | Architecture, OpenSearch extension design, demo script. |

## Setup (fresh bring-up)

Prereqs: Node 20+, AWS CLI v2, CDK bootstrap present in the target account/region (v31, us-east-1).

```bash
npm install

export AWS_PROFILE=poc-csd                       # POC-deploy creds
export MASTER_AWS_PROFILE=csd-opensearch-master  # UAT OpenSearch master user
export AWS_REGION=us-east-1

npm run deploy:infra                # CDK: S3, Auth, Ec2
npm run seed:users                  # creates alice/bob/carol/admin
bash scripts/bootstrap-opensearch.sh  # UAT access policy + OpenSearch role + backend role mapping
npm run build && npm run deploy:app # ships server + web to EC2 via SSM
```

The EC2 public URL prints as `PocCsd-Ec2.AppUrl` in the CDK output. All four demo users have passwords set permanently by `seed-users.sh`; no first-login challenge.

## Dev loop (local, hits real AWS)

```bash
export AWS_PROFILE=poc-csd
npm run dev:server   # :3000
npm run dev:web      # :5173   (proxies /api and /auth to :3000)
```

## Known infra constraints

- **HTTP only**, password authenticated. Do not use with real users — put CloudFront + ACM in front before that.
- Account is at the 5-VPC limit. POC EC2 lives in the **CloudSeeDrive-UAT** VPC public subnet (not a new VPC) so it can reach the UAT OpenSearch VPC endpoint directly. Override via CDK context: `cdk deploy -c vpcId=... -c subnetId=... -c az=...`.
- UAT OpenSearch access policy has one extra `PocCsdOpenSearchAccess` statement for the POC instance role ARN. Reversed by `teardown-opensearch.sh`.

## Teardown

Always OpenSearch first (the UAT domain state needs to be reverted while the POC EC2 is still up — it's the only SSM path in):

```bash
export AWS_PROFILE=poc-csd
export MASTER_AWS_PROFILE=csd-opensearch-master

bash scripts/teardown-opensearch.sh    # reverts UAT access policy + removes POC OpenSearch role
npm run teardown                        # destroys PocCsd-* CloudFormation stacks

# Clean up the IAM access key on the master user (created during bootstrap)
aws iam list-access-keys --user-name webapper-cloudsee-opensearch --profile poc-csd
aws iam delete-access-key --user-name webapper-cloudsee-opensearch --access-key-id <the temp one>

# Finally, delete the deploy IAM user (davids-claude4) and its access key
```

Confirm in the AWS console afterwards:
- CloudFormation: no `PocCsd-*` stacks
- S3: only `poc-csd-deploy-*` had existed and it's gone
- Cognito: no `poc-csd-users` user pool, no `poc_csd_identity_pool`
- IAM: no `poc-csd-*` roles
- EC2: no `poc-csd-app` instance
- OpenSearch `cloudseedrive-uat`: access policy has one principal (`user/webapper-cloudsee-opensearch`); no `poc_csd_rw` role; `poc-csd-objects` index removed
