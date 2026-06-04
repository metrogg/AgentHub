export interface OpenClawArgsOptions {
  roleProfile?: Record<string, unknown> | null
  toolConfig?: Record<string, unknown>
  promptFile?: string
}

export function buildOpenClawArgs(prompt: string, options?: OpenClawArgsOptions) {
  const cfg = options?.toolConfig ?? {}
  const profile = options?.roleProfile ?? {}
  const agentId =
    readStringConfig(profile, 'openclawAgentId') ??
    readStringConfig(cfg, 'openclawAgentId') ??
    readStringConfig(cfg, 'agent') ??
    'main'
  const message = options?.promptFile ? buildOpenClawFilePrompt(options.promptFile) : prompt
  return ['agent', '--agent', agentId, '--message', message, '--json', '--local']
}

export function extractOpenClawResultMessage(output: string) {
  const payloads: unknown[] = []
  const trimmed = output.trim()
  if (trimmed) {
    try {
      payloads.push(JSON.parse(trimmed))
    } catch {
      for (const line of trimmed.split(/\r?\n/)) {
        const value = line.trim()
        if (!value.startsWith('{') && !value.startsWith('[')) continue
        try {
          payloads.push(JSON.parse(value))
        } catch {
          // Ignore non-JSON status lines from the CLI.
        }
      }
    }
  }

  for (const payload of payloads) {
    const text = extractOpenClawValueText(payload)
    if (text) return text
  }
  return ''
}

function buildOpenClawFilePrompt(promptFile: string) {
  return [
    'Open the local prompt file below and follow it exactly.',
    `Prompt file path: ${promptFile}`,
    'Treat that file as the complete task specification and conversation context.',
    'Do not answer only about this instruction; complete the task described in the file.',
  ].join('\n')
}

function extractOpenClawValueText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value.map(extractOpenClawValueText).filter(Boolean).join('\n').trim()
  }
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  for (const key of ['message', 'reply', 'text', 'content', 'output']) {
    const nested = extractOpenClawValueText(record[key])
    if (nested) return nested
  }
  const result = extractOpenClawValueText(record.result)
  if (result) return result
  const data = extractOpenClawValueText(record.data)
  if (data) return data
  return ''
}

function readStringConfig(cfg: Record<string, unknown>, key: string) {
  const value = cfg[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
