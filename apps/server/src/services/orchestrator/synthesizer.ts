import { logger } from '../../lib/logger'
import { streamReply } from '../llm'
import type { BlackboardEntry } from '../blackboard'
import type { ExecutionPlan, TaskResult } from './types'

export class Synthesizer {
  async synthesize(
    plan: ExecutionPlan,
    results: TaskResult[],
    conflictReports: Array<{ filePath: string; resolution: string; notes?: string }> = [],
    blackboardEntries: BlackboardEntry[] = [],
  ): Promise<string> {
    const sections = results
      .filter((r) => r.status === 'done')
      .map((r) => ({
        agent: r.agentName,
        task: r.taskId,
        output: r.output.slice(0, 3000),
        artifacts: r.artifacts,
      }))

    if (sections.length === 0) {
      return buildTransparentResultDump(results, '没有成功完成的子任务，无法生成模型汇总。')
    }

    const system = `你是 AgentHub 的协调器。基于各子 Agent 的产出，生成一份统一的进展报告。

你必须严格使用以下固定结构输出（Markdown 格式，中文）：

## 执行摘要
用 2-3 句话概括整体进展、成功完成的任务数和关键成果。

## 各 Agent 产出
对每个成功的子任务，使用三级标题：
### {agentName} — {taskTitle}
- 核心产出摘要
- 关键文件/产物（如有）

## 冲突处理
如有代码冲突，列出每个文件的处理结果；如无冲突，写"无代码冲突"。

## 风险与建议
指出不一致、潜在风险或需要人工决策的地方；如没有，写"未发现明显风险"。

## 下一步行动
给出 1-3 条具体、可执行的后续建议。

注意事项：
1. 整合为连贯叙述，消除重复，统一术语
2. 明确标注各部分的贡献者
3. 使用 Markdown 格式，中文回复
4. 严禁省略任何一级标题
5. 如果存在失败任务，必须在「执行摘要」中明确指出失败数量和原因，严禁掩盖或编造成功信息`

    const conflictInfo = conflictReports.length
      ? `代码冲突情况：\n${conflictReports.map((c) => `- ${c.filePath}: ${c.resolution}${c.notes ? ` (${c.notes})` : ''}`).join('\n')}`
      : '无代码冲突。'

    const typedContext = formatTypedBlackboardEntries(blackboardEntries)

    const prompt = `
协作目标：${plan.goal}
任务总数：${results.length}
成功完成：${sections.length}
失败：${results.filter((r) => r.status === 'failed').length}

${conflictInfo}

结构化 Blackboard：
${typedContext}

各 Agent 当前最新产出：
${JSON.stringify(sections, null, 2)}

请生成汇总报告。
`

    try {
      let output = ''
      for await (const delta of streamReply([{ role: 'user', content: prompt }], system)) {
        output += delta
      }
      return output.trim() || buildTransparentResultDump(results, '汇总模型返回了空内容。')
    } catch (error: any) {
      logger.error({ err: error?.message }, 'Synthesizer LLM call failed')
      return buildTransparentResultDump(
        results,
        `汇总模型调用失败：${error?.message || 'unknown error'}`,
      )
    }
  }
}

function formatTypedBlackboardEntries(entries: BlackboardEntry[]): string {
  const typed = entries
    .map((entry) => {
      const value = entry.value as { schemaType?: string; summary?: string } | null
      if (!value?.schemaType) return null
      return {
        key: entry.key,
        schemaType: value.schemaType,
        summary: value.summary ?? '',
      }
    })
    .filter((entry): entry is { key: string; schemaType: string; summary: string } => Boolean(entry))

  if (typed.length === 0) return '暂无结构化条目。'

  return typed
    .slice(0, 30)
    .map((entry) => `- [${entry.schemaType}] ${entry.key}: ${entry.summary}`)
    .join('\n')
}

function buildTransparentResultDump(results: TaskResult[], reason: string): string {
  const lines = [
    '## 汇总模型未生成最终总结',
    reason,
    '',
    '以下只展示系统记录到的真实子任务结果，不伪装成 Orchestrator 的模型总结。',
    '',
  ]

  if (results.length === 0) {
    lines.push('- 没有记录到任何子任务结果。')
    return lines.join('\n')
  }

  for (const result of results) {
    const artifacts = result.artifacts
      .map((artifact) => {
        const item = artifact as { filePath?: string; path?: string; title?: string }
        return item.filePath || item.path || item.title
      })
      .filter(Boolean)
      .join(', ')
    const output = result.output.trim().replace(/\n{3,}/g, '\n\n').slice(0, 800)
    lines.push(
      `### ${result.agentName || result.agentId} — ${result.taskId}`,
      `状态：${result.status}`,
      result.error ? `错误：${result.error}` : '',
      artifacts ? `产物：${artifacts}` : '',
      output ? `输出片段：\n${output}` : '',
      '',
    )
  }

  return lines.filter((line) => line !== '').join('\n')
}
