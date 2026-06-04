import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react'
import { cn } from '../lib/utils'

export type ConfirmDialogTone = 'default' | 'danger' | 'warning' | 'success'

export type ConfirmDialogOptions = {
  cancelLabel?: string
  confirmLabel?: string
  description?: string
  detail?: string
  showCancel?: boolean
  title: string
  tone?: ConfirmDialogTone
}

type ConfirmDialogRequest = ConfirmDialogOptions & {
  id: string
  resolve: (confirmed: boolean) => void
}

const confirmDialogEvent = 'agenthub:confirm-dialog'

export function requestConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false)
  return new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent<ConfirmDialogRequest>(confirmDialogEvent, {
        detail: {
          ...options,
          id: crypto.randomUUID(),
          resolve,
        },
      }),
    )
  })
}

export async function requestNoticeDialog(options: Omit<ConfirmDialogOptions, 'showCancel'>) {
  await requestConfirmDialog({ ...options, showCancel: false })
}

export function GlobalConfirmDialog() {
  const [queue, setQueue] = useState<ConfirmDialogRequest[]>([])
  const [closing, setClosing] = useState(false)
  const active = queue[0] ?? null

  useEffect(() => {
    function handleRequest(event: Event) {
      const request = (event as CustomEvent<ConfirmDialogRequest>).detail
      if (!request?.id || typeof request.resolve !== 'function') return
      setQueue((current) => [...current, request])
    }

    window.addEventListener(confirmDialogEvent, handleRequest)
    return () => window.removeEventListener(confirmDialogEvent, handleRequest)
  }, [])

  useEffect(() => {
    if (!active) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') settle(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id])

  function settle(confirmed: boolean) {
    if (!active || closing) return
    setClosing(true)
    active.resolve(confirmed)
    window.setTimeout(() => {
      setQueue((current) => current.filter((request) => request.id !== active.id))
      setClosing(false)
    }, 120)
  }

  if (!active || typeof document === 'undefined') return null

  const tone = active.tone ?? 'default'
  const confirmLabel = active.confirmLabel ?? '确认'
  const cancelLabel = active.cancelLabel ?? '取消'
  const showCancel = active.showCancel !== false
  const Icon =
    tone === 'danger' || tone === 'warning'
      ? AlertTriangle
      : tone === 'success'
        ? CheckCircle2
        : Info

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 z-[2147483647] flex items-center justify-center bg-black/20 px-4 backdrop-blur-sm transition-opacity',
        closing && 'opacity-0',
      )}
      role="dialog"
      aria-modal="true"
      aria-labelledby="agenthub-confirm-title"
      onMouseDown={() => settle(false)}
    >
      <div
        className="w-full max-w-[390px] rounded-2xl border border-neutral-200 bg-white p-4 shadow-[0_28px_90px_rgba(15,23,42,0.18)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              'grid h-10 w-10 shrink-0 place-items-center rounded-xl',
              tone === 'danger' && 'bg-red-50 text-red-500',
              tone === 'warning' && 'bg-amber-50 text-amber-600',
              tone === 'success' && 'bg-emerald-50 text-emerald-600',
              tone === 'default' && 'bg-neutral-100 text-neutral-700',
            )}
          >
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="agenthub-confirm-title" className="text-sm font-semibold text-neutral-950">
              {active.title}
            </h2>
            {active.description && (
              <p className="mt-1 text-xs leading-5 text-neutral-500">{active.description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => settle(false)}
            className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-900"
            aria-label="关闭"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {active.detail && (
          <div className="mt-4 rounded-xl border border-neutral-200 bg-[#f7f7f4] px-3 py-2 text-xs leading-5 text-neutral-600">
            {active.detail}
          </div>
        )}

        <div className={cn('mt-4 grid gap-2', showCancel ? 'grid-cols-2' : 'grid-cols-1')}>
          {showCancel && (
            <button
              type="button"
              onClick={() => settle(false)}
              className="inline-flex h-10 items-center justify-center rounded-xl border border-neutral-200 bg-white text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
            >
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            onClick={() => settle(true)}
            data-testid="confirm-dialog-confirm"
            className={cn(
              'inline-flex h-10 items-center justify-center gap-2 rounded-xl text-sm font-medium text-white transition',
              tone === 'danger'
                ? 'bg-red-600 hover:bg-red-500'
                : tone === 'warning'
                  ? 'bg-amber-600 hover:bg-amber-500'
                  : tone === 'success'
                    ? 'bg-emerald-600 hover:bg-emerald-500'
                    : 'bg-neutral-950 hover:bg-neutral-800',
            )}
          >
            {closing && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
