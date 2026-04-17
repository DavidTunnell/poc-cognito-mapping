# Demo script

Ten-minute walkthrough against real CloudSee UAT data. Copy-paste friendly.

## Before you start

- **App URL:** http://ec2-54-158-15-145.compute-1.amazonaws.com
- **Password for every demo user:** `Poc-Demo-123` (set permanent — no first-login challenge)

Open the AWS console in a second tab (IAM → Roles, S3 → `cloudsee-demo*` buckets, OpenSearch → `cloudseedrive-uat`) so you can prove the architecture as you go.

---

## Demo users

| Username | Cognito group | IAM role | What IAM grants them |
|---|---|---|---|
| `alice` | `readonly-all` | `poc-csd-readonly-all` | Read on all 5 demo buckets |
| `bob` | `rw-bucket-a` | `poc-csd-rw-bucket-a` | Full read+write on `cloudsee-demo` only |
| `carol` | `readonly-prefix-x` | `poc-csd-readonly-prefix-x` | Read on `cloudsee-demo-1` scoped to `Dogs1/*` |
| `admin` | `admin` | (none — fallback denies S3) | Admin page only |

The demo runs in **IAM-inherited mode** by default (admin can toggle).

---

## Part 1 — Browse, served by OpenSearch

Every listing in the UI is served from the real `aws_account_592920047652_uat_active` OpenSearch index. The app never hits S3 for listings; S3 is only touched when generating presigned GET/PUT URLs.

### alice — sees everything (baseline)

1. Log in as `alice`. Header badge reads **IAM**.
2. Click Browse. Bucket panel shows all 5: `cloudsee-demo`, `cloudsee-demo-1`, `cloudsee-demo-2`, `s3-file-1000k`, `henry-drive-test-1000k`.
3. Click `cloudsee-demo` → 9 folders + 4 `surf-*.jpg` files.
4. Click `cloudsee-demo-1` → Dogs1/, Puppies/, a few zip files, and Permission Matrix entries.
5. Click a file → opens in a new tab via a presigned GET URL signed by alice's own IAM creds.
6. Try to upload any file → **403 from S3**. Her IAM role has no `s3:PutObject`; S3 enforces directly, not the app.

### bob — single-bucket scope

1. Log out. Log in as `bob`.
2. Browse → bucket panel shows only `cloudsee-demo`. The other four are simply absent.
3. Click `cloudsee-demo` → same 9 folders + 4 files alice saw.
4. Try uploading → **succeeds** (his role has `PutObject` on this bucket).

> *Why the bucket list is filtered:* `resolveScope` probes each known bucket with bob's assumed creds at login. Only `cloudsee-demo` succeeds. Scope = `{cloudsee-demo: {allowedPrefixes: []}}`. `/api/buckets` returns the keys of his scope; the OpenSearch scope filter matches only that bucket.

### carol — prefix-conditioned scope

Carol's role uses an `s3:prefix` condition on `s3:ListBucket`. This is the production-shape folder-level permissions pattern (CSD-537).

1. Log out. Log in as `carol`.
2. Browse → bucket panel shows only `cloudsee-demo-1`.
3. Click it → root listing shows **only `Dogs1/`** (no Puppies/, no root-level files). Scope filter is the reason.
4. Click `Dogs1/` → 21 files + a `Puppies/` subfolder appear.
5. Navigate into `Dogs1/Puppies/` → contents visible (still within her scope).
6. Type `Puppies/` into "jump to prefix" (not Dogs1/Puppies — the top-level Puppies/) → **empty**. Her IAM role allows `Key.startsWith("Dogs1/")` only.

> *Why this proves inheritance:* her IAM policy is
> ```
> Allow s3:ListBucket on cloudsee-demo-1 when s3:prefix like "Dogs1/*" or "Dogs1/"
> Allow s3:GetObject on cloudsee-demo-1/Dogs1/*
> ```
> — and the scope filter on OpenSearch queries mirrors exactly that. Change the IAM policy in the AWS console, re-login, and the UI shape changes. No app deploy.

---

## Part 2 — Search, also served by OpenSearch, same filter

1. As alice, click **Search**. The "Your scope" panel shows all 5 buckets with empty `allowedPrefixes` (whole-bucket access).
2. Search `ferrari` → 22 hits across `cloudsee-demo/Exotic Cars/*`, `cloudsee-demo-2/Ferrari/*`, and a zip in `cloudsee-demo-1`.
3. Log out. As bob, search `ferrari` → **9 hits** (only from `cloudsee-demo/Exotic Cars/*`). The other 13 still exist in the index — bob's scope filter excludes them.
4. Log out. As carol, search `ferrari` → **0 hits**. No Ferrari objects live under `Dogs1/`, and her scope permits nothing else.

Try the same for `puppies`:

| User | Hits | Where |
|---|---|---|
| alice | 63 | Across all 5 buckets |
| bob | 26 | `cloudsee-demo/Dogs/Puppies/*` (his one bucket) |
| carol | 9 | `cloudsee-demo-1/Dogs1/Puppies/*` only |

### The proof test — bypass the filter

This is what makes the architectural point irrefutable.

1. On the EC2 (via SSM or local dev), set `SEARCH_BYPASS_SCOPE=1` and restart the server.
2. Log back in as carol. Search `ferrari` again → **22 hits**. Same results alice sees.

The entire security model for search was the scope filter. Remove it and OpenSearch returns every document the instance role can read. The IAM scope is the only thing separating carol's view from the full index.

Unset the env var and restart to return to normal behavior.

---

## Part 3 — Admin toggle: IAM ↔ Custom

1. Log in as `admin`. Open the Admin page.
2. Click **Custom** in the scheme toggle.
3. In the Custom permission table JSON, set carol's permissions to `cloudsee-demo-2` with no prefix restriction (whole bucket, read-only):
   ```json
   {
     "carol": {
       "buckets": {
         "cloudsee-demo-2": { "prefixes": [], "access": "r" }
       }
     }
   }
   ```
4. Save. Log in as carol.
5. Browse → bucket list shows **`cloudsee-demo-2` only** (not `cloudsee-demo-1` — her IAM role is irrelevant now).
6. Search → only hits from `cloudsee-demo-2`.
7. Back to admin → toggle to **IAM-inherited**. Log in as carol again → she's back to `Dogs1/*` on `cloudsee-demo-1`.

> *Why this matters:* the same architecture supports both permission models. A tenant-level `scheme` field in real CSD would let each customer choose — IAM-inherited for customers with mature IAM, custom for customers using their own identity system.

---

## CLI parity check (optional but compelling)

The POC UI isn't running its own permission logic — IAM is. Prove it from the shell with carol's credentials:

```bash
# Exchange carol's ID token for AWS creds (print from devtools Network > login response)
export AWS_ACCESS_KEY_ID=...      # carol's assumed role temp AK
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...

aws s3 ls s3://cloudsee-demo-1/Dogs1/           # works
aws s3 ls s3://cloudsee-demo-1/Puppies/          # AccessDenied
aws s3 ls s3://cloudsee-demo/                    # AccessDenied
aws s3 ls s3://cloudsee-demo-1/                  # AccessDenied (no prefix → condition fails)
```

Same behavior as the UI, enforced entirely by IAM.

---

## Teardown (when done)

Always revert UAT state before destroying the POC EC2 (the instance is the only SSM path into UAT OpenSearch):

```bash
export AWS_PROFILE=poc-csd
export MASTER_AWS_PROFILE=csd-opensearch-master

bash scripts/teardown-opensearch.sh   # revert UAT access policy, delete poc_csd_rw role, drop poc-csd-objects
npm run teardown                       # destroys CloudFormation stacks

aws iam delete-access-key \
  --user-name webapper-cloudsee-opensearch \
  --access-key-id <the temp one from bootstrap>

# Delete the deploy IAM user too, if it was created just for this POC
aws iam delete-access-key --user-name davids-claude4 --access-key-id AKIA...
aws iam delete-user --user-name davids-claude4
```

Verify nothing lingers:
- CloudFormation: no `PocCsd-*` stacks
- Cognito: no `poc-csd-users` pool
- IAM: no `poc-csd-*` roles
- EC2: no `poc-csd-app` instance
- OpenSearch `cloudseedrive-uat`: access policy has one principal (the master user); no `poc_csd_rw` role
