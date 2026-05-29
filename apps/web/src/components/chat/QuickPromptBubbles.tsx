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

export const fallbackWelcomeQuickPrompts: WelcomeQuickPrompt[] = [
  { id: 'local-1', label: '帮我拆解一个小工具需求', prompt: '帮我把一个小工具需求拆成可执行的开发步骤，并指出风险点。' },
  { id: 'local-2', label: '这个项目适合怎么重构', prompt: '请从架构、状态管理和测试三个角度，分析一个项目适合怎样重构。' },
  { id: 'local-3', label: '解释一下前端构建流程', prompt: '用通俗语言解释前端从源码到上线的构建流程。' },
  { id: 'local-4', label: '给我一个学习路线', prompt: '请根据我的目标生成一份 7 天学习路线，并每天给一个练习。' },
  { id: 'local-5', label: '帮我整理会议纪要', prompt: '给我一个清晰的会议纪要模板，包含待办、负责人和截止时间。' },
  { id: 'local-6', label: '写一封更自然的邮件', prompt: '帮我把一封工作邮件改得更自然、礼貌、简洁。' },
  { id: 'local-7', label: '最近 AI 开发该关注什么', prompt: '不依赖实时新闻，概括最近 AI 开发者值得关注的长期趋势。' },
  { id: 'local-8', label: '设计一个轻量小游戏', prompt: '帮我设计一个 10 分钟能开局的轻量小游戏玩法。' },
]

export function createQuickPromptSeed(scope: string) {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  return `${scope}:${Date.now()}:${random}`
}

export function rotateQuickPrompts(prompts: WelcomeQuickPrompt[], seed: string) {
  if (!prompts.length) return prompts
  const offset = stablePromptHash(seed) % prompts.length
  return [...prompts.slice(offset), ...prompts.slice(0, offset)]
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
  const displayPrompts = prompts.length ? prompts : loading ? placeholderPrompts : fallbackWelcomeQuickPrompts
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
