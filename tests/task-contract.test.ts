import { describe, expect, test } from 'bun:test'
import { BlackboardSchemaType, TaskType } from '../packages/shared/src/enums'
import {
  hasFatalTaskContractViolations,
  validateTaskOutputContract,
} from '../apps/server/src/services/orchestrator/task-contract'
import type { ExecutionTask } from '../apps/server/src/services/orchestrator/types'

function task(overrides: Partial<ExecutionTask> = {}): Pick<ExecutionTask, 'id' | 'outputContract' | 'taskType'> {
  return {
    id: 'task-research',
    taskType: TaskType.Research,
    outputContract: {
      requiredBlackboardWrites: [
        {
          key: 'task_task-research_output',
          schemaType: BlackboardSchemaType.TaskOutput,
        },
      ],
      requiredArtifacts: [],
      allowedPaths: ['docs/**'],
    },
    ...overrides,
  }
}

describe('validateTaskOutputContract', () => {
  test('downgrades safe relative delivery path mismatches to non-fatal contract warnings', () => {
    const artifacts = [
      { type: 'file', path: 'index.html' },
      { type: 'preview', path: 'index.html' },
    ]
    const result = validateTaskOutputContract({
      task: task({ taskType: TaskType.Code }),
      artifacts,
      writtenBlackboardKeys: ['task_task-research_output'],
    })

    expect(result.status).toBe('failed')
    expect(result.violations.some((violation) => violation.type === 'path_not_allowed')).toBe(true)
    expect(hasFatalTaskContractViolations(result.violations, artifacts)).toBe(false)
  })

  test('still rejects unsafe artifact paths outside the agent workdir', () => {
    const cases = ['../secret.md', '/etc/passwd', 'C:\\Users\\wzd\\secret.txt']

    for (const path of cases) {
      const result = validateTaskOutputContract({
        task: task(),
        artifacts: [{ type: 'file', path }],
        writtenBlackboardKeys: ['task_task-research_output'],
      })

      expect(result.status).toBe('failed')
      expect(result.violations.some((violation) => violation.type === 'path_not_allowed')).toBe(true)
      expect(hasFatalTaskContractViolations(result.violations, [{ type: 'preview', path }])).toBe(true)
    }
  })

  test('keeps allowedPaths strict for code diffs', () => {
    const result = validateTaskOutputContract({
      task: task({
        taskType: TaskType.Code,
        outputContract: {
          requiredBlackboardWrites: [
            {
              key: 'task_task-research_output',
              schemaType: BlackboardSchemaType.TaskOutput,
            },
          ],
          requiredArtifacts: ['diff'],
          allowedPaths: ['apps/web/src/**'],
        },
      }),
      artifacts: [{ kind: 'diff', filePath: 'packages/db/src/schema.ts' }],
      writtenBlackboardKeys: ['task_task-research_output'],
    })

    expect(result.status).toBe('failed')
    expect(result.violations.some((violation) => violation.type === 'path_not_allowed')).toBe(true)
    expect(hasFatalTaskContractViolations(result.violations, [{ kind: 'diff', filePath: 'packages/db/src/schema.ts' }])).toBe(true)
  })

  test('continues to enforce required artifact and blackboard writes', () => {
    const result = validateTaskOutputContract({
      task: task({
        outputContract: {
          requiredBlackboardWrites: [
            {
              key: 'analysis/summary',
              schemaType: BlackboardSchemaType.Fact,
            },
          ],
          requiredArtifacts: ['research_report.md'],
          allowedPaths: [],
        },
      }),
      artifacts: [],
      writtenBlackboardKeys: [],
    })

    expect(result.status).toBe('failed')
    expect(result.violations.map((violation) => violation.type)).toEqual([
      'missing_artifact',
      'missing_blackboard_write',
    ])
  })
})
