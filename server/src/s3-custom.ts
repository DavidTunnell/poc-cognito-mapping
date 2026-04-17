import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config';
import { UserPerm, keyAllowedByPerm, canWriteByPerm } from './scheme-store';

// Uses the default credential chain — i.e. the EC2 instance role.
const c = new S3Client({ region: config.region });

/**
 * In custom mode the app is the source of truth. We use the instance role
 * (which has broad read/write to the 3 demo buckets) and filter results against
 * the per-user allowlist from custom-permissions.json.
 */
export function listAccessibleBuckets(perm: UserPerm): string[] {
  return Object.keys(perm.buckets);
}

export async function listObjects(perm: UserPerm, bucket: string, prefix?: string) {
  const bucketPerm = perm.buckets[bucket];
  if (!bucketPerm) throw new HttpError(403, 'No access to bucket');

  const res = await c.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    Delimiter: '/',
    MaxKeys: 1000,
  }));

  const prefixes = (res.CommonPrefixes ?? [])
    .map(p => p.Prefix ?? '')
    .filter(p => keyAllowedByPerm(bucketPerm, p) || bucketPerm.prefixes.some(allow => allow.startsWith(p)));

  const objects = (res.Contents ?? [])
    .filter(o => keyAllowedByPerm(bucketPerm, o.Key ?? ''))
    .map(o => ({
      key: o.Key ?? '',
      size: o.Size ?? 0,
      lastModified: o.LastModified?.toISOString(),
    }));

  return { prefixes, objects };
}

export async function presignGet(perm: UserPerm, bucket: string, key: string): Promise<string> {
  const bucketPerm = perm.buckets[bucket];
  if (!bucketPerm || !keyAllowedByPerm(bucketPerm, key)) throw new HttpError(403, 'Not allowed');
  return getSignedUrl(c, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 });
}

export async function presignPut(perm: UserPerm, bucket: string, key: string, contentType?: string): Promise<string> {
  const bucketPerm = perm.buckets[bucket];
  if (!bucketPerm || !canWriteByPerm(bucketPerm, key)) throw new HttpError(403, 'Not allowed');
  return getSignedUrl(c, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: 300 });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
