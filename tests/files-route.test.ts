import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AppErrorCodes } from '../apps/server/src/lib/error'
import { resolveWorkspaceWritePath } from '../apps/server/src/routes/files'

describe('files route path resolution', () => {
  test('resolves workspace-relative paths inside the workspace root', () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-files-'))

    const result = resolveWorkspaceWritePath('index.html', root)

    expect(result.resolvedPath).toBe(resolve(root, 'index.html'))
  })

  test('allows absolute paths only when they stay inside the workspace root', () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-files-'))
    const absoluteFile = join(root, 'nested', 'index.html')

    const result = resolveWorkspaceWritePath(absoluteFile, root)

    expect(result.resolvedPath).toBe(resolve(absoluteFile))
  })

  test('rejects paths escaping the workspace root', () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-files-'))

    expect(() => resolveWorkspaceWritePath('../outside.html', root)).toThrow(
      expect.objectContaining({ code: AppErrorCodes.FILE_ACCESS_DENIED }),
    )
  })
})
