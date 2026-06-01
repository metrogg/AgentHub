import { existsSync, watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { logger } from '../lib/logger'
import type { ExecutionTask } from './orchestrator/types'
import type { AgentProfile } from './runtime'

// ─── 类型定义 ───────────────────────────────

export interface HarnessSkill {
  id: string
  name: string
  description: string
  version: string
  systemPromptTemplate: string
  applicableCapabilities: string[]
  applicableTags: string[]
}

export interface HarnessRules {
  id: string
  name: string
  version: string
  constraints: string[]
  naming: Record<string, string>
  forbidden: string[]
  imports?: { order: string[] }
  formatting?: Record<string, unknown>
}

export interface HarnessContext {
  agent: AgentProfile
  task?: ExecutionTask
  workspacePath?: string | null
  rules?: HarnessRules[]
  blackboardRefs?: string[]
}

// ─── HarnessManager ───────────────────────────────

export class HarnessManager {
  private skills = new Map<string, HarnessSkill>()
  private rules = new Map<string, HarnessRules>()
  private watchers: ReturnType<typeof watch>[] = []
  private loadedPath: string | null = null

  /**
   * 从工作区路径加载 Harness 配置
   */
  async loadFromWorkspace(workspacePath: string): Promise<void> {
    const harnessDir = resolve(workspacePath, '.agenthub')
    if (!existsSync(harnessDir)) {
      this.clear()
      return
    }

    // 缓存：如果路径未变，跳过重新加载
    if (this.loadedPath === harnessDir) return

    this.loadedPath = harnessDir
    this.skills.clear()
    this.rules.clear()

    // 加载 Skills
    await this.loadYamlFiles<HarnessSkill>(resolve(harnessDir, 'skills'), '.skill.yml', (data, id) => {
      const parseStringArray = (value: unknown): string[] => {
        if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
        if (typeof value === 'string') {
          const trimmed = value.trim()
          if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            return trimmed.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
          }
        }
        return []
      }
      const skill: HarnessSkill = {
        id,
        name: (data.name as string) || id,
        description: (data.description as string) || '',
        version: (data.version as string) || '1.0.0',
        systemPromptTemplate: (data.systemPromptTemplate as string) || (data.system_prompt_template as string) || '',
        applicableCapabilities: parseStringArray(data.applicableCapabilities ?? data.applicable_capabilities),
        applicableTags: parseStringArray(data.applicableTags ?? data.applicable_tags),
      }
      this.skills.set(id, skill)
    })

    // 加载 Rules
    await this.loadYamlFiles<HarnessRules>(resolve(harnessDir, 'rules'), '.yml', (data, id) => {
      const rules: HarnessRules = {
        id,
        name: (data.name as string) || id,
        version: (data.version as string) || '1.0.0',
        constraints: (data.constraints as string[]) || [],
        naming: (data.naming as Record<string, string>) || {},
        forbidden: (data.forbidden as string[]) || [],
        imports: data.imports as { order: string[] } | undefined,
        formatting: data.formatting as Record<string, unknown> | undefined,
      }
      this.rules.set(id, rules)
    })

    logger.info(
      { skills: Array.from(this.skills.keys()), rules: Array.from(this.rules.keys()), workspacePath },
      'Harness loaded'
    )
  }

  /**
   * 文件监听热更新（开发时启用）
   */
  watch(workspacePath: string): void {
    const harnessDir = resolve(workspacePath, '.agenthub')
    if (!existsSync(harnessDir)) return

    const watcher = watch(harnessDir, { recursive: true }, (eventType, filename) => {
      if (typeof filename === 'string' && (filename.endsWith('.yml') || filename.endsWith('.yaml'))) {
        logger.info({ filename, eventType }, 'Harness file changed, reloading...')
        this.loadFromWorkspace(workspacePath).catch((err) =>
          logger.error({ err }, 'Harness hot-reload failed')
        )
      }
    })
    this.watchers.push(watcher)
  }

  stopWatching(): void {
    for (const w of this.watchers) {
      w.close()
    }
    this.watchers = []
  }

  getLoadedPath(): string | null {
    return this.loadedPath
  }

  // ─── 系统提示组装 ───────────────────────────────

  buildSystemPrompt(ctx: HarnessContext): string {
    const { agent, task, workspacePath } = ctx

    // 1. 匹配最佳 Skill
    const skill = this.findBestSkill(agent, task)

    // 2. 收集适用的 Rules
    const applicableRules = this.findApplicableRules(agent)

    // 3. 基础系统提示（保留原有逻辑）
    const basePrompt = [
      agent.systemPrompt || `你是 ${agent.name}，AgentHub 中的协作智能体。`,
      agent.role ? `你在群聊中的角色：${agent.role}。` : '',
      agent.description ? `能力摘要：${agent.description}。` : '',
    ]
      .filter(Boolean)
      .join('\n')

    // 4. 如果有 Skill，使用模板替换
    if (skill) {
      return this.renderSkillTemplate(skill, basePrompt, applicableRules, task, workspacePath)
    }

    // 5. 无 Skill 时，使用基础提示 + Rules
    const rulesSection = this.formatRulesSection(applicableRules)
    const parts = [
      basePrompt,
      agent.runtimeType ? `运行时绑定：${agent.runtimeType}。` : '',
      agent.capabilityTags?.length ? `能力标签：${agent.capabilityTags.join('、')}。` : '',
      agent.toolPermissions?.length ? `允许的工具范围：${agent.toolPermissions.join('、')}。` : '允许的工具范围：仅聊天。',
      agent.sandboxPolicy ? `沙箱策略：${agent.sandboxPolicy}。` : '',
      agent.contextPolicy ? `上下文策略：${agent.contextPolicy}。` : '',
      workspacePath ? `项目工作区路径：${workspacePath}。` : '',
      rulesSection,
      agent.approvalRequired
        ? '如果用户请求可能修改文件、运行命令、访问网络、部署或接触密钥，请先请求用户明确确认，再执行或给出执行指令。'
        : '',
      '你正在多 Agent 群聊中回复。请聚焦自己的角色，用中文给出清晰、可执行的回答；如需要其他 Agent 接续，请明确写出交接需求。',
    ]

    return parts.filter(Boolean).join('\n')
  }

  // ─── 内部方法 ───────────────────────────────

  private findBestSkill(agent: AgentProfile, _task?: ExecutionTask): HarnessSkill | undefined {
    const caps = agent.capabilityTags || []
    for (const skill of this.skills.values()) {
      if (skill.applicableCapabilities.some((c) => caps.includes(c))) {
        return skill
      }
      if (skill.applicableTags.some((t) => caps.includes(t))) {
        return skill
      }
    }
    return undefined
  }

  private findApplicableRules(_agent: AgentProfile): HarnessRules[] {
    // 当前实现：加载所有 Rules
    // 后续可扩展：按 Agent role / capabilityTags 过滤
    return Array.from(this.rules.values())
  }

  private renderSkillTemplate(
    skill: HarnessSkill,
    basePrompt: string,
    rules: HarnessRules[],
    task?: ExecutionTask,
    workspacePath?: string | null
  ): string {
    const rulesSection = this.formatRulesSection(rules)
    const taskDescription = task ? `任务：${task.title}\n说明：${task.description}` : ''

    let rendered = skill.systemPromptTemplate
    rendered = rendered.replace(/\{\{BASE_PROMPT\}\}/g, basePrompt)
    rendered = rendered.replace(/\{\{RULES\}\}/g, rulesSection)
    rendered = rendered.replace(/\{\{TASK_DESCRIPTION\}\}/g, taskDescription)
    rendered = rendered.replace(/\{\{WORKSPACE_PATH\}\}/g, workspacePath || '')
    rendered = rendered.replace(/\{\{AGENT_NAME\}\}/g, skill.name)

    // 支持 {{RULES.xxx}} 格式：替换为对应 rules 的内容
    for (const rule of rules) {
      rendered = rendered.replace(
        new RegExp(`\\{\\{RULES\\.${rule.id}\\}\\}`, 'g'),
        this.formatSingleRule(rule)
      )
    }

    return rendered
  }

  private formatRulesSection(rules: HarnessRules[]): string {
    if (rules.length === 0) return ''
    const sections = rules.map((r) => this.formatSingleRule(r))
    return `\n【规范约束】\n${sections.join('\n\n')}\n【规范结束】\n`
  }

  private formatSingleRule(rule: HarnessRules): string {
    const parts: string[] = []
    if (rule.constraints.length) {
      parts.push(`约束：\n${rule.constraints.map((c) => `- ${c}`).join('\n')}`)
    }
    if (rule.forbidden.length) {
      parts.push(`禁止：\n${rule.forbidden.map((f) => `- ${f}`).join('\n')}`)
    }
    if (Object.keys(rule.naming).length) {
      parts.push(`命名规范：\n${Object.entries(rule.naming).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`)
    }
    return `### ${rule.name}\n${parts.join('\n')}`
  }

  private async loadYamlFiles<T>(
    dir: string,
    suffix: string,
    callback: (data: Record<string, unknown>, id: string) => void
  ): Promise<void> {
    if (!existsSync(dir)) return
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(dir).catch(() => [])
    for (const file of files) {
      if (!file.endsWith(suffix)) continue
      const id = file.slice(0, -suffix.length)
      const content = await readFile(resolve(dir, file), 'utf8').catch(() => '')
      if (!content) continue
      try {
        // 简单 YAML 解析（只处理顶层键值对）
        const data = this.parseSimpleYaml(content)
        callback(data, id)
      } catch (err) {
        logger.error({ err, file }, 'Failed to parse harness YAML')
      }
    }
  }

  /**
   * 简单 YAML 解析器：只处理顶层键值对和简单数组
   * 不支持嵌套对象和复杂 YAML 特性
   */
  private parseSimpleYaml(content: string): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    const lines = content.split(/\r?\n/)
    let currentKey: string | null = null
    let currentArray: string[] = []
    let collectingArray = false
    let collectingMultiline = false
    let multilineValue = ''

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const trimmed = line.trim()

      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('#')) {
        if (collectingArray && currentKey) {
          result[currentKey] = currentArray
          collectingArray = false
          currentArray = []
        }
        continue
      }

      // 数组元素
      if (trimmed.startsWith('- ')) {
        if (!collectingArray) {
          collectingArray = true
        }
        currentArray.push(trimmed.slice(2).trim())
        continue
      }

      // 如果之前在收集数组，但现在遇到新的键，保存数组
      if (collectingArray && currentKey) {
        result[currentKey] = currentArray
        collectingArray = false
        currentArray = []
      }

      // 键值对
      const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(trimmed)
      if (match) {
        const key = match[1]!
      const value = match[2]!
        currentKey = key

        if (value === '|' || value === '>') {
          // 多行字符串开始
          collectingMultiline = true
          multilineValue = ''
          continue
        }

        if (value) {
          result[key] = this.parseYamlValue(value)
        }
        continue
      }

      // 多行字符串内容
      if (collectingMultiline && currentKey) {
        // 检查是否是下一个键的开始
        const nextKeyMatch = line.match(/^[A-Za-z0-9_-]+:/)
        if (nextKeyMatch && !line.startsWith(' ') && !line.startsWith('\t')) {
          result[currentKey] = multilineValue.trim()
          collectingMultiline = false
          // 重新处理这一行
          const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
          if (m) {
            currentKey = m[1]!
            if (m[2]) result[m[1]!] = this.parseYamlValue(m[2]!)
          }
        } else {
          multilineValue += line + '\n'
        }
        continue
      }
    }

    // 收尾
    if (collectingArray && currentKey) {
      result[currentKey] = currentArray
    }
    if (collectingMultiline && currentKey) {
      result[currentKey] = multilineValue.trim()
    }

    return result
  }

  private parseYamlValue(value: string): string | number | boolean {
    const trimmed = value.trim()
    if (trimmed === 'true') return true
    if (trimmed === 'false') return false
    if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10)
    // 去掉引号
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
        return trimmed.slice(1, -1)
    }
    return trimmed
  }

  private clear(): void {
    this.skills.clear()
    this.rules.clear()
    this.loadedPath = null
  }
}

export const harnessManager = new HarnessManager()
