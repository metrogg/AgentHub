export interface TaskValidationResult {
  command: string
  status: 'passed' | 'failed' | 'skipped'
  exitCode: number
  outputSummary: string
  durationMs: number
}

export async function runTaskValidation(params: {
  commands: string[]
  cwd?: string | null
}): Promise<TaskValidationResult[]> {
  const results: TaskValidationResult[] = []
  for (const command of params.commands) {
    const startedAt = Date.now()
    const parsed = parseSafeCommand(command)
    if (!parsed) {
      results.push({
        command,
        status: 'skipped',
        exitCode: -1,
        outputSummary: 'Validation command is not allowed by the safe command allowlist.',
        durationMs: Date.now() - startedAt,
      })
      continue
    }

    const proc = Bun.spawn(parsed, {
      cwd: params.cwd || process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const outputSummary = compactOutput(stdout, stderr)
    results.push({
      command,
      status: exitCode === 0 ? 'passed' : 'failed',
      exitCode,
      outputSummary,
      durationMs: Date.now() - startedAt,
    })
  }
  return results
}

function parseSafeCommand(command: string): string[] | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  if (tokens.some((token) => /[;&|<>`$]/.test(token))) return null

  const [bin, ...args] = tokens
  if (!bin) return null

  if (bin === 'bun') {
    if (args[0] === '--version' || args[0] === '-v' || args[0] === 'test') return tokens
    if (args[0] === 'run' && isSafeScriptName(args[1])) return tokens
    return null
  }
  if (bin === 'npm' || bin === 'pnpm' || bin === 'yarn') {
    if (args[0] === '--version' || args[0] === '-v' || args[0] === 'test') return tokens
    if (args[0] === 'run' && isSafeScriptName(args[1])) return tokens
    return null
  }
  if (bin === 'node') {
    return args[0] === '--version' || args[0] === '-v' ? tokens : null
  }
  if (bin === 'git') {
    return ['status', 'diff', 'show', 'log', 'rev-parse'].includes(args[0] ?? '') ? tokens : null
  }
  return null
}

function isSafeScriptName(value: string | undefined): boolean {
  return Boolean(value && /^(test|typecheck|lint|build|check|validate|format:check)(:[a-z0-9_-]+)?$/i.test(value))
}

function compactOutput(stdout: string, stderr: string): string {
  const text = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
  return text.slice(0, 2000) || 'Command produced no output.'
}
