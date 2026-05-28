import { logger } from '../../lib/logger'
import { streamReply } from '../llm'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

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
  resolution: 'auto-merged' | 'llm-resolved' | 'needs-human' | 'human-approved' | 'human-rejected' | 'human-overridden'
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
    // 使用 git apply --check 来验证多个 patch 是否可以无冲突应用
    const tmpDir = join(tmpdir(), `agenthub-merge-${crypto.randomUUID()}`)
    mkdirSync(tmpDir, { recursive: true })
    try {
      const baseFile = join(tmpDir, 'base')
      await Bun.write(baseFile, base)

      const patchFiles: string[] = []
      for (let i = 0; i < variants.length; i++) {
        const variant = variants[i]!
        const patchFile = join(tmpDir, `patch-${i}.diff`)
        await Bun.write(patchFile, variant.diff)
        patchFiles.push(patchFile)
      }

      // Step 1: 逐个检查 patch 能否应用到 base
      const workingFile = join(tmpDir, 'working')
      await Bun.write(workingFile, base)
      for (let i = 0; i < patchFiles.length; i++) {
        const patchPath = patchFiles[i]!
        const proc = Bun.spawn(['git', 'apply', '--check', '-p0', patchPath], {
          cwd: tmpDir,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const exitCode = await proc.exited
        if (exitCode !== 0) {
          return { ok: false }
        }
      }

      // Step 2: 依次应用所有 patch
      for (let i = 0; i < patchFiles.length; i++) {
        const patchPath = patchFiles[i]!
        const proc = Bun.spawn(['git', 'apply', '-p0', patchPath], {
          cwd: tmpDir,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        await proc.exited
      }

      const merged = await Bun.file(workingFile).text()
      return { ok: true, content: merged }
    } catch {
      return { ok: false }
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore cleanup errors */ }
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
