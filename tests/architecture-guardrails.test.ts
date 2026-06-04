import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const sourceRoots = ['apps', 'packages']
const maxSourceFileLines = 800
const sourceExtensions = new Set([
  '.cjs',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.mjs',
  '.ts',
  '.tsx',
])

const legacyOversizedSourceFiles: Record<string, number> = {
  'apps/Android/app/src/main/java/com/agenthub/mobile/ui/screens/ChatShell.kt': 5473,
  'apps/server/src/routes/coding-tools.ts': 1311,
  'apps/server/src/routes/messages.ts': 2573,
  'apps/server/src/routes/mobile.ts': 1152,
  'apps/server/src/routes/orchestrator-runs.ts': 1285,
  'apps/server/src/routes/workspaces.ts': 953,
  'apps/server/src/services/code-agent-adapter.ts': 3437,
  'apps/server/src/services/orchestrator/orchestrator-engine.ts': 4439,
  'apps/server/src/services/orchestrator/planner.ts': 807,
  'apps/server/src/services/orchestrator/run-controller.ts': 1591,
  'apps/web/src/components/artifacts/ArtifactPreviewSurface.tsx': 1281,
  'apps/web/src/components/assistant-ui/Thread.tsx': 6603,
  'apps/web/src/components/chat/SessionList.tsx': 1884,
  'apps/web/src/lib/apiTypes.ts': 1168,
  'apps/web/src/pages/AgentConfigPage.tsx': 1207,
  'apps/web/src/pages/ArtifactsPage.tsx': 847,
  'apps/web/src/pages/CodingToolsPage.tsx': 1797,
  'apps/web/src/pages/OrchestratorRunsPage.tsx': 1341,
  'apps/web/src/pages/SettingsPage.tsx': 3026,
  'apps/web/src/pages/SkillsMarketPage.tsx': 1038,
  'apps/web/src/stores/chatStore.ts': 3072,
}

const corePageSmokeRoutes = [
  '/',
  '/chat/session-main',
  '/abilities',
  '/artifacts',
  '/models',
  '/coding-tools',
  '/agent-config',
  '/profile',
  '/skills',
  '/orchestrator-runs',
]

function normalizePath(value: string) {
  return value.replace(/\\/g, '/')
}

function sourceFiles(root: string): string[] {
  const rows: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue
      rows.push(...sourceFiles(path))
      continue
    }
    if (!entry.isFile()) continue
    const extension = entry.name.match(/(\.[^.]+)$/)?.[1] ?? ''
    if (sourceExtensions.has(extension)) rows.push(path)
  }
  return rows
}

function lineCount(path: string) {
  const text = readFileSync(path, 'utf8')
  if (!text) return 0
  return text.split(/\r\n|\r|\n/).length
}

describe('architecture guardrails', () => {
  test('enforces the 800-line source file budget while blocking legacy files from growing', () => {
    const allSourceFiles = sourceRoots.flatMap((root) => sourceFiles(root))
    const violations = allSourceFiles
      .map((path) => ({
        path: normalizePath(relative(process.cwd(), path)),
        lines: lineCount(path),
      }))
      .filter((item) => item.lines > maxSourceFileLines)

    const unexpectedOversizedFiles = violations.filter(
      (item) => legacyOversizedSourceFiles[item.path] === undefined,
    )
    const legacyGrowth = violations.filter((item) => {
      const allowedLines = legacyOversizedSourceFiles[item.path]
      return allowedLines !== undefined && item.lines > allowedLines
    })
    const resolvedLegacyFiles = Object.keys(legacyOversizedSourceFiles).filter((path) => {
      const absolute = join(process.cwd(), path)
      if (!statSync(absolute, { throwIfNoEntry: false })) return true
      return lineCount(absolute) <= maxSourceFileLines
    })

    expect(unexpectedOversizedFiles).toEqual([])
    expect(legacyGrowth).toEqual([])
    expect(
      resolvedLegacyFiles,
      'Remove resolved files from legacyOversizedSourceFiles after splitting them below 800 lines.',
    ).toEqual([])
  })

  test('requires core pages to be declared in the Playwright smoke matrix', () => {
    const smokeSpec = readFileSync('tests/e2e/core-pages-smoke.spec.ts', 'utf8')
    const missingRoutes = corePageSmokeRoutes.filter((route) => !smokeSpec.includes(`path: '${route}'`))
    expect(missingRoutes).toEqual([])
  })
})
