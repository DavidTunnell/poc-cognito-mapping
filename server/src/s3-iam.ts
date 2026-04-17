import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AwsCredentialIdentity } from '@aws-sdk/types';
import { config } from './config';

/**
 * Helpers for generating presigned URLs against S3 using the user's own
 * assumed-role creds. S3 itself enforces whether the URL will succeed at
 * download/upload time — no app-layer permission check.
 *
 * Folder listing is no longer done against S3 directly; see opensearch-list.ts.
 */
function client(creds: AwsCredentialIdentity): S3Client {
  return new S3Client({ region: config.region, credentials: creds });
}

export async function presignGet(creds: AwsCredentialIdentity, bucket: string, key: string): Promise<string> {
  return getSignedUrl(client(creds), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 });
}

export async function presignPut(
  creds: AwsCredentialIdentity,
  bucket: string,
  key: string,
  contentType?: string,
): Promise<string> {
  return getSignedUrl(
    client(creds),
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn: 300 },
  );
}
