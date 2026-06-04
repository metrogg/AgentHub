import {
  artifacts,
  taskThreads,
  timelineEvents,
  workspaceTasks,
} from '@agenthub/db'
import { TaskStatus } from '@agenthub/shared'

export interface CoordinatorResourceReviewInput {
  goal: string | null
  tasks: Array<typeof workspaceTasks.$inferSelect>
  threads: Array<typeof taskThreads.$inferSelect>
  artifactRows: Array<typeof artifacts.$inferSelect>
  agentNameById: Map<string, string>
  timelineByTaskId: Map<string, Array<typeof timelineEvents.$inferSelect>>
  sharedResults: Map<
    string,
    | {
        result: {
          summary: string
        }
      }
    | null
  >
}

export function buildCoordinatorResourceReviewSummary(input: CoordinatorResourceReviewInput) {
  const doneCount = input.tasks.filter((task) => task.status === TaskStatus.Done).length
  const failedCount = input.tasks.filter((task) => task.status === TaskStatus.Failed).length
  const cancelledCount = input.tasks.filter((task) => task.status === TaskStatus.Cancelled).length
  const blockedCount = input.tasks.filter((task) => task.status === TaskStatus.Blocked).length
  const threadByTaskId = new Map(input.threads.map((thread) => [thread.taskId, thread] as const))
  const artifactsByTaskId = groupBy(input.artifactRows, (artifact) => artifact.taskId ?? 'run')
  const lines = [
    '## Manager 最终复盘',
    input.goal ? `目标：${input.goal}` : '目标：未记录',
    '',
    `任务状态：${doneCount} 个完成，${failedCount} 个失败，${cancelledCount} 个取消，${blockedCount} 个阻塞。`,
    `产物登记：ArtifactStore 中共有 ${input.artifactRows.length} 个产物记录。`,
    '',
    '## 任务结果',
  ]

  for (const task of input.tasks) {
    const thread = threadByTaskId.get(task.id)
    const agentName = task.agentId ? input.agentNameById.get(task.agentId) : null
    const taskArtifacts = artifactsByTaskId.get(task.id) ?? []
    const timeline = input.timelineByTaskId.get(task.id) ?? []
    const shared = input.sharedResults.get(task.id)
    const latestWorkerMessage = [...timeline].reverse().find((event) => event.type === 'worker.message')
    const latestProgress = [...timeline].reverse().find((event) => event.type === 'task.progress')
    lines.push(
      `### ${task.title}`,
      `- 状态：${task.status}`,
      `- Worker：${agentName ?? task.agentId ?? '未绑定'}`,
      `- 子对话：${thread?.sessionId ?? '未创建'}`,
    )
    if (task.progressStatus) lines.push(`- 进度记录：${task.progressStatus}`)
    if (task.errorLog) lines.push(`- 错误/阻塞：${task.errorLog}`)
    if (shared?.result.summary) lines.push(`- 共享结果：${shared.result.summary}`)
    if (latestWorkerMessage?.body) {
      lines.push(`- 最近 Worker 消息：${singleLine(latestWorkerMessage.body).slice(0, 280)}`)
    } else if (latestProgress?.body) {
      lines.push(`- 最近进度：${singleLine(latestProgress.body).slice(0, 280)}`)
    }
    if (taskArtifacts.length > 0) {
      lines.push(
        `- 产物：${taskArtifacts
          .slice(0, 5)
          .map((artifact) => artifact.title)
          .join('、')}`,
      )
    }
    lines.push('')
  }

  if (input.artifactRows.length > 0) {
    lines.push('## 产物索引')
    for (const artifact of input.artifactRows.slice(0, 12)) {
      lines.push(
        `- ${artifact.title} (${artifact.kind})${artifact.objectKey ? ` — ${artifact.objectKey}` : ''}`,
      )
    }
    if (input.artifactRows.length > 12) {
      lines.push(`- 另有 ${input.artifactRows.length - 12} 个产物记录可在产物面板查看。`)
    }
  }

  lines.push(
    '',
    '## 透明性说明',
    '这份复盘来自 Run/Task/TaskThread/Room timeline/ArtifactStore 的当前事实记录；没有调用旧 OrchestratorEngine 最终汇总路径。',
  )
  return `${lines.join('\n').replace(/\s+$/g, '')}\n`
}

function groupBy<T>(items: T[], pick: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const item of items) {
    const key = pick(item)
    grouped.set(key, [...(grouped.get(key) ?? []), item])
  }
  return grouped
}

function singleLine(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}
