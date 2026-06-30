/**
 * DO Spaces (S3-compatible) blob storage adapter. Raw filings, PDFs, audio, and
 * rendered artifacts live here; Postgres holds only the blob_ref key (spec §2, §7.1).
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

let client: S3Client | undefined;

function s3(): S3Client {
  if (!client) {
    const endpoint = process.env.SPACES_ENDPOINT;
    const accessKeyId = process.env.SPACES_KEY;
    const secretAccessKey = process.env.SPACES_SECRET;
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new Error("SPACES_ENDPOINT / SPACES_KEY / SPACES_SECRET are not configured");
    }
    client = new S3Client({
      region: process.env.SPACES_REGION ?? "us-east-1",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: false,
    });
  }
  return client;
}

function bucket(): string {
  const b = process.env.SPACES_BUCKET;
  if (!b) throw new Error("SPACES_BUCKET is not set");
  return b;
}

export async function putObject(
  key: string,
  body: string | Uint8Array | Buffer,
  contentType = "application/octet-stream",
): Promise<{ key: string }> {
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }));
  return { key };
}

export async function getObject(key: string): Promise<string> {
  const res = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return (await res.Body!.transformToString()) as string;
}

export async function getObjectBytes(key: string): Promise<Uint8Array> {
  const res = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return res.Body!.transformToByteArray();
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** For tests: reset the cached client so credential changes take effect. */
export function resetSpacesClient(): void {
  client = undefined;
}
