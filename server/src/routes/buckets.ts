import { Router } from 'express';
import { requireAuth } from '../middleware';
import { getScheme } from '../scheme-store';
import { resolveScope } from '../scope';
import { listFolder, bucketsInScope } from '../opensearch-list';
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
  try {
    const scope = await resolveScope(req.user!.username, req.idToken!);
    res.json({ scheme: scope.source, buckets: bucketsInScope(scope) });
  } catch (e: any) { handleError(res, e); }
});

bucketsRouter.get('/buckets/:bucket/objects', async (req, res) => {
  const prefix = (req.query.prefix as string | undefined) ?? '';
  const bucket = req.params.bucket;
  try {
    const scope = await resolveScope(req.user!.username, req.idToken!);
    const listing = await listFolder(scope, bucket, prefix);
    res.json({ scheme: scope.source, bucket, prefix, ...listing });
  } catch (e: any) { handleError(res, e); }
});

bucketsRouter.get('/buckets/:bucket/presigned-get', async (req, res) => {
  const key = req.query.key as string;
  const bucket = req.params.bucket;
  if (!key) return res.status(400).json({ error: 'key required' }) as any;
  try {
    const scheme = await getScheme();
    if (scheme === 'iam') {
      // IAM mode: presign with the user's own assumed creds. S3 enforces.
      const creds = await getCredentialsForIdToken(req.idToken!);
      res.json({ url: await s3iam.presignGet(creds, bucket, key) });
    } else {
      // Custom mode: the scope filter in the listing already gated visibility;
      // presign with the instance role so the user can actually download.
      res.json({ url: await s3custom.presignGet(bucket, key) });
    }
  } catch (e: any) { handleError(res, e); }
});

bucketsRouter.post('/buckets/:bucket/presigned-put', async (req, res) => {
  const { key, contentType } = req.body ?? {};
  const bucket = req.params.bucket;
  if (!key) return res.status(400).json({ error: 'key required' }) as any;
  try {
    const scheme = await getScheme();
    if (scheme === 'iam') {
      const creds = await getCredentialsForIdToken(req.idToken!);
      res.json({ url: await s3iam.presignPut(creds, bucket, key, contentType) });
    } else {
      res.json({ url: await s3custom.presignPut(bucket, key, contentType) });
    }
  } catch (e: any) { handleError(res, e); }
});

function handleError(res: any, e: any): void {
  const status = e?.status ?? (e?.$metadata?.httpStatusCode === 403 ? 403 : 500);
  res.status(status).json({ error: e.name ?? 'Error', message: e.message ?? String(e) });
}
