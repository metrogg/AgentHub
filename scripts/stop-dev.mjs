import { cleanupStaleDevProcesses } from './dev-processes.mjs'

const killed = await cleanupStaleDevProcesses({ includeSelf: false })
if (killed.length === 0) {
  console.warn('[dev] no stale AgentHub dev processes found')
}
