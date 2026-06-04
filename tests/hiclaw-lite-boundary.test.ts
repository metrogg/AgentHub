import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const sourceRoot = join(process.cwd(), 'apps/server/src')

describe('HiClaw-lite kernel boundary', () => {
  test('legacy execution chain modules do not exist', () => {
    // The old in-memory orchestrator stack has been deleted. Verify these
    // modules are not reintroduced as parallel control paths.
    const legacyModules = [
      'orchestrator-engine.ts',
      'task-execution-service.ts',
      'local-a2a-transport.ts',
      'task-scheduler.ts',
      'task-graph.ts',
      'replanning-engine.ts',
      'synthesizer.ts',
      'conflict-resolver.ts',
    ]
    const files = listSourceFiles(sourceRoot)
    const violations: string[] = []

    for (const file of files) {
      const rel = toRepoPath(file)
      for (const mod of legacyModules) {
        if (rel.endsWith(mod)) {
          violations.push(`legacy module reintroduced: ${rel}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  test('new kernel modules do not use A2A as their internal task transport', () => {
    const kernelDirs = [
      'apps/server/src/services/rooms',
      'apps/server/src/services/coordinator-runtime',
      'apps/server/src/services/worker-runtime',
    ]
    const files = kernelDirs.flatMap((dir) => listSourceFiles(join(process.cwd(), dir)))
    const violations: string[] = []

    for (const file of files) {
      const rel = toRepoPath(file)
      const text = readFileSync(file, 'utf8')
      if (references(text, 'a2a-internal') || references(text, 'local-a2a-transport')) {
        violations.push(`${rel} references legacy A2A internal transport`)
      }
    }

    expect(violations).toEqual([])
  })

  test('new lifecycle paths use controllers instead of runtime lease persistence helpers', () => {
    const guardedDirs = [
      'apps/server/src/services/rooms',
      'apps/server/src/services/coordinator-runtime',
      'apps/server/src/services/worker-runtime',
    ]
    const guardedFiles = [
      'apps/server/src/index.ts',
      'apps/server/src/services/orchestrator/manager-loop.ts',
      'apps/server/src/services/orchestrator/manager-patrol.ts',
      'apps/server/src/services/orchestrator/task-thread-service.ts',
      'apps/server/src/services/orchestrator/run-controller.ts',
    ]
    const files = [
      ...guardedDirs.flatMap((dir) => listSourceFiles(join(process.cwd(), dir))),
      ...guardedFiles.map((file) => join(process.cwd(), file)),
    ]
    const forbiddenHelpers = [
      'createRuntimeLease',
      'markRuntimeLeaseReady',
      'markRuntimeLeaseRunning',
      'markRuntimeLeaseWaitingForHuman',
      'releaseRuntimeLease',
      'failRuntimeLease',
      'markRuntimeLeaseStale',
      'markInterruptedRuntimeLeasesStale',
    ]
    const violations: string[] = []

    for (const file of files) {
      const rel = toRepoPath(file)
      const text = readFileSync(file, 'utf8')
      if (rel.endsWith('runtime-lease-controller.ts')) continue
      for (const helper of forbiddenHelpers) {
        if (new RegExp(`\\b${helper}\\b`).test(text)) {
          violations.push(`${rel} references ${helper} instead of RuntimeLeaseController`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})

function listSourceFiles(root: string): string[] {
  const entries = readdirSync(root)
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(path))
      continue
    }
    if (/\.(ts|tsx)$/.test(entry)) {
      files.push(path)
    }
  }
  return files
}

function references(text: string, moduleName: string) {
  return new RegExp(`\\b(from|import)\\s*\\(?\\s*['"][^'"]*${escapeRegExp(moduleName)}['"]`).test(text)
}

function toRepoPath(path: string) {
  return relative(process.cwd(), path).replace(/\\/g, '/')
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
