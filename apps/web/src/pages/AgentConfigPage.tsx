import { FormEvent, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Bot,
  Check,
  Link2,
  MessageCircle,
  Plus,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { cn } from '../lib/utils'

type AgentTone = '默认' | '严谨' | '创造' | '执行'
type ChannelType = '网页聊天' | 'API 接入' | '飞书' | '企业微信'

interface AgentProfile {
  name: string
  tone: AgentTone
  description: string
  instruction: string
  opening: string
  visibility: '仅自己' | '团队可见'
}

interface ChannelConfig {
  id: string
  name: string
  type: ChannelType
  endpoint: string
  enabled: boolean
}

const storageKey = 'agenthub.agentConfig'

const defaultProfile: AgentProfile = {
  name: '扣子',
  tone: '默认',
  description: '温和理性，擅长把复杂问题拆成清晰步骤。长期陪伴型伙伴，偏好主动复盘与持续跟进。',
  instruction: '优先澄清目标，拆解任务，给出可执行步骤。遇到代码任务时先理解上下文，再小步实现并验证。',
  opening: '你好，我是扣子。把要做的事发给我，我会帮你拆开推进。',
  visibility: '仅自己',
}

const defaultChannels: ChannelConfig[] = []

export default function AgentConfigPage() {
  const navigate = useNavigate()
  const [profile, setProfile] = useState<AgentProfile>(defaultProfile)
  const [channels, setChannels] = useState<ChannelConfig[]>(defaultChannels)
  const [editing, setEditing] = useState(false)
  const [addingChannel, setAddingChannel] = useState(false)
  const [draftChannel, setDraftChannel] = useState<ChannelConfig>(newChannel())
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as { profile?: AgentProfile; channels?: ChannelConfig[] }
      if (parsed.profile) setProfile(parsed.profile)
      if (parsed.channels) setChannels(parsed.channels)
    } catch {
      // Ignore broken local config and keep defaults.
    }
  }, [])

  const enabledChannels = useMemo(() => channels.filter((item) => item.enabled).length, [channels])

  function save(nextProfile = profile, nextChannels = channels) {
    localStorage.setItem(storageKey, JSON.stringify({ profile: nextProfile, channels: nextChannels }))
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1600)
  }

  function submitProfile(event: FormEvent) {
    event.preventDefault()
    save()
    setEditing(false)
  }

  function addChannel(event: FormEvent) {
    event.preventDefault()
    if (!draftChannel.name.trim()) return
    const next = [...channels, { ...draftChannel, id: crypto.randomUUID(), enabled: true }]
    setChannels(next)
    save(profile, next)
    setDraftChannel(newChannel())
    setAddingChannel(false)
  }

  function toggleChannel(id: string) {
    const next = channels.map((item) => (item.id === id ? { ...item, enabled: !item.enabled } : item))
    setChannels(next)
    save(profile, next)
  }

  function deleteChannel(id: string) {
    const next = channels.filter((item) => item.id !== id)
    setChannels(next)
    save(profile, next)
  }

  return (
    <div className="min-h-screen bg-white text-neutral-950">
      <header className="flex h-14 items-center justify-between border-b border-neutral-200 px-4">
        <div className="text-sm font-medium">Agent 配置页</div>
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-950"
          aria-label="关闭"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <main className="mx-auto w-full max-w-[860px] px-8 py-10">
        <section className="flex items-start gap-6">
          <div className="grid h-28 w-28 shrink-0 place-items-center overflow-hidden rounded-full border border-neutral-200 bg-[#eef8f6] text-[#9abdb7] shadow-[0_16px_48px_rgba(15,23,42,0.08)]">
            <Bot className="h-12 w-12" />
          </div>

          <div className="min-w-0 flex-1 pt-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-normal">{profile.name}</h1>
              <select
                value={profile.tone}
                onChange={(event) => {
                  const next = { ...profile, tone: event.target.value as AgentTone }
                  setProfile(next)
                  save(next, channels)
                }}
                className="h-9 rounded-lg border border-neutral-200 bg-white px-3 text-sm outline-none transition hover:bg-neutral-50 focus:border-neutral-400"
              >
                <option>默认</option>
                <option>严谨</option>
                <option>创造</option>
                <option>执行</option>
              </select>
            </div>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-neutral-600">{profile.description}</p>
            <div className="mt-4 flex flex-wrap gap-2 text-xs text-neutral-500">
              <Pill icon={ShieldCheck} text={profile.visibility} />
              <Pill icon={MessageCircle} text={`${channels.length} 个渠道`} />
              <Pill icon={Check} text={`${enabledChannels} 个启用`} />
            </div>
          </div>

          <button
            type="button"
            onClick={() => setEditing(true)}
            className="mt-7 h-10 rounded-xl border border-neutral-200 bg-white px-5 text-sm font-medium shadow-sm transition hover:bg-neutral-50"
          >
            编辑信息
          </button>
        </section>

        {editing && (
          <form onSubmit={submitProfile} className="mt-8 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Agent 名称" value={profile.name} onChange={(name) => setProfile({ ...profile, name })} />
              <label className="text-sm">
                <span className="mb-2 block text-neutral-600">可见范围</span>
                <select
                  value={profile.visibility}
                  onChange={(event) => setProfile({ ...profile, visibility: event.target.value as AgentProfile['visibility'] })}
                  className="h-10 w-full rounded-xl border border-neutral-200 px-3 outline-none focus:border-neutral-400"
                >
                  <option>仅自己</option>
                  <option>团队可见</option>
                </select>
              </label>
            </div>
            <TextField label="简介" value={profile.description} onChange={(description) => setProfile({ ...profile, description })} rows={3} />
            <TextField label="系统提示词" value={profile.instruction} onChange={(instruction) => setProfile({ ...profile, instruction })} rows={4} />
            <TextField label="开场白" value={profile.opening} onChange={(opening) => setProfile({ ...profile, opening })} rows={2} />
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setEditing(false)} className="h-10 rounded-xl border border-neutral-200 px-4 text-sm hover:bg-neutral-50">
                取消
              </button>
              <button type="submit" className="h-10 rounded-xl bg-neutral-950 px-5 text-sm font-medium text-white hover:bg-neutral-800">
                保存信息
              </button>
            </div>
          </form>
        )}

        <section className="mt-10">
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-sm font-semibold">渠道连接</h2>
            <button
              type="button"
              onClick={() => setAddingChannel(true)}
              className="inline-flex h-9 items-center gap-2 rounded-xl px-3 text-sm text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-950"
            >
              <Plus className="h-4 w-4" />
              增加渠道
            </button>
          </div>

          {channels.length === 0 ? (
            <div className="grid min-h-[300px] place-items-center rounded-2xl border border-dashed border-neutral-200">
              <div className="text-center">
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-neutral-200 text-neutral-700">
                  <Link2 className="h-5 w-5" />
                </div>
                <div className="mt-7 text-lg font-semibold">暂无渠道配置</div>
                <p className="mt-3 text-sm text-neutral-400">点击「添加渠道」，选择需要的渠道并开始连接</p>
                <button
                  type="button"
                  onClick={() => setAddingChannel(true)}
                  className="mt-9 h-11 rounded-xl bg-neutral-950 px-6 text-sm font-medium text-white transition hover:bg-neutral-800"
                >
                  添加渠道
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {channels.map((channel) => (
                <div key={channel.id} className="flex items-center gap-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
                  <div className="grid h-11 w-11 place-items-center rounded-xl bg-neutral-100 text-neutral-600">
                    <Link2 className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div className="truncate text-sm font-medium">{channel.name}</div>
                      <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500">{channel.type}</span>
                    </div>
                    <div className="mt-1 truncate text-xs text-neutral-400">{channel.endpoint || '未配置 endpoint'}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleChannel(channel.id)}
                    className={cn('relative h-5 w-9 rounded-full transition', channel.enabled ? 'bg-neutral-950' : 'bg-neutral-200')}
                    aria-label={channel.enabled ? '停用渠道' : '启用渠道'}
                  >
                    <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white transition', channel.enabled ? 'left-4' : 'left-0.5')} />
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteChannel(channel.id)}
                    className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 transition hover:bg-red-50 hover:text-red-500"
                    aria-label="删除渠道"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {addingChannel && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/20 px-4">
          <form onSubmit={addChannel} className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl">
            <div className="mb-5 flex items-center justify-between">
              <h3 className="text-base font-semibold">添加渠道</h3>
              <button type="button" onClick={() => setAddingChannel(false)} className="grid h-8 w-8 place-items-center rounded-md hover:bg-neutral-100">
                <X className="h-4 w-4" />
              </button>
            </div>
            <Field label="渠道名称" value={draftChannel.name} onChange={(name) => setDraftChannel({ ...draftChannel, name })} placeholder="例如：官网聊天窗口" />
            <label className="mt-4 block text-sm">
              <span className="mb-2 block text-neutral-600">渠道类型</span>
              <select
                value={draftChannel.type}
                onChange={(event) => setDraftChannel({ ...draftChannel, type: event.target.value as ChannelType })}
                className="h-10 w-full rounded-xl border border-neutral-200 px-3 outline-none focus:border-neutral-400"
              >
                <option>网页聊天</option>
                <option>API 接入</option>
                <option>飞书</option>
                <option>企业微信</option>
              </select>
            </label>
            <Field label="Endpoint / 回调地址" value={draftChannel.endpoint} onChange={(endpoint) => setDraftChannel({ ...draftChannel, endpoint })} placeholder="https://example.com/webhook" />
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setAddingChannel(false)} className="h-10 rounded-xl border border-neutral-200 px-4 text-sm hover:bg-neutral-50">
                取消
              </button>
              <button type="submit" className="h-10 rounded-xl bg-neutral-950 px-5 text-sm font-medium text-white hover:bg-neutral-800">
                添加
              </button>
            </div>
          </form>
        </div>
      )}

      {saved && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-neutral-950 px-4 py-2 text-sm text-white shadow-xl">
          已保存
        </div>
      )}
    </div>
  )
}

function newChannel(): ChannelConfig {
  return {
    id: '',
    name: '',
    type: '网页聊天',
    endpoint: '',
    enabled: true,
  }
}

function Pill({ icon: Icon, text }: { icon: typeof Settings2; text: string }) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-neutral-200 px-2.5">
      <Icon className="h-3.5 w-3.5 text-neutral-400" />
      {text}
    </span>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  return (
    <label className="mt-4 block text-sm">
      <span className="mb-2 block text-neutral-600">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-10 w-full rounded-xl border border-neutral-200 px-3 outline-none transition placeholder:text-neutral-300 focus:border-neutral-400"
      />
    </label>
  )
}

function TextField({
  label,
  value,
  onChange,
  rows,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  rows: number
}) {
  return (
    <label className="mt-4 block text-sm">
      <span className="mb-2 block text-neutral-600">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        className="w-full resize-none rounded-xl border border-neutral-200 px-3 py-2 leading-6 outline-none transition focus:border-neutral-400"
      />
    </label>
  )
}
