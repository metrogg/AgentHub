import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  buildPlanningFailureArtifactMetadata,
  extractPlanningFailureArtifacts,
} from '../apps/server/src/services/orchestrator/planning-failure-artifacts'

describe('planning failure artifact recovery', () => {
  test('recovers generated office files mentioned in failed planner output', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'agenthub-planning-artifacts-'))
    const docPath = join(workspaceRoot, 'deliverables', 'agent-notes.docx')
    mkdirSync(join(workspaceRoot, 'deliverables'), { recursive: true })
    writeFileSync(docPath, 'docx-bytes')

    const artifacts = extractPlanningFailureArtifacts(
      `Manager did not return JSON. File location: \`${docPath}\``,
      workspaceRoot,
    )

    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      type: 'file',
      title: 'agent-notes.docx',
      path: 'deliverables/agent-notes.docx',
      status: 'created',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 10,
      sourcePath: docPath,
    })

    const metadata = buildPlanningFailureArtifactMetadata(artifacts, 'run-1', 'workspace-1')
    expect(metadata.file_card.files[0]).toMatchObject({
      fileName: 'agent-notes.docx',
      filePath: 'deliverables/agent-notes.docx',
      fileSize: 10,
      runId: 'run-1',
      workspaceId: 'workspace-1',
    })
    expect(metadata.delivery_report.status).toBe('partial')
    expect(metadata.recoveredPlanningArtifacts).toBe(true)
  })

  test('ignores paths outside the workspace', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'agenthub-planning-workspace-'))
    const outsideRoot = mkdtempSync(join(tmpdir(), 'agenthub-planning-outside-'))
    const outsideDoc = join(outsideRoot, 'leak.docx')
    writeFileSync(outsideDoc, 'docx-bytes')

    const artifacts = extractPlanningFailureArtifacts(
      `Generated file: "${outsideDoc}"`,
      workspaceRoot,
    )

    expect(artifacts).toEqual([])
  })
})
