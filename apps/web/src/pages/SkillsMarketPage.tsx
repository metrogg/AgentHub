import { useEffect, useState } from 'react'
import { ArrowLeft, Download, ExternalLink, Loader2, RefreshCw, Search, Wand2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import SessionList from '../components/chat/SessionList'
import { api, type SkillhubSearchItem, type SkillSummary } from '../lib/api'
import { cn } from '../lib/utils'

const defaultMarketUrl = 'https://www.skillhub.cn/skills'
const defaultQuery = 'skillhub'

export default function SkillsMarketPage() {
  const navigate = useNavigate()
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [sourceUrl, setSourceUrl] = useState('')
  const [query, setQuery] = useState(defaultQuery)
  const [results, setResults] = useState<SkillhubSearchItem[]>([])
  const [installing, setInstalling] = useState(false)
  const [installingSlug, setInstallingSlug] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [searching, setSearching] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    void refreshSkills()
    void searchSkillhub(defaultQuery)
  }, [])

  async function refreshSkills() {
    setLoading(true)
    try {
      const result = await api.listSkills()
      setSkills(result.items)
    } catch (error: any) {
      setMessage(error?.message || '读取 skills 失败')
    } finally {
      setLoading(false)
    }
  }

  async function installSkill() {
    const trimmed = sourceUrl.trim()
    if (!trimmed || installing) return
    setInstalling(true)
    setMessage('')
    try {
      const result = await api.installSkill({ sourceUrl: trimmed })
      setMessage(result.message)
      setSourceUrl('')
      await refreshSkills()
    } catch (error: any) {
      setMessage(error?.message || '安装 skill 失败')
    } finally {
      setInstalling(false)
    }
  }

  async function searchSkillhub(nextQuery = query) {
    const trimmed = nextQuery.trim()
    if (!trimmed || searching) return
    setSearching(true)
    setMessage('')
    try {
      const result = await api.searchSkillhub(trimmed)
      setResults(result.items)
      if (!result.items.length) setMessage('SkillHub 没有找到匹配的技能')
    } catch (error: any) {
      setResults([])
      setMessage(error?.message || 'SkillHub 搜索失败')
    } finally {
      setSearching(false)
    }
  }

  async function installFromSkillhub(slug: string) {
    if (!slug || installingSlug) return
    setInstallingSlug(slug)
    setMessage('')
    try {
      const result = await api.installSkillhub(slug)
      setMessage(result.message)
      await refreshSkills()
    } catch (error: any) {
      setMessage(error?.message || `安装 ${slug} 失败`)
    } finally {
      setInstallingSlug(null)
    }
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[#f7f5f1] text-neutral-950">
      <SessionList />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-5">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => navigate('/agent-world')}
              className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900"
              aria-label="返回 Agent Group"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <Wand2 className="h-4 w-4 text-emerald-700" />
            <span className="text-sm font-semibold">Skills 广场</span>
            <span className="text-sm text-neutral-300">/</span>
            <span className="truncate text-sm text-neutral-500">下载并嵌入 Agent</span>
          </div>
          <button
            type="button"
            onClick={refreshSkills}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 text-sm font-medium hover:bg-neutral-50"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            刷新
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(360px,440px)_minmax(0,1fr)] overflow-hidden">
          <aside className="min-h-0 overflow-y-auto border-r border-neutral-200 bg-white p-5">
            <section className="rounded-lg border border-neutral-200 bg-[#fbfbf8] p-4">
              <div className="text-sm font-semibold">安装 Skill</div>
              <div className="mt-3 flex items-center gap-2 rounded-md border border-neutral-200 bg-white px-3">
                <Download className="h-4 w-4 text-neutral-400" />
                <input
                  value={sourceUrl}
                  onChange={(event) => setSourceUrl(event.target.value)}
                  placeholder="粘贴 SKILL.md / GitHub skill 文件夹链接"
                  className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
                />
              </div>
              <button
                type="button"
                onClick={installSkill}
                disabled={installing || !sourceUrl.trim()}
                className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-neutral-950 text-sm font-medium text-white hover:bg-neutral-800 disabled:bg-neutral-200"
              >
                {installing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {installing ? '正在安装' : '安装到本机'}
              </button>
              {message && <div className="mt-3 rounded-md bg-white px-3 py-2 text-xs leading-5 text-neutral-500">{message}</div>}
            </section>

            <section className="mt-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold">已安装 Skills</h2>
                <span className="text-xs text-neutral-400">{skills.length}</span>
              </div>
              <div className="space-y-2">
                {skills.map((skill) => (
                  <article key={`${skill.source}:${skill.id}`} className="rounded-lg border border-neutral-200 bg-white p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{skill.name}</div>
                        <div className="mt-1 truncate font-mono text-[11px] text-neutral-400">skill:{skill.id}</div>
                      </div>
                      <span className="shrink-0 rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-700">{skill.source}</span>
                    </div>
                    <p className="mt-2 line-clamp-3 text-xs leading-5 text-neutral-500">{skill.description || '无描述'}</p>
                  </article>
                ))}
                {!skills.length && <div className="rounded-lg border border-dashed border-neutral-200 px-4 py-8 text-center text-sm text-neutral-400">暂无 skills</div>}
              </div>
            </section>
          </aside>

          <section className="flex min-h-0 flex-col bg-[#f7f5f1]">
            <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 bg-white px-4 py-3">
              <Search className="h-4 w-4 text-neutral-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void searchSkillhub()
                }}
                placeholder="搜索 SkillHub 技能，例如：web、ppt、data"
                className="h-9 min-w-0 flex-1 rounded-md border border-neutral-200 px-3 text-sm outline-none focus:border-emerald-700"
              />
              <button
                type="button"
                onClick={() => void searchSkillhub()}
                disabled={searching || !query.trim()}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 text-sm font-medium hover:bg-neutral-50"
              >
                {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                搜索
              </button>
              <a
                href={defaultMarketUrl}
                target="_blank"
                rel="noreferrer"
                className="grid h-9 w-9 place-items-center rounded-md border border-neutral-200 bg-white text-neutral-500 hover:bg-neutral-50"
                aria-label="打开 SkillHub 官网"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-neutral-950">SkillHub 商店</h2>
                    <p className="mt-1 text-xs text-neutral-500">通过本机 skillhub CLI 搜索和安装，不再依赖 iframe。</p>
                  </div>
                  <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                    {results.length} results
                  </span>
                </div>

                <div className="mt-4 grid gap-3 xl:grid-cols-2">
                  {results.map((item) => {
                    const installed = skills.some((skill) => skill.id === item.slug)
                    return (
                      <article key={item.slug} className="flex min-h-44 flex-col rounded-lg border border-neutral-200 bg-[#fbfbf8] p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-neutral-950">{item.title || item.slug}</div>
                            <div className="mt-1 truncate font-mono text-[11px] text-neutral-400">{item.slug}</div>
                          </div>
                          {item.version && <span className="shrink-0 rounded-md bg-white px-2 py-1 text-xs text-neutral-500">v{item.version}</span>}
                        </div>
                        <p className="mt-3 line-clamp-4 flex-1 text-xs leading-5 text-neutral-500">{item.description || '暂无描述'}</p>
                        <button
                          type="button"
                          onClick={() => void installFromSkillhub(item.slug)}
                          disabled={installed || Boolean(installingSlug)}
                          className="mt-4 inline-flex h-9 items-center justify-center gap-2 rounded-md bg-neutral-950 px-3 text-sm font-medium text-white hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-500"
                        >
                          {installingSlug === item.slug ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                          {installed ? '已安装' : installingSlug === item.slug ? '正在安装' : '安装'}
                        </button>
                      </article>
                    )
                  })}
                </div>

                {!searching && !results.length && (
                  <div className="mt-4 rounded-lg border border-dashed border-neutral-200 px-4 py-10 text-center text-sm text-neutral-400">
                    输入关键词搜索 SkillHub 技能
                  </div>
                )}

                {searching && (
                  <div className="mt-4 grid h-32 place-items-center rounded-lg border border-dashed border-neutral-200 text-sm text-neutral-400">
                    <Loader2 className="mb-2 h-5 w-5 animate-spin" />
                    正在搜索 SkillHub
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
