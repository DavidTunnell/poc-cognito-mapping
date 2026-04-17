import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config';

/**
 * Custom-mode presign helpers. Use the default credential chain (EC2 instance
 * role), since in custom mode the permission authority is the app, not IAM.
 * The scope filter in the listing query already gated what the user can see.
 *
 * Requires the instance role to have s3:GetObject/PutObject on the real buckets
 * — granted in cdk/lib/ec2-stack.ts.
 */
const c = new S3Client({ region: config.region });

export async function presignGet(bucket: string, key: string): Promise<string> {
  return getSignedUrl(c, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 });
}

export async function presignPut(bucket: string, key: string, contentType?: string): Promise<string> {
  return getSignedUrl(
    c,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn: 300 },
  );
}
