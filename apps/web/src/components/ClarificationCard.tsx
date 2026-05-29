import { useState } from 'react'
<<<<<<< HEAD
import { HelpCircle, CheckCircle2, Loader2, AlertCircle, XCircle } from 'lucide-react'
=======
import { HelpCircle, CheckCircle2 } from 'lucide-react'
>>>>>>> e4e6b4c (feat: 引入统一执行流、任务看板与Agent自主性)

interface ClarificationCardProps {
  taskId: string
  question: string
  options?: string[]
  messageId: string
  sessionId: string
  onAnswered?: (answer: string) => void
}

export function ClarificationCard({
  taskId,
  question,
  options,
  messageId,
  sessionId,
  onAnswered,
}: ClarificationCardProps) {
  const [answer, setAnswer] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
<<<<<<< HEAD
  const [error, setError] = useState<string | null>(null)
  const [successVisible, setSuccessVisible] = useState(false)
=======
>>>>>>> e4e6b4c (feat: 引入统一执行流、任务看板与Agent自主性)

  const handleSubmit = async (value: string) => {
    if (submitting || submitted) return
    setSubmitting(true)
<<<<<<< HEAD
    setError(null)
=======
>>>>>>> e4e6b4c (feat: 引入统一执行流、任务看板与Agent自主性)
    try {
      const response = await fetch(`/api/messages/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: value,
          metadata: {
            clarificationTaskId: taskId,
            clarificationMessageId: messageId,
          },
        }),
      })
      if (response.ok) {
        setAnswer(value)
        setSubmitted(true)
<<<<<<< HEAD
        setSuccessVisible(true)
        onAnswered?.(value)
        setTimeout(() => setSuccessVisible(false), 3000)
      }
    } catch (err) {
      setError('网络请求失败，请检查网络连接后重试')
=======
        onAnswered?.(value)
      }
    } catch (err) {
>>>>>>> e4e6b4c (feat: 引入统一执行流、任务看板与Agent自主性)
      console.error('Failed to submit clarification answer:', err)
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <div className="my-2 p-3 bg-green-50 border border-green-200 rounded-lg">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-green-500" />
          <span className="text-sm text-green-700">已回答：{answer}</span>
        </div>
<<<<<<< HEAD
        {successVisible && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-green-600 animate-in fade-in">
            <CheckCircle2 className="w-3 h-3" />
            提交成功
          </div>
        )}
=======
>>>>>>> e4e6b4c (feat: 引入统一执行流、任务看板与Agent自主性)
      </div>
    )
  }

  return (
    <div className="my-2 p-4 bg-amber-50 border border-amber-200 rounded-lg">
      <div className="flex items-center gap-2 mb-3">
        <HelpCircle className="w-5 h-5 text-amber-600 flex-shrink-0" />
        <span className="text-sm font-medium text-amber-800">Agent 需要确认</span>
      </div>
      <p className="text-sm text-amber-900 mb-3">{question}</p>
<<<<<<< HEAD

      {error && (
        <div className="mb-3 flex items-center gap-1.5 text-xs text-red-600">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-auto text-red-400 hover:text-red-600 transition-colors"
          >
            <XCircle className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

=======
>>>>>>> e4e6b4c (feat: 引入统一执行流、任务看板与Agent自主性)
      {options && options.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {options.map((opt, idx) => {
            const label = opt.replace(/^[A-Z]\)\s*/, '').trim()
            return (
              <button
                key={idx}
                type="button"
                onClick={() => handleSubmit(label)}
                disabled={submitting}
<<<<<<< HEAD
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-white border border-amber-300 rounded-lg hover:bg-amber-100 disabled:opacity-50 transition-colors"
              >
                {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
=======
                className="px-3 py-1.5 text-sm bg-white border border-amber-300 rounded-lg hover:bg-amber-100 disabled:opacity-50 transition-colors"
              >
>>>>>>> e4e6b4c (feat: 引入统一执行流、任务看板与Agent自主性)
                {opt}
              </button>
            )
          })}
        </div>
      ) : (
        <div className="flex gap-2">
          <input
            type="text"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="输入你的回答..."
            disabled={submitting}
            className="flex-1 px-3 py-1.5 text-sm border border-amber-300 rounded-lg bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-50"
            onKeyDown={(e) => {
<<<<<<< HEAD
              if (e.key === 'Enter' && answer.trim() && !submitting) {
=======
              if (e.key === 'Enter' && answer.trim()) {
>>>>>>> e4e6b4c (feat: 引入统一执行流、任务看板与Agent自主性)
                handleSubmit(answer.trim())
              }
            }}
          />
          <button
            type="button"
            onClick={() => answer.trim() && handleSubmit(answer.trim())}
            disabled={!answer.trim() || submitting}
<<<<<<< HEAD
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-amber-600 rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                发送中
              </>
            ) : (
              '发送'
            )}
=======
            className="px-3 py-1.5 text-sm font-medium text-white bg-amber-600 rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? '发送中...' : '发送'}
>>>>>>> e4e6b4c (feat: 引入统一执行流、任务看板与Agent自主性)
          </button>
        </div>
      )}
    </div>
  )
}