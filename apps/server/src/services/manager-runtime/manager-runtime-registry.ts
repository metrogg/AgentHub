import {
  OpenClawManagerRuntimeProvider,
  QwenPawManagerRuntimeProvider,
  type ManagerRuntimeProvider,
  type ManagerRuntimeType,
} from './openclaw-provider'

// ─── Manager Runtime Registry ────────────────────────────────────────
// Manages available Manager runtime providers and resolves the active one.
// Aligned with HiClaw's HICLAW_MANAGER_RUNTIME env var pattern.
// Manager is ALWAYS an external OpenClaw/QwenPaw process — no local LLM fallback.

const providers = new Map<ManagerRuntimeType, ManagerRuntimeProvider>()

// Register built-in providers
providers.set('openclaw', new OpenClawManagerRuntimeProvider())
providers.set('qwenpaw', new QwenPawManagerRuntimeProvider())

/**
 * Get the active Manager runtime provider.
 * Priority:
 * 1. Explicit env var AGENTHUB_MANAGER_RUNTIME
 * 2. Default → openclaw
 *
 * There is no local LLM fallback. Manager must be a real OpenClaw/QwenPaw process.
 */
export function getActiveManagerProvider(): ManagerRuntimeProvider {
  const configured = process.env.AGENTHUB_MANAGER_RUNTIME
  if (configured && providers.has(configured as ManagerRuntimeType)) {
    return providers.get(configured as ManagerRuntimeType)!
  }
  return providers.get('openclaw')!
}

/**
 * Get a specific provider by type.
 */
export function getManagerProvider(type: ManagerRuntimeType): ManagerRuntimeProvider | null {
  return providers.get(type) ?? null
}

/**
 * List all registered providers with their status.
 */
export async function listManagerProviders(): Promise<Array<{
  type: ManagerRuntimeType
  available: boolean
  running: boolean
  error: string | null
}>> {
  const results: Array<{
    type: ManagerRuntimeType
    available: boolean
    running: boolean
    error: string | null
  }> = []

  for (const [type, provider] of providers) {
    try {
      const st = await provider.status()
      results.push({
        type,
        available: st.available,
        running: st.running,
        error: st.error,
      })
    } catch (e) {
      results.push({
        type,
        available: false,
        running: false,
        error: String(e),
      })
    }
  }
  return results
}

/**
 * Get the configured runtime type from env or auto-detected.
 */
export function getConfiguredRuntimeType(): ManagerRuntimeType {
  const configured = process.env.AGENTHUB_MANAGER_RUNTIME
  if (configured === 'openclaw' || configured === 'qwenpaw') {
    return configured
  }
  return 'openclaw'
}

function hasOpenClawManagerEndpoint(): boolean {
  return Boolean(process.env.AGENTHUB_OPENCLAW_MANAGER_ENDPOINT?.trim())
}
