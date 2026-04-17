# POC: Cognito → IAM Permission Inheritance

A disposable demo validating whether CloudSee Drive can inherit S3 permissions directly from AWS IAM (via a Cognito Identity Pool) instead of maintaining a second permission system inside the app. Built in AWS account **592920047652**, us-east-1, runs ~$5/month.

- **Design:** [`docs/architecture.md`](docs/architecture.md)
- **Walkthrough:** [`docs/demo-script.md`](docs/demo-script.md)

> **Status:** deployed and smoke-tested. Same account, runtime admin toggle between IAM-inherited and app-layer-custom permission schemes. See *Current deployment* below.

---

## Why this exists

CSD today:
- Authenticates users via Cognito.
- Enforces S3 access through its own DynamoDB-backed permission system (account + bucket grants).

That means admins configure permissions twice — once in AWS IAM for engineers/scripts, once in CSD for end users — and the two drift. This POC tests a simpler model: **let S3 enforce IAM natively**, federating each Cognito user to their mapped IAM role via a Cognito Identity Pool. For comparison, it also keeps the app-layer custom model, togglable at runtime.

## Two modes, one toggle

### IAM-inherited (proving the new model)

```
User → Cognito User Pool (login)
     → ID token
     → Cognito Identity Pool (GetCredentialsForIdentity, mapped by Cognito group → IAM role)
     → Temp AWS creds scoped to that role
     → App calls S3 with user's own creds
     → S3 enforces IAM natively. Zero permission logic in the app.
```

### Custom (mirroring CSD today)

```
User → Cognito login
     → App uses EC2 instance role (broad S3 access)
     → App filters results against per-user JSON permission table
     → User sees filtered results
```

The `admin` user flips between them on a single settings screen.

## Layout

| Dir | Purpose |
|---|---|
| `cdk/` | AWS CDK v2 (TypeScript). Three stacks: `PocCsd-S3`, `PocCsd-Auth`, `PocCsd-Ec2`. |
| `server/` | Express + TypeScript, AWS SDK v3. Cognito login, Identity Pool creds exchange, S3 paths, admin routes. |
| `web/` | Vite + React. Login / Browse / Admin pages, runtime scheme toggle. |
| `scripts/` | `deploy.sh`, `seed-users.sh`, `seed-s3.sh`, `teardown.sh`. |
| `docs/` | Architecture and demo script. |

## Setup

Prereqs: Node 20+, AWS CLI v2, CDK bootstrap already in the target account/region (v31, us-east-1 is present).

```bash
npm install

export AWS_PROFILE=poc-csd          # dedicated profile; never commit keys
export AWS_REGION=us-east-1

npm run deploy:infra                # ~5 min first run
npm run seed:users                  # alice, bob, carol, admin
npm run seed:s3                     # sample objects incl. bucket-b/{x,y}
npm run deploy:app                  # builds + ships to EC2 via SSM
```

The public URL prints as `PocCsd-Ec2.AppUrl` in the CDK outputs. Demo users all use temp password `Temp-Poc-123` on first login; the UI walks them through the `NEW_PASSWORD_REQUIRED` challenge.

## Dev loop (local, real AWS)

```bash
export AWS_PROFILE=poc-csd
npm run dev:server   # :3000
npm run dev:web      # :5173   (proxies /api and /auth to :3000)
```

## Known infra constraints (documented, not blockers)

- Account is at its 5-VPC limit (CSD prod/UAT/test VPCs occupy all 5). POC EC2 lands in the **CloudSeeDrive-Test** VPC public subnet — the VPC itself is untouched, only a net-new SG + instance. Change via CDK context: `cdk deploy -c vpcId=... -c subnetId=... -c az=...`.
- HTTP only. Passwords cross the wire in plaintext. Not production-safe. Add CloudFront + ACM before any real use.
- Prefix-conditioned `s3:ListBucket` policies don't satisfy `HeadBucket`, so the bucket-discovery UI shows all configured buckets and lets S3 403 on list/get. A "jump to prefix" input handles the case where the root listing is denied (carol's flow).

## Current deployment

Live while this POC is in active use; run `npm run teardown` to remove.

- **App URL** (HTTP, ephemeral EC2 DNS): printed as `PocCsd-Ec2.AppUrl` after deploy
- **AWS account**: 592920047652 / us-east-1
- **Demo users**: `alice` (readonly-all), `bob` (rw-bucket-a), `carol` (readonly-prefix-x), `admin`
- **Password** (set permanently on all four for demo): `Poc-Demo-123`

## Teardown

```bash
npm run teardown
```

Empties the 4 buckets and runs `cdk destroy --all`. Verify in the console that no `PocCsd-*` stacks or `poc-csd-*` resources remain, then delete the POC IAM user and its access key.

## Branches

- `main` — baseline POC, Cognito→IAM→S3. Approved demo, runs in CloudSeeDrive-Test VPC.
- `opensearch-extension` — same POC + a `/search` page that queries the existing `cloudseedrive-uat` OpenSearch domain, filtered by each user's IAM-derived scope. Deploys to the CloudSeeDrive-UAT VPC so it can reach the VPC endpoint. Design in [`docs/opensearch-architecture.md`](docs/opensearch-architecture.md).

### Bringing up the OpenSearch extension

```bash
git checkout opensearch-extension
npm install

# Redeploy EC2 into UAT VPC (Test-VPC EC2 is destroyed in the same step)
export AWS_PROFILE=poc-csd
npm run deploy:infra

# Bootstrap UAT OpenSearch: access policy + index + role mapping.
# Requires a second profile that authenticates as the UAT master user.
export MASTER_AWS_PROFILE=csd-opensearch-master
bash scripts/bootstrap-opensearch.sh

# Seed the index and ship the app
bash scripts/seed-opensearch.sh
npm run deploy:app
```

Reverse order to remove:

```bash
bash scripts/teardown-opensearch.sh   # BEFORE cdk destroy, needs MASTER_AWS_PROFILE
npm run teardown
```

`main` remains the clean demo; the extension is PR'd separately so the UAT-touching changes are reviewed before merge.
