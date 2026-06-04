import { Ban, Bot, CheckCircle2, Clock, MessagesSquare, XCircle } from 'lucide-react'
import type { ControlPanelProjection } from '@/stores/chatStore'

export interface AgentTab {
  taskId: string
  agentId: string
  agentName: string
  taskTitle: string
  status: 'pending' | 'assigned' | 'running' | 'waiting' | 'done' | 'failed'
  childSessionId: string | null
  taskThreadStatus?: 'prepared' | 'assigned' | 'active' | 'waiting_for_human' | 'completed' | 'failed' | 'cancelled' | null
  progress?: number
  progressStatus?: string
}

interface AgentTabsProps {
  tabs: AgentTab[]
  selectedTab: string | null
  onSelect: (taskId: string | null) => void
  activeAgentCount: number
  runStatus: string
  currentActivity?: ControlPanelProjection['currentActivity']
}

function StatusIndicator({ status }: { status: AgentTab['status'] }) {
  switch (status) {
    case 'assigned':
      return <MessagesSquare className="w-4 h-4 text-indigo-500" />
    case 'running':
      return (
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500" />
        </span>
      )
    case 'waiting':
      return <Ban className="w-4 h-4 text-yellow-500" />
    case 'done':
      return <CheckCircle2 className="w-4 h-4 text-green-500" />
    case 'failed':
      return <XCircle className="w-4 h-4 text-red-500" />
    default:
      return <Clock className="w-4 h-4 text-gray-400" />
  }
}

export function AgentTabs({
  tabs,
  selectedTab,
  onSelect,
  activeAgentCount,
  runStatus,
  currentActivity = null,
}: AgentTabsProps) {
  const statusLabels: Record<string, string> = {
    planning: '规划中',
    running: '执行中',
    synthesizing: '汇总中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }

  return (
    <div className="flex h-full w-48 flex-shrink-0 flex-col bg-[#f3f3ef]">
      <div
        onClick={() => onSelect(null)}
        className={`cursor-pointer px-3 py-3 transition-colors ${
          selectedTab === null
            ? 'bg-blue-50 border-l-2 border-l-blue-500'
            : 'hover:bg-gray-100 border-l-2 border-l-transparent'
        }`}
      >
        <div className="flex items-center gap-2">
          <MessagesSquare className="h-4 w-4 text-blue-600" />
          <span className="text-sm font-medium text-gray-900 truncate">主对话</span>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[11px] text-gray-500">{statusLabels[runStatus] || runStatus}</span>
          {activeAgentCount > 0 && (
            <span className="text-[11px] text-blue-600 font-medium">{activeAgentCount} 活跃</span>
          )}
        </div>
        {currentActivity?.agentName && (
          <p className="mt-1 text-[10px] text-gray-400 truncate">
            {currentActivity.agentName}
            {currentActivity.label ? ` · ${currentActivity.label}` : ''}
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tabs.map((tab) => {
          const isSelected = selectedTab === tab.taskId
          const isDisabled = !tab.childSessionId

          return (
            <div
              key={tab.taskId}
              onClick={() => {
                if (!isDisabled) onSelect(tab.taskId)
              }}
              className={`cursor-pointer px-3 py-2.5 transition-colors border-l-2 ${
                isSelected
                  ? 'bg-blue-50 border-l-blue-500'
                  : 'border-l-transparent hover:bg-gray-100'
              } ${isDisabled ? 'opacity-60' : ''}`}
            >
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 flex-shrink-0 text-gray-500" />
                <span className="text-sm font-medium text-gray-800 truncate">{tab.agentName}</span>
                <span className="flex-shrink-0 ml-auto">
                  <StatusIndicator status={tab.status} />
                </span>
              </div>
              <div className="mt-0.5 ml-6">
                <p className="text-[10px] text-gray-500 truncate">{tab.taskTitle}</p>
              </div>

              {tab.status === 'running' && tab.progress !== undefined && (
                <div className="mt-1.5 ml-6">
                  <div className="w-full bg-gray-200 rounded-full h-1">
                    <div
                      className="bg-blue-500 h-1 rounded-full transition-all duration-500"
                      style={{ width: `${Math.min(100, Math.max(0, tab.progress))}%` }}
                    />
                  </div>
                  {tab.progressStatus && (
                    <p className="text-[10px] text-gray-400 mt-0.5 truncate">
                      {tab.progressStatus}
                    </p>
                  )}
                </div>
              )}

              {tab.taskThreadStatus === 'prepared' && (
                <p className="text-[10px] text-gray-400 mt-0.5 ml-6">等待分配</p>
              )}
              {tab.taskThreadStatus === 'assigned' && (
                <p className="text-[10px] text-indigo-500 mt-0.5 ml-6">已派发，等待执行</p>
              )}
              {(tab.status === 'waiting' || tab.taskThreadStatus === 'waiting_for_human') && (
                <p className="text-[10px] text-yellow-600 mt-0.5 ml-6 truncate">
                  {tab.progressStatus || '等待用户澄清'}
                </p>
              )}
            </div>
          )
        })}

        {tabs.length === 0 && (
          <div className="p-3 text-center text-xs text-gray-400">暂无 Agent</div>
        )}
      </div>
    </div>
  )
}
