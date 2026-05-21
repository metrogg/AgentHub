import { Hono } from 'hono'
import { authMiddleware, type AuthVariables } from '../middleware/auth'

interface ToolProbe {
  id: string
  command: string
}

const probes: ToolProbe[] = [
  { id: 'codex', command: 'codex' },
  { id: 'claude-code', command: 'claude' },
  { id: 'opencode', command: 'opencode' },
]

export const codingToolsRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/status', async (c) => {
    const items = await Promise.all(probes.map(probeTool))
    return c.json({ platform: process.platform, items })
  })

async function probeTool(probe: ToolProbe) {
  const version = await runVersionProbe(probe.command)
  return {
    id: probe.id,
    command: probe.command,
    installed: Boolean(version),
    version,
  }
}

async function runVersionProbe(command: string): Promise<string | null> {
  const isWindows = process.platform === 'win32'
  const shell = isWindows ? 'cmd.exe' : 'sh'
  const args = isWindows
    ? ['/d', '/s', '/c', `where ${command} >nul 2>nul && ${command} --version`]
    : ['-lc', `command -v ${command} >/dev/null 2>&1 && ${command} --version`]

  try {
    const proc = Bun.spawn([shell, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timed = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) => setTimeout(() => resolve(124), 2500)),
    ])
    if (timed !== 0) return null

    const output = await new Response(proc.stdout).text()
    const firstLine = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    return firstLine ?? 'installed'
  } catch {
    return null
  }
}
