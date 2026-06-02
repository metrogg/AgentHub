import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { Buffer } from 'node:buffer'

export function staticPreviewUrl(cwd: string | undefined, path: string) {
  if (!cwd) return null
  const absolutePath = isAbsolute(path) ? path : resolve(cwd, path)
  return previewDirectoryUrl(absolutePath)
}

export function previewDirectoryUrl(filePath: string) {
  const absolutePath = resolve(filePath)
  const root = dirname(absolutePath)
  const entry = basename(absolutePath)
  return `/api/artifacts/preview-dir/${encodePreviewRoot(root)}/${encodeURIComponent(entry)}`
}

export function encodePreviewRoot(root: string) {
  return Buffer.from(resolve(root), 'utf8').toString('base64url')
}

export function decodePreviewRoot(value: string) {
  return resolve(Buffer.from(value, 'base64url').toString('utf8'))
}
