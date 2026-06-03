import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseSharedTaskResult,
  prepareSharedTaskDirectory,
  renderSharedTaskResult,
  updateSharedTaskDirectoryStatus,
  validateSharedTaskResult,
} from '../apps/server/src/services/orchestrator/shared-task-directory'

describe('shared task directory', () => {
  test('writes a HiClaw-style machine-readable result.md for completed tasks', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'agenthub-shared-task-'))
    const prepared = await prepareSharedTaskDirectory({
      projectPath,
      runId: 'run-1',
      taskId: 'task-1',
      taskTitle: 'Build report',
      taskDescription: 'Create a report page',
      goal: 'Deliver an AI tools report',
      assignee: { id: 'agent-1', name: 'Builder', role: 'Engineer' },
      requiredArtifacts: ['report.html'],
      acceptanceCriteria: ['Report exists'],
    })
    expect(prepared).toBeTruthy()

    await updateSharedTaskDirectoryStatus({
      projectPath,
      sharedTaskRelativeRoot: prepared!.relativeRoot,
      status: 'completed',
      summary: 'Report page delivered.',
      artifacts: [
        {
          id: 'artifact-1',
          title: 'report.html',
          kind: 'file',
          relativePath: 'artifacts/report.html',
        },
      ],
      timestamps: { updatedAt: '2026-06-03T00:00:00.000Z' },
    })

    const resultText = readFileSync(join(prepared!.rootPath, 'result.md'), 'utf8')
    expect(resultText).toContain('STATUS: SUCCESS')
    expect(resultText).toContain('SUMMARY: Report page delivered.')
    expect(resultText).toContain(`- ${prepared!.relativeRoot}/artifacts/report.html`)

    const parsed = parseSharedTaskResult(resultText)
    expect(parsed).toEqual({
      status: 'SUCCESS',
      summary: 'Report page delivered.',
      deliverables: [`${prepared!.relativeRoot}/artifacts/report.html`],
      notes: [],
    })
  })

  test('documents the result contract in spec.md', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'agenthub-shared-task-'))
    const prepared = await prepareSharedTaskDirectory({
      projectPath,
      runId: 'run-1',
      taskId: 'task-contract',
      taskTitle: 'Research',
      taskDescription: 'Research the market',
      goal: 'Understand competitors',
    })

    const specText = readFileSync(prepared!.specPath, 'utf8')
    expect(specText).toContain('## 结果契约')
    expect(specText).toContain('STATUS: SUCCESS | SUCCESS_WITH_NOTES | REVISION_NEEDED | BLOCKED | INTERRUPTED')
    expect(specText).toContain(`${prepared!.relativeRoot}/result.md`)
    expect(specText).toContain(`${prepared!.relativeRoot}/artifacts/<产物文件名>`)
  })

  test('renders and parses blocked or revision results without relying on prose', () => {
    const text = renderSharedTaskResult({
      status: 'BLOCKED',
      summary: 'Waiting for API credentials.',
      deliverables: [],
      notes: ['Need human approval.'],
    })

    expect(parseSharedTaskResult(text)).toEqual({
      status: 'BLOCKED',
      summary: 'Waiting for API credentials.',
      deliverables: [],
      notes: ['Need human approval.'],
    })
  })

  test('validates deliverables stay under the shared task root', () => {
    expect(() =>
      validateSharedTaskResult(
        {
          status: 'SUCCESS',
          summary: 'Delivered.',
          deliverables: ['.agenthub/shared/tasks/task-1/artifacts/report.html'],
          notes: [],
        },
        '.agenthub/shared/tasks/task-1',
      ),
    ).not.toThrow()

    expect(() =>
      validateSharedTaskResult(
        {
          status: 'SUCCESS',
          summary: 'Delivered.',
          deliverables: ['../secret.md'],
          notes: [],
        },
        '.agenthub/shared/tasks/task-1',
      ),
    ).toThrow(/unsafe|under/)
  })
})
