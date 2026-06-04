import './setup'
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('Manager config workspace', () => {
  test('creates HiClaw-style Manager persona, state, registry, and Controller API skills', async () => {
    const appDataDir = mkdtempSync(join(tmpdir(), 'agenthub-manager-config-'))
    process.env.AGENTHUB_APP_DATA_DIR = appDataDir
    Bun.env.AGENTHUB_APP_DATA_DIR = appDataDir

    const { ensureManagerConfig } = await import('../apps/server/src/services/coordinator-runtime/manager-config')
    const paths = ensureManagerConfig('workspace-1')

    expect(existsSync(paths.soulPath)).toBe(true)
    expect(existsSync(paths.agentsPath)).toBe(true)
    expect(existsSync(paths.workerRegistryPath)).toBe(true)
    expect(existsSync(paths.statePath)).toBe(true)

    const agents = readFileSync(paths.agentsPath, 'utf8')
    expect(agents).toContain('Human participants are first-class collaborators')
    expect(agents).toContain('Skills operate AgentHub Controller APIs')

    for (const skillName of [
      'worker-management',
      'task-management',
      'channel-management',
      'file-sync-management',
      'human-management',
    ]) {
      const skillPath = join(paths.skillsDir, skillName, 'SKILL.md')
      expect(existsSync(skillPath)).toBe(true)
      const skill = readFileSync(skillPath, 'utf8')
      expect(skill).toContain('## Controller API Surface')
      expect(skill).toContain('Read the Matrix room timeline')
      expect(skill).toContain('Report the result back to the Matrix room')
    }
  })
})
