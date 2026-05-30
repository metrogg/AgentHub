import { useParams } from 'react-router-dom'
import { ThreadPrimitive } from '@assistant-ui/react'
import { X, ExternalLink } from 'lucide-react'
import { Thread } from '@/components/assistant-ui/Thread'
import { TaskBoard } from '@/components/TaskBoard'
import { AgentTabs } from '@/components/AgentTabs'
import { useChatStore } from '@/stores/chatStore'
import { AgentHubRuntimeProvider } from '@/lib/runtime'

export function WorkspaceChatPage() {
  const { sessionId } = useParams<{ workspaceId: string; sessionId: string }>()
  const taskBoard = useChatStore((s) => s.taskBoard)
  const previewUrl = useChatStore((s) => s.previewUrl)
  const previewFileName = useChatStore((s) => s.previewFileName)
  const setPreviewUrl = useChatStore((s) => s.setPreviewUrl)
  const agentTabs = useChatStore((s) => s.agentTabs)
  const selectedAgentTab = useChatStore((s) => s.selectedAgentTab)
  const selectAgentTab = useChatStore((s) => s.selectAgentTab)

  const activeAgentCount = agentTabs.filter((t) => t.status === 'running').length

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
      {taskBoard && agentTabs.length > 0 && (
        <AgentTabs
          tabs={agentTabs}
          selectedTab={selectedAgentTab}
          onSelect={selectAgentTab}
          activeAgentCount={activeAgentCount}
          runStatus={taskBoard.status}
        />
      )}

      <div className={`flex-1 flex flex-col min-w-0 ${taskBoard ? 'border-r border-gray-200' : ''}`}>
        <AgentHubRuntimeProvider key={sessionId}>
          <ThreadPrimitive.Root className="flex-1 flex flex-col">
            <Thread />
          </ThreadPrimitive.Root>
        </AgentHubRuntimeProvider>
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

      {previewUrl && (
        <div className="w-96 flex-shrink-0 overflow-hidden border-l border-gray-200 bg-white">
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-neutral-900">
                <ExternalLink className="h-4 w-4 text-neutral-400" />
                <span className="truncate max-w-[250px]">{previewFileName || '预览'}</span>
              </h3>
              <button
                type="button"
                onClick={() => setPreviewUrl(null)}
                className="rounded-lg p-1.5 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1">
              <iframe
                src={previewUrl}
                title={previewFileName || 'preview'}
                className="h-full w-full border-0"
                sandbox="allow-scripts allow-same-origin"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}