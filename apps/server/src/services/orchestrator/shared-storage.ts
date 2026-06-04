import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { agentHubUserDataRoot, safePathSegment } from '../system-paths'

export interface SharedObjectRef {
  storageProvider: 'local-filesystem' | 's3'
  bucket: string
  objectKey: string
  storagePath: string
  size: number
  checksum: string
  mimeType: string
}

export async function putSharedObject(input: {
  objectKey: string
  content: string
  mimeType?: string
}): Promise<SharedObjectRef> {
  const bucket = sharedStorageBucket()
  const objectKey = normalizeObjectKey(input.objectKey)
  const content = input.content
  const size = Buffer.byteLength(content, 'utf8')
  const checksum = createHash('sha256').update(content).digest('hex')
  const mimeType = input.mimeType ?? 'text/plain; charset=utf-8'

  if (useS3ObjectStore()) {
    await s3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: content,
        ContentType: mimeType,
        Metadata: {
          checksum,
        },
      }),
    )
    return {
      storageProvider: 's3',
      bucket,
      objectKey,
      storagePath: `s3://${bucket}/${objectKey}`,
      size,
      checksum,
      mimeType,
    }
  }

  const storagePath = localObjectPath(bucket, objectKey)
  mkdirSync(dirname(storagePath), { recursive: true })
  writeFileSync(storagePath, content, 'utf8')
  return {
    storageProvider: 'local-filesystem',
    bucket,
    objectKey,
    storagePath,
    size,
    checksum,
    mimeType,
  }
}

export function sharedTaskObjectKey(taskId: string, fileName: string) {
  return ['shared', 'tasks', safePathSegment(taskId), safePathSegment(fileName)].join('/')
}

function sharedStorageBucket() {
  return process.env.AGENTHUB_S3_BUCKET?.trim() || process.env.AGENTHUB_ARTIFACT_BUCKET?.trim() || 'agenthub-artifacts'
}

function useS3ObjectStore() {
  return (process.env.AGENTHUB_OBJECT_STORE_PROVIDER ?? '').trim().toLowerCase() === 's3'
}

function localObjectPath(bucket: string, objectKey: string) {
  const parts = objectKey
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((part) => safePathSegment(part))
  return join(agentHubUserDataRoot(), 'storage', 'objects', safePathSegment(bucket), ...parts)
}

function normalizeObjectKey(value: string) {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((part) => safePathSegment(part))
    .join('/')
}

let cachedS3Client: S3Client | null = null

function s3Client() {
  if (cachedS3Client) return cachedS3Client
  const endpoint = process.env.AGENTHUB_S3_ENDPOINT?.trim()
  const accessKeyId = process.env.AGENTHUB_S3_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.AGENTHUB_S3_SECRET_ACCESS_KEY?.trim()
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'SharedStorage S3/MinIO requires AGENTHUB_S3_ENDPOINT, AGENTHUB_S3_ACCESS_KEY_ID, and AGENTHUB_S3_SECRET_ACCESS_KEY.',
    )
  }
  cachedS3Client = new S3Client({
    endpoint,
    region: process.env.AGENTHUB_S3_REGION?.trim() || 'us-east-1',
    forcePathStyle: process.env.AGENTHUB_S3_FORCE_PATH_STYLE !== 'false',
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  })
  return cachedS3Client
}
