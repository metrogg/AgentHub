import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tempDir = mkdtempSync(join(tmpdir(), 'agenthub-mrlifecycle-'))
process.env.AGENTHUB_APP_DATA_DIR = tempDir

import {
  OpenClawManagerRuntimeProvider,
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
        expect(Boolean(st.binaryPath || st.endpoint)).toBe(true)
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
      expect(st.syncReady).toBe(true)
      expect(st.stepEndpoint).toBe('http://localhost:18799/step')
      expect(st.healthEndpoint).toBe('http://localhost:18799/health')
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
      expect(result).toBeNull()
    })

    test('createRuntime calls configured endpoint /step and normalizes actions', async () => {
      const requests: Array<{ url: string; body: unknown }> = []
      const server = Bun.serve({
        port: 0,
        fetch: async (req) => {
          const url = new URL(req.url)
          if (url.pathname === '/step') {
            requests.push({ url: req.url, body: await req.json() })
            return Response.json({
              actions: [{ type: 'reply', message: 'ok from openclaw' }],
            })
          }
          if (url.pathname === '/health') return Response.json({ ok: true })
          return new Response('not found', { status: 404 })
        },
      })

      try {
        const provider = new OpenClawManagerRuntimeProvider({
          endpoint: `http://127.0.0.1:${server.port}`,
        })
        const runtime = provider.createRuntime()
        const events = []
        const result = await collectRuntimeStep(runtime.step({
          context: {
            roomId: 'room-1',
            ownerId: 'default-user',
            workers: [],
          },
          timeline: [],
        }), events)

        expect(result.runtimeType).toBe('openclaw')
        expect(result.actions).toEqual([{ type: 'reply', message: 'ok from openclaw' }])
        expect(events.map((event) => event.type)).toEqual(['thinking', 'completed'])
        expect(requests).toHaveLength(1)
        expect(new URL(requests[0]!.url).pathname).toBe('/step')
        expect((requests[0]!.body as any).runtimeType).toBe('openclaw')
      } finally {
        server.stop(true)
      }
    })

    test('createRuntime fails transparently without endpoint', async () => {
      const provider = new OpenClawManagerRuntimeProvider()
      const runtime = provider.createRuntime()
      const iterator = runtime.step({
        context: {
          roomId: 'room-1',
          ownerId: 'default-user',
          workers: [],
        },
        timeline: [],
      })
      await iterator.next()
      await expect(iterator.next()).rejects.toThrow('requires an endpoint')
    })

    test('stop is safe when not running', async () => {
      const provider = new OpenClawManagerRuntimeProvider()
      const st = await provider.stop()
      expect(st.running).toBe(false)
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
    test('getActiveManagerProvider returns openclaw by default with no local LLM fallback', () => {
      // Clear env to ensure no endpoint
      delete process.env.AGENTHUB_MANAGER_RUNTIME
      delete process.env.AGENTHUB_OPENCLAW_MANAGER_ENDPOINT
      delete process.env.AGENTHUB_OPENCLAW_PATH

      const provider = getActiveManagerProvider()
      expect(provider.runtimeType).toBe('openclaw')
    })

    test('getActiveManagerProvider respects AGENTHUB_MANAGER_RUNTIME env', () => {
      process.env.AGENTHUB_MANAGER_RUNTIME = 'qwenpaw'
      const provider = getActiveManagerProvider()
      expect(provider.runtimeType).toBe('qwenpaw')
      delete process.env.AGENTHUB_MANAGER_RUNTIME
    })

    test('listManagerProviders returns external Manager runtime providers only', async () => {
      const providers = await listManagerProviders()
      expect(providers.length).toBe(2)
      const types = providers.map((p) => p.type)
      expect(types).toContain('openclaw')
      expect(types).toContain('qwenpaw')
    })

    test('getConfiguredRuntimeType returns openclaw by default', () => {
      delete process.env.AGENTHUB_MANAGER_RUNTIME
      delete process.env.AGENTHUB_OPENCLAW_MANAGER_ENDPOINT
      delete process.env.AGENTHUB_OPENCLAW_PATH
      expect(getConfiguredRuntimeType()).toBe('openclaw')
    })

    test('getConfiguredRuntimeType respects env override', () => {
      process.env.AGENTHUB_MANAGER_RUNTIME = 'openclaw'
      expect(getConfiguredRuntimeType()).toBe('openclaw')
      delete process.env.AGENTHUB_MANAGER_RUNTIME
    })
  })
})

async function collectRuntimeStep<TEvent, TResult>(
  iterator: AsyncGenerator<TEvent, TResult>,
  events: TEvent[],
): Promise<TResult> {
  while (true) {
    const next = await iterator.next()
    if (next.done) return next.value
    events.push(next.value)
  }
}
