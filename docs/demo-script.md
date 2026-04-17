# Demo script

Ten-minute walkthrough. Run in order. Copy-paste friendly.

## Before you start

```bash
export AWS_PROFILE=poc-csd
export AWS_REGION=us-east-1
```

All three demo users share the same temp password: **`Temp-Poc-123`**. On first login the UI will force a new one.

Open the app URL from `cdk deploy` output (printed as `PocCsd-Ec2.AppUrl`). Keep the AWS console open in a second tab — IAM → Roles and S3 → Buckets — to prove no trickery.

## Part 1 — IAM-inherited mode (default)

### alice (readonly-all) — should see everything, write nothing

1. Log in as `alice@poc.local`. Set new password.
2. Header shows **IAM** badge.
3. Browse → you see **all three buckets**.
4. Click `poc-csd-bucket-a-...` → seed objects appear.
5. Try to upload any file → **403**. Message comes from S3, not the app.
6. Download an object → works.

**What this proves:** alice is in the Cognito group `readonly-all`, which maps to the IAM role `poc-csd-readonly-all`. That role has `s3:Get*` + `s3:List*` across all three buckets, no `s3:PutObject`. S3 enforced the upload denial. The app never checked.

### bob (rw-bucket-a) — single-bucket read/write

1. Log out. Log in as `bob@poc.local`.
2. Browse → you see **only `poc-csd-bucket-a-...`**. Buckets B and C are absent.
3. Upload any file → **succeeds**.
4. It appears in the listing.

**What this proves:** bob's IAM role only permits access to bucket A. HeadBucket on B and C returned 403, so the UI filtered them out — but the "filter" is IAM.

### carol (readonly-prefix-x) — folder-level scoping

1. Log out. Log in as `carol` / `Poc-Demo-123`.
2. Browse → she sees all 3 buckets (the app doesn't pre-filter in IAM mode; IAM enforces at each op).
3. Click `poc-csd-bucket-a-...` → **403**. Her role has no access to this bucket. S3 speaks, app forwards.
4. Click `poc-csd-bucket-b-...` → **403 at root**. Her policy conditions `s3:ListBucket` on `s3:prefix` starting with `x/`, so root listing fails.
5. Type `x/` into the **jump to prefix** input and press Enter → objects appear: `permitted-1.txt`, `permitted-2.txt`, and the nested folder. Download works.
6. Try `y/` → **403**. Different prefix; IAM says no.

**What this proves:** the IAM role uses an `s3:prefix` condition on `ListBucket`. Carol can only list under `x/`. The 403 is coming from IAM — if you grep the server for any bucket/prefix allowlist, you'll find none. This is also a real UX consideration: prefix-conditioned roles require the UI to let users enter a prefix manually, because the bucket root itself is inaccessible.

### (Optional) Show the CLI parity

Using the ID token printed server-side (or retrieved from localStorage in dev tools), run:

```bash
# Exchange ID token for creds — or pull from devtools / server log
aws s3 ls s3://poc-csd-bucket-b-592920047652/y/ --profile carol-ephemeral
# → Access Denied
aws s3 ls s3://poc-csd-bucket-b-592920047652/x/ --profile carol-ephemeral
# → listing works
```

Same behavior on the CLI. IAM is the gate, not the app.

## Part 2 — Custom-app-perms mode

1. Log in as `admin@poc.local`.
2. Go to **Admin** → **Permission scheme** panel.
3. Click **Custom**. Header badge on every user session will now read **CUSTOM**.
4. In the **Custom permission table** panel, click **Generate template from current users & buckets**.
5. Edit the JSON so alice has access to **only `poc-csd-bucket-c-...` read-only**:
   ```json
   {
     "alice@poc.local": {
       "buckets": {
         "poc-csd-bucket-c-592920047652": { "prefixes": [], "access": "r" }
       }
     }
   }
   ```
6. Click **Save**.
7. Log out. Log in as alice.
8. Browse → she sees **only bucket C**, even though her IAM role still permits all three.

**What this proves:** custom mode bypasses IAM. The app is now the source of truth. Same user, same IAM permissions, completely different visibility — because the app filter says so.

## Part 3 — Switch back

1. Log in as admin. Admin → **IAM-inherited**.
2. Log in as alice. She sees all three buckets again.

**What this proves:** the toggle is live. No redeploy. No data migration. A tenant-level `scheme` field in the real CSD would let each customer choose.

## Teardown

```bash
npm run teardown
```

Confirm in the AWS console:
- CloudFormation: no `PocCsd-*` stacks
- S3: no `poc-csd-*` buckets
- Cognito: no `poc-csd-*` user/identity pools
- IAM: no `poc-csd-*` roles
- EC2: no `poc-csd-app` instance

Finally, **delete the `davids-claude4` IAM user** and its access key. The keys are done.
