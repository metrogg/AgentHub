import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../../lib/logger'
import { streamReply } from '../llm'

export interface FileVariant {
  agentId: string
  agentName: string
  diff: string
  fullContent?: string
}

export interface MergeReport {
  filePath: string
  baseContent: string
  variants: FileVariant[]
  resolution: 'auto-merged' | 'llm-resolved' | 'needs-human' | 'human-approved' | 'human-rejected' | 'human-overridden'
  mergedContent?: string
  notes?: string
}

/**
 * Reviews competing file artifacts produced by agent workdirs.
 *
 * The current execution model does not merge agent workdirs back into the project
 * automatically. This resolver only produces structured merge reports for the
 * orchestrator event stream. Git is used opportunistically to read a base file
 * when the user workspace already has a repository.
 */
export class ExecutionMergeResolver {
  async detectAndResolve(
    results: Array<{ agentId: string; agentName: string; artifacts: Array<Record<string, unknown>> }>,
    options?: { projectPath?: string; baseBranch?: string },
  ): Promise<MergeReport[]> {
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

    const reports: MergeReport[] = []
    for (const [filePath, variants] of fileMap) {
      if (variants.length < 2) continue

      let baseContent = ''
      if (options?.projectPath) {
        baseContent = await this.getBaseContent(options.projectPath, filePath, options.baseBranch)
      }
      if (!baseContent) {
        baseContent = variants[0]?.fullContent ?? ''
      }

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

      reports.push(await this.llmMerge(filePath, baseContent, variants))
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
      const timeout = setTimeout(() => {
        try {
          proc.kill()
        } catch {}
      }, 30000)
      try {
        const out = await new Response(proc.stdout).text()
        await proc.exited
        return out
      } finally {
        clearTimeout(timeout)
      }
    } catch {
      return ''
    }
  }

  private async tryAutoMerge(base: string, variants: FileVariant[]): Promise<{ ok: boolean; content?: string }> {
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

      for (let i = 0; i < patchFiles.length; i++) {
        const patchPath = patchFiles[i]!
        const proc = Bun.spawn(['git', 'apply', '-p0', patchPath], {
          cwd: tmpDir,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const exitCode = await proc.exited
        if (exitCode !== 0) {
          return { ok: false }
        }
      }

      const merged = await Bun.file(workingFile).text()
      return { ok: true, content: merged }
    } catch {
      return { ok: false }
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        // Best-effort temp cleanup.
      }
    }
  }

  private async llmMerge(filePath: string, base: string, variants: FileVariant[]): Promise<MergeReport> {
    const prompt = `
File path: ${filePath}

Base content:
\`\`\`
${base.slice(0, 3000)}
\`\`\`

${variants
  .map(
    (variant) => `=== Changes from ${variant.agentName} ===
\`\`\`diff
${variant.diff.slice(0, 2000)}
\`\`\``,
  )
  .join('\n\n')}

Merge the changes above. Preserve non-overlapping edits from all agents. If edits conflict,
choose the most coherent result and explain the decision.

Return JSON only:
{
  "mergedContent": "complete merged file content",
  "hasConflict": boolean,
  "notes": "short merge decision notes"
}
`

    try {
      let output = ''
      for await (const delta of streamReply(
        [{ role: 'user', content: prompt }],
        'You are an expert code merge assistant. Return valid JSON only.',
      )) {
        output += delta
      }

      const jsonText = extractJson(output)
      if (!jsonText) {
        return { filePath, baseContent: base, variants, resolution: 'needs-human', notes: 'LLM did not return valid JSON' }
      }

      const parsed = JSON.parse(jsonText) as { mergedContent?: string; hasConflict?: boolean; notes?: string }

      if (parsed.hasConflict) {
        return {
          filePath,
          baseContent: base,
          variants,
          resolution: 'needs-human',
          notes: parsed.notes || 'Conflicting edits require human review',
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
      return { filePath, baseContent: base, variants, resolution: 'needs-human', notes: 'LLM merge failed' }
    }
  }
}

export type ConflictReport = MergeReport
export { ExecutionMergeResolver as ConflictResolver }

function extractJson(text: string): string | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) return cleaned
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : null
}
