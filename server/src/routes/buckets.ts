import { Router } from 'express';
import { requireAuth } from '../middleware';
import { getScheme, getCustomPermissions, permForUser } from '../scheme-store';
import { getCredentialsForIdToken } from '../iam-credentials';
import * as s3iam from '../s3-iam';
import * as s3custom from '../s3-custom';

export const bucketsRouter = Router();

bucketsRouter.use(requireAuth);

bucketsRouter.get('/me', async (req, res) => {
  const scheme = await getScheme();
  res.json({
    username: req.user!.username,
    email: req.user!.email,
    groups: req.user!.groups,
    preferredRole: req.user!.preferredRole ?? null,
    scheme,
  });
});

bucketsRouter.get('/buckets', async (req, res) => {
  const scheme = await getScheme();
  try {
    if (scheme === 'iam') {
      const creds = await getCredentialsForIdToken(req.idToken!);
      const buckets = await s3iam.listAccessibleBuckets(creds);
      res.json({ scheme, buckets });
    } else {
      const all = await getCustomPermissions();
      const perm = permForUser(all, req.user!.username);
      res.json({ scheme, buckets: s3custom.listAccessibleBuckets(perm) });
    }
  } catch (e: any) {
    handleError(res, e);
  }
});

bucketsRouter.get('/buckets/:bucket/objects', async (req, res) => {
  const scheme = await getScheme();
  const prefix = (req.query.prefix as string | undefined) ?? undefined;
  const bucket = req.params.bucket;
  try {
    if (scheme === 'iam') {
      const creds = await getCredentialsForIdToken(req.idToken!);
      const listing = await s3iam.listObjects(creds, bucket, prefix);
      res.json({ scheme, bucket, prefix: prefix ?? '', ...listing });
    } else {
      const all = await getCustomPermissions();
      const perm = permForUser(all, req.user!.username);
      const listing = await s3custom.listObjects(perm, bucket, prefix);
      res.json({ scheme, bucket, prefix: prefix ?? '', ...listing });
    }
  } catch (e: any) {
    handleError(res, e);
  }
});

bucketsRouter.get('/buckets/:bucket/presigned-get', async (req, res) => {
  const scheme = await getScheme();
  const key = req.query.key as string;
  const bucket = req.params.bucket;
  if (!key) return res.status(400).json({ error: 'key required' }) as any;
  try {
    if (scheme === 'iam') {
      const creds = await getCredentialsForIdToken(req.idToken!);
      res.json({ url: await s3iam.presignGet(creds, bucket, key) });
    } else {
      const all = await getCustomPermissions();
      const perm = permForUser(all, req.user!.username);
      res.json({ url: await s3custom.presignGet(perm, bucket, key) });
    }
  } catch (e: any) {
    handleError(res, e);
  }
});

bucketsRouter.post('/buckets/:bucket/presigned-put', async (req, res) => {
  const scheme = await getScheme();
  const { key, contentType } = req.body ?? {};
  const bucket = req.params.bucket;
  if (!key) return res.status(400).json({ error: 'key required' }) as any;
  try {
    if (scheme === 'iam') {
      const creds = await getCredentialsForIdToken(req.idToken!);
      res.json({ url: await s3iam.presignPut(creds, bucket, key, contentType) });
    } else {
      const all = await getCustomPermissions();
      const perm = permForUser(all, req.user!.username);
      res.json({ url: await s3custom.presignPut(perm, bucket, key, contentType) });
    }
  } catch (e: any) {
    handleError(res, e);
  }
});

function handleError(res: any, e: any): void {
  const status = e?.status ?? (e?.$metadata?.httpStatusCode === 403 ? 403 : 500);
  res.status(status).json({ error: e.name ?? 'Error', message: e.message });
}
