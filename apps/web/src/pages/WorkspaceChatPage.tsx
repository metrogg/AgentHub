import { useParams } from 'react-router-dom'
import { ThreadPrimitive } from '@assistant-ui/react'
import { Thread } from '@/components/assistant-ui/Thread'
import { TaskBoard } from '@/components/TaskBoard'
import { useChatStore } from '@/stores/chatStore'

export function WorkspaceChatPage() {
  const { sessionId } = useParams<{ workspaceId: string; sessionId: string }>()
  const taskBoard = useChatStore((s) => s.taskBoard)

  const handleCancel = () => {
    if (!taskBoard?.runId) return
    fetch(`/api/orchestrator-runs/${taskBoard.runId}/cancel`, { method: 'POST' }).catch(console.error)
  }

  const handleRetryFailed = () => {
    if (!taskBoard?.runId) return
    const failedTasks = taskBoard.tasks.filter((t) => t.status === 'failed')
    for (const task of failedTasks) {
      fetch(`/api/orchestrator-runs/${taskBoard.runId}/retry-task/${task.id}`, { method: 'POST' }).catch(console.error)
    }
  }

  if (!sessionId) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500">请选择一个会话</p>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <div className={`flex-1 flex flex-col min-w-0 ${taskBoard ? 'border-r border-gray-200' : ''}`}>
        <ThreadPrimitive.Root className="flex-1 flex flex-col">
          <Thread />
        </ThreadPrimitive.Root>
      </div>

      {taskBoard && (
        <div className="w-96 flex-shrink-0 overflow-hidden">
          <TaskBoard
            data={taskBoard}
            onCancel={handleCancel}
            onRetryFailed={handleRetryFailed}
          />
        </div>
      )}
    </div>
  )
}