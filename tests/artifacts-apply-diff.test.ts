import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acceptDiffInWorkspace, extractDiffTargetPaths } from '../apps/server/src/routes/artifacts'

const NEW_INDEX_DIFF = `diff --git a/index.html b/index.html
new file mode 100644
index 0000000..6b584e8
--- /dev/null
+++ b/index.html
@@ -0,0 +1 @@
+<main>Hello</main>
`

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
  }
  return stdout
}

describe('artifact diff acceptance', () => {
  test('extracts target paths from a new-file diff', () => {
    expect(extractDiffTargetPaths(NEW_INDEX_DIFF)).toEqual(['index.html'])
  })

  test('stages an already materialized new file instead of applying the patch again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-apply-diff-existing-'))
    await git(root, ['init'])
    writeFileSync(join(root, 'index.html'), '<main>Hello</main>\n', 'utf8')

    const result = await acceptDiffInWorkspace(root, NEW_INDEX_DIFF)
    const staged = await git(root, ['diff', '--cached', '--name-only'])

    expect(result.appliedPatch).toBe(false)
    expect(result.stagedFiles).toEqual(['index.html'])
    expect(staged.trim()).toBe('index.html')
  })

  test('applies and stages a patch that has not landed in the workspace yet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-apply-diff-missing-'))
    await git(root, ['init'])

    const result = await acceptDiffInWorkspace(root, NEW_INDEX_DIFF)
    const staged = await git(root, ['diff', '--cached', '--name-only'])

    expect(result.appliedPatch).toBe(true)
    expect(result.stagedFiles).toEqual(['index.html'])
    expect(staged.trim()).toBe('index.html')
    expect(existsSync(join(root, 'index.html'))).toBe(true)
    expect(readFileSync(join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n')).toBe('<main>Hello</main>\n')
  })
})
