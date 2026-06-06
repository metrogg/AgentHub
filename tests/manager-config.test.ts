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

    const { ensureManagerConfig } = await import('../apps/server/src/services/manager-runtime/manager-config')
    const paths = ensureManagerConfig('workspace-1')

    expect(existsSync(paths.soulPath)).toBe(true)
    expect(existsSync(paths.agentsPath)).toBe(true)
    expect(existsSync(paths.toolsPath)).toBe(true)
    expect(existsSync(paths.heartbeatPath)).toBe(true)
    expect(existsSync(paths.workerRegistryPath)).toBe(true)
    expect(existsSync(paths.teamRegistryPath)).toBe(true)
    expect(existsSync(paths.humanRegistryPath)).toBe(true)
    expect(existsSync(paths.statePath)).toBe(true)
    expect(existsSync(paths.roomsPath)).toBe(true)
    expect(existsSync(paths.agentDir)).toBe(true)

    const agents = readFileSync(paths.agentsPath, 'utf8')
    expect(agents).toContain('AGENTHUB:MANAGER-CONTEXT:START')
    expect(agents).toContain('Runtime type: openclaw')
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
      expect(skill).toContain('##')
      expect(skill).toContain('Decision Pattern')
    }

    expect(existsSync(join(paths.agentDir, 'SOUL.md'))).toBe(true)
    expect(existsSync(join(paths.agentDir, 'skills', 'agenthub-controller', 'SKILL.md'))).toBe(true)
  })
})
