import { useMemo, useState } from 'react'
import type { WelcomeQuickPrompt } from '../../lib/api'
import { cn } from '../../lib/utils'

export function createQuickPromptSeed(scope: string) {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  return `${scope}:${Date.now()}:${random}`
}

export function rotateQuickPrompts(prompts: WelcomeQuickPrompt[], seed: string, count = prompts.length) {
  if (!prompts.length) return prompts
  const shuffled = [...prompts]
  let state = stablePromptHash(seed)
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const target = state % (index + 1)
    const current = shuffled[index]!
    shuffled[index] = shuffled[target]!
    shuffled[target] = current
  }
  return shuffled.slice(0, Math.max(0, count))
}

export function QuickPromptBubbles({
  className,
  loading = false,
  onPick,
  prompts,
}: {
  className?: string
  loading?: boolean
  onPick: (prompt: string) => void
  prompts: WelcomeQuickPrompt[]
}) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const promptRows = useMemo(() => {
    if (!prompts.length) return []
    const mid = Math.max(1, Math.floor(prompts.length * 0.4))
    return [
      prompts.slice(0, mid),
      prompts.slice(mid),
    ].filter((row) => row.length > 0)
  }, [prompts])

  function pickPrompt(prompt: WelcomeQuickPrompt) {
    if (!prompt.prompt.trim()) return
    setActiveId(prompt.id)
    window.setTimeout(() => setActiveId(null), 520)
    onPick(prompt.prompt)
  }

  return (
    <div className={cn('agenthub-quick-prompt-shell', className)} aria-busy={loading}>
      {promptRows.map((row, rowIndex) => (
        <div
          key={`row-${rowIndex}`}
          className={cn(
            'agenthub-quick-prompt-row',
            rowIndex === 1 && 'agenthub-quick-prompt-row-reverse agenthub-quick-prompt-row-compact',
          )}
        >
          <div className="agenthub-quick-prompt-track">
            {[0, 1].map((group) => (
              <div
                key={group}
                className="agenthub-quick-prompt-group"
                aria-hidden={group === 1 ? true : undefined}
              >
                {row.map((prompt, index) => (
                  <button
                    key={`${prompt.id}-${group}-${index}`}
                    type="button"
                    tabIndex={group === 1 ? -1 : 0}
                    onClick={() => pickPrompt(prompt)}
                    className={cn(
                      'agenthub-quick-prompt-bubble',
                      activeId === prompt.id && 'agenthub-quick-prompt-bubble-active',
                    )}
                    aria-label={`快速对话：${prompt.label}`}
                  >
                    <span>{prompt.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function stablePromptHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}
