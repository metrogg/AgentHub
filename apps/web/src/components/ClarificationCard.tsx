import { useState } from 'react'
import { HelpCircle, CheckCircle2 } from 'lucide-react'

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

  const handleSubmit = async (value: string) => {
    if (submitting || submitted) return
    setSubmitting(true)
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
        onAnswered?.(value)
      }
    } catch (err) {
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
                className="px-3 py-1.5 text-sm bg-white border border-amber-300 rounded-lg hover:bg-amber-100 disabled:opacity-50 transition-colors"
              >
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
              if (e.key === 'Enter' && answer.trim()) {
                handleSubmit(answer.trim())
              }
            }}
          />
          <button
            type="button"
            onClick={() => answer.trim() && handleSubmit(answer.trim())}
            disabled={!answer.trim() || submitting}
            className="px-3 py-1.5 text-sm font-medium text-white bg-amber-600 rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? '发送中...' : '发送'}
          </button>
        </div>
      )}
    </div>
  )
}