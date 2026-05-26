import { logger } from '../../lib/logger'
import { streamReply } from '../llm'

export interface FileVariant {
  agentId: string
  agentName: string
  diff: string
  fullContent?: string
}

export interface ConflictReport {
  filePath: string
  baseContent: string
  variants: FileVariant[]
  resolution: 'auto-merged' | 'llm-resolved' | 'needs-human'
  mergedContent?: string
  notes?: string
}

export class ConflictResolver {
  async detectAndResolve(
    results: Array<{ agentId: string; agentName: string; artifacts: Array<Record<string, unknown>> }>,
    options?: { projectPath?: string; baseBranch?: string },
  ): Promise<ConflictReport[]> {
    const fileMap = new Map<string, FileVariant[]>()

    for (const result of results) {
      for (const artifact of result.artifacts) {
        const filePath = (artifact.filePath || artifact.path) as string | undefined
        if (!filePath) continue
        const diff = artifact.diff as string | undefined
        if (!diff) continue

        const list = fileMap.get(filePath) ?? []
        list.push({
          agentId: result.agentId,
          agentName: result.agentName,
          diff,
          fullContent: artifact.fullContent as string | undefined,
        })
        fileMap.set(filePath, list)
      }
    }

    const reports: ConflictReport[] = []
    for (const [filePath, variants] of fileMap) {
      if (variants.length < 2) continue

      // 优先从 Git 获取 base 内容，回退到 variants[0].fullContent
      let baseContent = ''
      if (options?.projectPath) {
        baseContent = await this.getBaseContent(options.projectPath, filePath, options.baseBranch)
      }
      if (!baseContent) {
        baseContent = variants[0]?.fullContent ?? ''
      }

      // 尝试简单合并：如果 diffs 不重叠，可以自动合并
      const autoMerged = await this.tryAutoMerge(baseContent, variants)
      if (autoMerged.ok) {
        reports.push({
          filePath,
          baseContent,
          variants,
          resolution: 'auto-merged',
          mergedContent: autoMerged.content,
        })
        continue
      }

      // LLM 3-way merge
      const llmResult = await this.llmMerge(filePath, baseContent, variants)
      reports.push(llmResult)
    }

    return reports
  }

  private async getBaseContent(projectPath: string, filePath: string, baseBranch?: string): Promise<string> {
    const base = baseBranch ?? 'main'
    try {
      const proc = Bun.spawn(['git', 'show', `${base}:${filePath}`], {
        cwd: projectPath,
        stdout: 'pipe',
        stderr: 'pipe',
        env: process.env,
      })
      const out = await new Response(proc.stdout).text()
      await proc.exited
      return out
    } catch {
      return ''
    }
  }

  private async tryAutoMerge(base: string, variants: FileVariant[]): Promise<{ ok: boolean; content?: string }> {
    // 简化：如果所有 diff 的行号范围不重叠，返回合并结果
    // 实际实现中可以用 diff 解析库，这里用启发式方法
    try {
      // 如果只有一个 Agent 修改了文件，或者 diffs 看起来不冲突
      if (variants.length === 1) return { ok: true, content: variants[0]?.fullContent || base }
      return { ok: false }
    } catch {
      return { ok: false }
    }
  }

  private async llmMerge(filePath: string, base: string, variants: FileVariant[]): Promise<ConflictReport> {
    const prompt = `
文件路径：${filePath}

原始内容：
\`\`\`
${base.slice(0, 3000)}
\`\`\`

${variants.map((v, i) => `=== ${v.agentName} 的修改 ===
\`\`\`diff
${v.diff.slice(0, 2000)}
\`\`\``).join('\n\n')}

请合并以上修改。如果两个 Agent 的修改在同一位置且不冲突，保留两者。如果冲突，选择最合理的方案并标注冲突位置。
返回 JSON：
{
  "mergedContent": "合并后的完整文件内容",
  "hasConflict": boolean,
  "notes": "说明冲突解决方式"
}
`

    try {
      let output = ''
      for await (const delta of streamReply([{ role: 'user', content: prompt }], '你是代码合并专家。')) {
        output += delta
      }

      const jsonText = extractJson(output)
      if (!jsonText) {
        return { filePath, baseContent: base, variants, resolution: 'needs-human', notes: 'LLM 未返回有效 JSON' }
      }

      const parsed = JSON.parse(jsonText) as { mergedContent?: string; hasConflict?: boolean; notes?: string }

      if (parsed.hasConflict) {
        return {
          filePath,
          baseContent: base,
          variants,
          resolution: 'needs-human',
          notes: parsed.notes || '存在冲突，需要人工决策',
        }
      }

      return {
        filePath,
        baseContent: base,
        variants,
        resolution: 'llm-resolved',
        mergedContent: parsed.mergedContent,
        notes: parsed.notes,
      }
    } catch (error: any) {
      logger.error({ err: error?.message, filePath }, 'LLM merge failed')
      return { filePath, baseContent: base, variants, resolution: 'needs-human', notes: 'LLM 合并失败' }
    }
  }
}

function extractJson(text: string): string | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) return cleaned
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : null
}
