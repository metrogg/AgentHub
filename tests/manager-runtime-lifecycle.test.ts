import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tempDir = mkdtempSync(join(tmpdir(), 'agenthub-mrlifecycle-'))
process.env.AGENTHUB_APP_DATA_DIR = tempDir

import {
  OpenClawManagerRuntimeProvider,
  LocalSkillRuntimeProvider,
  QwenPawManagerRuntimeProvider,
  getActiveManagerProvider,
  listManagerProviders,
  getConfiguredRuntimeType,
} from '../apps/server/src/services/manager-runtime'

describe('Manager Runtime Lifecycle', () => {
  describe('OpenClawManagerRuntimeProvider', () => {
    test('status reports availability based on binary or endpoint', async () => {
      const provider = new OpenClawManagerRuntimeProvider()
      const st = await provider.status()
      expect(st.runtimeType).toBe('openclaw')
      // OpenClaw may or may not be installed on this machine
      if (st.available) {
        expect(st.binaryPath).toBeTruthy()
        expect(st.error).toBeNull()
      } else {
        expect(st.available).toBe(false)
        expect(st.running).toBe(false)
        expect(st.error).toContain('not found')
      }
    })

    test('status reports available when endpoint is configured', async () => {
      const provider = new OpenClawManagerRuntimeProvider({
        endpoint: 'http://localhost:18799',
      })
      const st = await provider.status()
      expect(st.available).toBe(true)
      expect(st.endpoint).toBe('http://localhost:18799')
    })

    test('healthCheck fails when not running and no endpoint', async () => {
      const provider = new OpenClawManagerRuntimeProvider()
      const health = await provider.healthCheck()
      expect(health.healthy).toBe(false)
    })

    test('getEndpointOrCommand returns endpoint when configured', () => {
      const provider = new OpenClawManagerRuntimeProvider({
        endpoint: 'http://localhost:18799',
      })
      const result = provider.getEndpointOrCommand()
      expect(result).toEqual({ endpoint: 'http://localhost:18799' })
    })

    test('getEndpointOrCommand returns null when nothing configured', () => {
      const provider = new OpenClawManagerRuntimeProvider()
      const result = provider.getEndpointOrCommand()
      // May return command if binary is found, or null
      if (result) {
        expect(result.command).toContain('openclaw')
      }
    })

    test('stop is safe when not running', async () => {
      const provider = new OpenClawManagerRuntimeProvider()
      const st = await provider.stop()
      expect(st.running).toBe(false)
    })
  })

  describe('LocalSkillRuntimeProvider', () => {
    test('status always reports available and running', async () => {
      const provider = new LocalSkillRuntimeProvider()
      const st = await provider.status()
      expect(st.runtimeType).toBe('local-skill-runtime')
      expect(st.available).toBe(true)
      expect(st.running).toBe(true)
      expect(st.pid).toBe(process.pid)
    })

    test('healthCheck always returns healthy', async () => {
      const provider = new LocalSkillRuntimeProvider()
      const health = await provider.healthCheck()
      expect(health.healthy).toBe(true)
    })
  })

  describe('QwenPawManagerRuntimeProvider', () => {
    test('status reports not implemented', async () => {
      const provider = new QwenPawManagerRuntimeProvider()
      const st = await provider.status()
      expect(st.runtimeType).toBe('qwenpaw')
      expect(st.available).toBe(false)
      expect(st.error).toContain('not yet implemented')
    })
  })

  describe('Registry', () => {
    test('getActiveManagerProvider returns local-skill-runtime when OpenClaw not available', () => {
      // Clear env to ensure no endpoint
      delete process.env.AGENTHUB_MANAGER_RUNTIME
      delete process.env.AGENTHUB_OPENCLAW_MANAGER_ENDPOINT
      delete process.env.AGENTHUB_OPENCLAW_PATH

      const provider = getActiveManagerProvider()
      // Should be local-skill-runtime since OpenClaw is not installed
      expect(provider.runtimeType).toBe('local-skill-runtime')
    })

    test('getActiveManagerProvider respects AGENTHUB_MANAGER_RUNTIME env', () => {
      process.env.AGENTHUB_MANAGER_RUNTIME = 'local-skill-runtime'
      const provider = getActiveManagerProvider()
      expect(provider.runtimeType).toBe('local-skill-runtime')
      delete process.env.AGENTHUB_MANAGER_RUNTIME
    })

    test('listManagerProviders returns all three providers', async () => {
      const providers = await listManagerProviders()
      expect(providers.length).toBe(3)
      const types = providers.map((p) => p.type)
      expect(types).toContain('local-skill-runtime')
      expect(types).toContain('openclaw')
      expect(types).toContain('qwenpaw')
    })

    test('getConfiguredRuntimeType returns local-skill-runtime by default', () => {
      delete process.env.AGENTHUB_MANAGER_RUNTIME
      delete process.env.AGENTHUB_OPENCLAW_MANAGER_ENDPOINT
      delete process.env.AGENTHUB_OPENCLAW_PATH
      expect(getConfiguredRuntimeType()).toBe('local-skill-runtime')
    })

    test('getConfiguredRuntimeType respects env override', () => {
      process.env.AGENTHUB_MANAGER_RUNTIME = 'openclaw'
      expect(getConfiguredRuntimeType()).toBe('openclaw')
      delete process.env.AGENTHUB_MANAGER_RUNTIME
    })
  })
})
