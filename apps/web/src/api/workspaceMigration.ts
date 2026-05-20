import { apiFetch } from './client'

export interface MigrationRoots {
  sourceRoot: string
  targetRoot: string
  maxFileBytes: number
  ignoredDirs: string[]
}

export interface MigrationFile {
  path: string
  size: number
  modifiedAt: string
  targetExists?: boolean
}

export interface MigrationPreview {
  path: string
  size: number
  modifiedAt?: string
  truncated?: boolean
  content: string
}

export interface MigrationCopyResult {
  sourcePath: string
  targetPath: string
  size?: number
  status: 'copied' | 'overwritten' | 'skipped' | 'failed'
  reason?: string
}

export async function fetchMigrationRoots(): Promise<MigrationRoots> {
  const res = await apiFetch('/api/workspaces/migration/roots')
  return res.json()
}

export async function fetchMigrationFiles(query: string): Promise<MigrationFile[]> {
  const search = new URLSearchParams({ root: 'source', query, limit: '260' })
  const res = await apiFetch(`/api/workspaces/migration/files?${search}`)
  const data = (await res.json()) as { items: MigrationFile[] }
  return data.items
}

export async function fetchMigrationPreview(path: string): Promise<MigrationPreview> {
  const search = new URLSearchParams({ root: 'source', path })
  const res = await apiFetch(`/api/workspaces/migration/preview?${search}`)
  return res.json()
}

export async function copyMigrationFiles(
  files: Array<{ sourcePath: string; targetPath: string }>,
  overwrite: boolean,
): Promise<MigrationCopyResult[]> {
  const res = await apiFetch('/api/workspaces/migration/copy', {
    method: 'POST',
    body: JSON.stringify({ files, overwrite }),
  })
  const data = (await res.json()) as { results: MigrationCopyResult[] }
  return data.results
}
