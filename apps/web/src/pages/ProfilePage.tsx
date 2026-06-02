import { useEffect, useRef, useState } from 'react'
import { Camera, CheckCircle2, Loader2, UserCircle } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import SessionList from '../components/chat/SessionList'
import { api } from '../lib/api'
import { cacheAccountProfileFromProfile, getCachedAccountProfile } from '../lib/accountProfile'
import { settingsUpdatedEvent } from '../lib/shortcuts'
import { cn } from '../lib/utils'

type ProfileSettings = {
  accountName: string
  accountAvatar: string
  accountMemory: string
}

const defaultProfile: ProfileSettings = {
  accountName: 'You',
  accountAvatar: '',
  accountMemory: '',
}

export default function ProfilePage() {
  const location = useLocation()
  const [profile, setProfile] = useState<ProfileSettings>(() => {
    const cached = getCachedAccountProfile()
    return { ...defaultProfile, accountName: cached.name, accountAvatar: cached.avatar }
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const saveTimer = useRef<number | null>(null)
  const mountedRef = useRef(false)
  const memorySectionRef = useRef<HTMLElement | null>(null)
  const memoryTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const rawSettingsRef = useRef<Record<string, unknown>>({})
  const latestProfileRef = useRef<ProfileSettings>(defaultProfile)

  useEffect(() => {
    mountedRef.current = true
    let cancelled = false
    api
      .getSettings()
      .then((settings) => {
        if (cancelled) return
        const parsed = parseAppSettings(settings.APP_SETTINGS)
        const nextProfile = {
          accountName: readString(parsed.accountName, defaultProfile.accountName),
          accountAvatar: readString(parsed.accountAvatar, ''),
          accountMemory: readString(parsed.accountMemory, ''),
        }
        rawSettingsRef.current = parsed
        latestProfileRef.current = nextProfile
        cacheAccountProfileFromProfile(nextProfile)
        setProfile(nextProfile)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      mountedRef.current = false
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current)
        saveTimer.current = null
        void persistProfile(latestProfileRef.current, { updateStatus: false })
      }
    }
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (params.get('section') !== 'memory') return

    const timer = window.setTimeout(() => {
      memorySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      try {
        memoryTextareaRef.current?.focus({ preventScroll: true })
      } catch {
        memoryTextareaRef.current?.focus()
      }
    }, 80)

    return () => window.clearTimeout(timer)
  }, [location.search])

  function updateProfile(patch: Partial<ProfileSettings>) {
    setProfile((current) => {
      const next = { ...current, ...patch }
      latestProfileRef.current = next
      scheduleSave(next)
      return next
    })
  }

  function scheduleSave(nextProfile: ProfileSettings) {
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void saveProfile(nextProfile)
    }, 350)
  }

  async function saveProfile(nextProfile = profile) {
    latestProfileRef.current = nextProfile
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    await persistProfile(nextProfile, { updateStatus: true })
  }

  async function persistProfile(nextProfile: ProfileSettings, options: { updateStatus: boolean }) {
    if (options.updateStatus) {
      setSaving(true)
      setSaved(false)
    }
    const nextSettings = { ...rawSettingsRef.current, ...nextProfile }
    rawSettingsRef.current = nextSettings
    cacheAccountProfileFromProfile(nextProfile)
    try {
      await api.saveSettings({ APP_SETTINGS: JSON.stringify(nextSettings) })
      window.dispatchEvent(new Event(settingsUpdatedEvent))
      if (options.updateStatus && mountedRef.current) {
        setSaved(true)
        window.setTimeout(() => {
          if (mountedRef.current) setSaved(false)
        }, 1600)
      }
    } finally {
      if (options.updateStatus && mountedRef.current) setSaving(false)
    }
  }

  async function updateAvatar(file: File | null) {
    if (!file || !file.type.startsWith('image/')) return
    const avatar = await createOptimizedAvatar(file).catch(() => readFileAsDataUrl(file))
    updateProfile({ accountAvatar: avatar })
  }

  return (
    <div className="agenthub-themed-page flex h-screen overflow-hidden bg-[#f5f4ef] text-neutral-950">
      <SessionList />
      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-8">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
          <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start gap-5">
              <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-2xl border border-neutral-200 bg-[#f7f7f4]">
                {profile.accountAvatar ? (
                  <img
                    src={profile.accountAvatar}
                    alt={profile.accountName}
                    className="h-full w-full object-cover"
                    decoding="async"
                    draggable={false}
                  />
                ) : (
                  <div className="grid h-full w-full place-items-center text-neutral-400">
                    <UserCircle className="h-12 w-12" />
                  </div>
                )}
                <label className="absolute bottom-2 right-2 grid h-8 w-8 cursor-pointer place-items-center rounded-full bg-neutral-950 text-white shadow-lg">
                  <Camera className="h-4 w-4" />
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                      void updateAvatar(event.currentTarget.files?.[0] ?? null)
                      event.currentTarget.value = ''
                    }}
                  />
                </label>
              </div>

              <div className="min-w-[260px] flex-1">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h1 className="text-xl font-semibold tracking-normal">个人资料</h1>
                  </div>
                  <StatusBadge loading={loading || saving} saved={saved} />
                </div>

                <label className="mt-5 block">
                  <span className="mb-2 block text-sm font-medium text-neutral-700">昵称</span>
                  <input
                    value={profile.accountName}
                    onChange={(event) => updateProfile({ accountName: event.target.value })}
                    className="h-11 w-full rounded-xl border border-neutral-200 bg-[#fafaf7] px-3 text-sm text-neutral-950 outline-none transition focus:border-neutral-400 focus:bg-white"
                    maxLength={32}
                    placeholder="You"
                  />
                </label>
              </div>
            </div>
          </section>

          <section
            id="agent-memory"
            ref={memorySectionRef}
            className="scroll-mt-6 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold tracking-normal">希望 Agent 记住</h2>
                <p className="mt-1 text-sm text-neutral-500">写你的沟通偏好、长期背景、代码风格或常用约束。</p>
              </div>
              <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs text-neutral-500">
                {profile.accountMemory.trim().length} 字
              </span>
            </div>
            <textarea
              ref={memoryTextareaRef}
              value={profile.accountMemory}
              onChange={(event) => updateProfile({ accountMemory: event.target.value })}
              className="mt-4 min-h-[260px] w-full resize-y rounded-xl border border-neutral-200 bg-[#fafaf7] p-4 text-sm leading-6 text-neutral-950 outline-none transition placeholder:text-neutral-400 focus:border-neutral-400 focus:bg-white"
              placeholder={'例如：\n- 我喜欢简洁直接的回答。\n- 写代码时优先保持现有架构和命名风格。\n- 默认用中文沟通，必要时给出英文术语。'}
            />
          </section>

          <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold tracking-normal">USER.md 预览</h2>
            <pre className="mt-3 max-h-60 overflow-auto rounded-xl bg-neutral-950 p-4 text-xs leading-6 text-neutral-100">
              {renderUserMd(profile)}
            </pre>
          </section>
        </div>
      </main>
    </div>
  )
}

function StatusBadge({ loading, saved }: { loading: boolean; saved: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-2 rounded-full px-3 text-xs font-medium',
        loading
          ? 'bg-amber-50 text-amber-700'
          : saved
            ? 'bg-emerald-50 text-emerald-700'
            : 'bg-neutral-100 text-neutral-500',
      )}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
      {loading ? '保存中' : saved ? '已保存' : '自动保存'}
    </span>
  )
}

function parseAppSettings(value?: string) {
  if (!value) return {}
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}

function readString(value: unknown, fallback: string) {
  return typeof value === 'string' ? value : fallback
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function createOptimizedAvatar(file: File) {
  const dataUrl = await readFileAsDataUrl(file)
  const image = await loadImage(dataUrl)
  const maxSize = 256
  const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return dataUrl
  context.drawImage(image, 0, 0, width, height)
  const webp = canvas.toDataURL('image/webp', 0.82)
  if (webp.startsWith('data:image/webp')) return webp
  return canvas.toDataURL('image/jpeg', 0.84)
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = src
  })
}

function renderUserMd(profile: ProfileSettings) {
  const lines = ['# USER.md', '', `昵称：${profile.accountName.trim() || 'You'}`]
  const memory = profile.accountMemory.trim()
  if (memory) {
    lines.push('', '## 希望 Agent 记住', memory)
  } else {
    lines.push('', '## 希望 Agent 记住', '暂未填写。')
  }
  return lines.join('\n')
}
