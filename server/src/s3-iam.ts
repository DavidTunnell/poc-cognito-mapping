import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AwsCredentialIdentity } from '@aws-sdk/types';
import { config, allBuckets } from './config';

function client(creds: AwsCredentialIdentity): S3Client {
  return new S3Client({ region: config.region, credentials: creds });
}

/**
 * In IAM mode the source of truth is the user's assumed IAM role. We return
 * all configured POC buckets; S3 itself enforces access at list/get/put time.
 *
 * We deliberately do NOT pre-check with HeadBucket: a prefix-conditioned
 * s3:ListBucket policy (e.g. carol's "only x/* allowed") does not satisfy
 * HeadBucket, which would hide the bucket from her entirely even though she
 * has legitimate access inside a prefix. Show the bucket, let IAM speak when
 * she tries to list or read.
 */
export async function listAccessibleBuckets(_creds: AwsCredentialIdentity): Promise<string[]> {
  return allBuckets();
}

export async function listObjects(creds: AwsCredentialIdentity, bucket: string, prefix?: string) {
  const c = client(creds);
  const res = await c.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    Delimiter: '/',
    MaxKeys: 1000,
  }));
  return {
    prefixes: (res.CommonPrefixes ?? []).map(p => p.Prefix ?? ''),
    objects: (res.Contents ?? []).map(o => ({
      key: o.Key ?? '',
      size: o.Size ?? 0,
      lastModified: o.LastModified?.toISOString(),
    })),
  };
}

export async function presignGet(creds: AwsCredentialIdentity, bucket: string, key: string): Promise<string> {
  const c = client(creds);
  return getSignedUrl(c, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 });
}

export async function presignPut(
  creds: AwsCredentialIdentity,
  bucket: string,
  key: string,
  contentType?: string,
): Promise<string> {
  const c = client(creds);
  return getSignedUrl(c, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: 300 });
}
