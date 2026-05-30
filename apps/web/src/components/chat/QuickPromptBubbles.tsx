import { useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { WelcomeQuickPrompt } from '../../lib/api'
import { cn } from '../../lib/utils'

const placeholderPrompts: WelcomeQuickPrompt[] = [
  { id: 'placeholder-1', label: '正在生成快速问题', prompt: '' },
  { id: 'placeholder-2', label: '为这次打开换一组灵感', prompt: '' },
  { id: 'placeholder-3', label: '稍等一下', prompt: '' },
  { id: 'placeholder-4', label: '准备好就能开聊', prompt: '' },
]

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
  const displayPrompts = prompts.length ? prompts : loading ? placeholderPrompts : []
  const promptRows = useMemo(
    () => [
      displayPrompts.filter((_, index) => index % 2 === 0),
      displayPrompts.filter((_, index) => index % 2 === 1),
    ].filter((row) => row.length > 0),
    [displayPrompts],
  )
  const disabled = !prompts.length && loading

  function pickPrompt(prompt: WelcomeQuickPrompt) {
    if (disabled || !prompt.prompt.trim()) return
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
            rowIndex % 2 === 1 && 'agenthub-quick-prompt-row-reverse',
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
                    disabled={disabled}
                    onClick={() => pickPrompt(prompt)}
                    className={cn(
                      'agenthub-quick-prompt-bubble',
                      (activeId === prompt.id || (!disabled && group === 0 && index === 0 && loading)) &&
                        'agenthub-quick-prompt-bubble-active',
                    )}
                    aria-label={`快速对话：${prompt.label}`}
                  >
                    {loading && !prompts.length && index === 0 && group === 0 && (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    )}
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
