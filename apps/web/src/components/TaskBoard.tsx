import {
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  Ban,
  FileText,
  MessagesSquare,
  ShieldCheck,
} from 'lucide-react'

interface TaskBoardTask {
  id: string
  phaseId: string
  title: string
  description: string
  agentName: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled'
  progress?: number
  progressStatus?: string
  dependencies: string[]
  childSessionId?: string | null
  artifactCount?: number
  artifacts?: Array<{ artifactId?: string; id?: string; title?: string; filePath?: string }>
  outputSummary?: string
  validationStatus?: 'passed' | 'failed' | 'skipped' | 'not_run'
  contractStatus?: 'passed' | 'failed'
  resultError?: string
}

interface TaskBoardPhase {
  id: string
  title: string
  purpose: string
  taskIds: string[]
  status: 'pending' | 'active' | 'completed'
}

interface TaskBoardData {
  runId: string
  title: string
  goal: string
  collaborationMode: string
  phases: TaskBoardPhase[]
  tasks: TaskBoardTask[]
  status: 'planning' | 'running' | 'synthesizing' | 'completed' | 'failed' | 'cancelled'
  sessionId: string
}

interface TaskBoardProps {
  data: TaskBoardData
  onCancel?: () => void
  onRetryFailed?: () => void
}

function StatusIcon({ status }: { status: string }) {
  const iconClass = 'w-4 h-4'
  switch (status) {
    case 'pending':
      return <Clock className={`${iconClass} text-gray-400`} />
    case 'running':
      return <Loader2 className={`${iconClass} text-blue-500 animate-spin`} />
    case 'done':
      return <CheckCircle2 className={`${iconClass} text-green-500`} />
    case 'failed':
      return <XCircle className={`${iconClass} text-red-500`} />
    case 'blocked':
      return <Ban className={`${iconClass} text-yellow-500`} />
    case 'cancelled':
      return <AlertTriangle className={`${iconClass} text-gray-400`} />
    default:
      return <Clock className={`${iconClass} text-gray-400`} />
  }
}

function RunStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    planning: 'bg-purple-100 text-purple-700',
    running: 'bg-blue-100 text-blue-700',
    synthesizing: 'bg-indigo-100 text-indigo-700',
    completed: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
    cancelled: 'bg-gray-100 text-gray-600',
  }
  const labels: Record<string, string> = {
    planning: '规划中',
    running: '执行中',
    synthesizing: '汇总中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-100 text-gray-600'}`}
    >
      {labels[status] || status}
    </span>
  )
}

function validationLabel(status?: TaskBoardTask['validationStatus']) {
  const labels: Record<string, string> = {
    passed: '校验通过',
    failed: '校验失败',
    skipped: '校验跳过',
    not_run: '未校验',
  }
  return status ? labels[status] || status : ''
}

function validationClass(status?: TaskBoardTask['validationStatus']) {
  if (status === 'passed') return 'border-green-200 bg-green-50 text-green-700'
  if (status === 'failed') return 'border-red-200 bg-red-50 text-red-700'
  if (status === 'skipped') return 'border-amber-200 bg-amber-50 text-amber-700'
  return 'border-gray-200 bg-white text-gray-500'
}

export function TaskBoard({ data, onCancel, onRetryFailed }: TaskBoardProps) {
  const { title, goal, phases, tasks, status, collaborationMode } = data

  const getPhaseTasks = (phaseId: string) => tasks.filter((t) => t.phaseId === phaseId)

  const getPhaseStatus = (phase: TaskBoardPhase): 'pending' | 'active' | 'completed' => {
    if (phase.status === 'completed') return 'completed'
    if (phase.status === 'active') return 'active'
    const phaseTasks = getPhaseTasks(phase.id)
    if (phaseTasks.length === 0) return 'pending'
    const allDone = phaseTasks.every((t) => t.status === 'done')
    if (allDone) return 'completed'
    const anyActive = phaseTasks.some((t) => t.status === 'running' || t.status === 'done')
    return anyActive ? 'active' : 'pending'
  }

  const modeLabels: Record<string, string> = {
    pipeline: '流水线',
    mapreduce: '并行汇总',
    supervisor: '监督者',
  }

  const hasFailed = tasks.some((t) => t.status === 'failed')

  return (
    <div className="flex flex-col h-full bg-gray-50/80">
      <div className="p-4 border-b border-gray-200 bg-white">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-900 truncate" title={title}>
            🏗️ {title}
          </h3>
          <RunStatusBadge status={status} />
        </div>
        <p className="text-xs text-gray-500 line-clamp-2 mb-2">{goal}</p>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span>{modeLabels[collaborationMode] || collaborationMode}</span>
          <span>·</span>
          <span>{tasks.length} 个任务</span>
          <span>·</span>
          <span>{phases.length} 个阶段</span>
        </div>
      </div>

      {(status === 'running' || status === 'planning') && (
        <div className="flex gap-2 p-3 border-b border-gray-200 bg-white">
          {onCancel && (
            <button
              onClick={onCancel}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors"
            >
              ⏸ 暂停
            </button>
          )}
          {hasFailed && onRetryFailed && (
            <button
              onClick={onRetryFailed}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-600 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors"
            >
              🔄 重试失败任务
            </button>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {phases.map((phase) => {
          const phaseTasks = getPhaseTasks(phase.id)
          const phaseStatus = getPhaseStatus(phase)

          return (
            <div key={phase.id} className="bg-white rounded-lg border border-gray-200 p-3">
              <div className="flex items-center gap-2 mb-3">
                <StatusIcon
                  status={
                    phaseStatus === 'completed'
                      ? 'done'
                      : phaseStatus === 'active'
                        ? 'running'
                        : 'pending'
                  }
                />
                <h4 className="text-sm font-medium text-gray-800">{phase.title}</h4>
                <span className="text-xs text-gray-400">
                  {phaseTasks.filter((t) => t.status === 'done').length}/{phaseTasks.length}
                </span>
              </div>
              {phase.purpose && <p className="text-xs text-gray-500 mb-2">{phase.purpose}</p>}

              <div className="space-y-2">
                {phaseTasks.map((task) => {
                  const progressColor =
                    task.progress !== undefined
                      ? task.progress < 30
                        ? 'bg-red-500'
                        : task.progress < 70
                          ? 'bg-yellow-500'
                          : 'bg-green-500'
                      : 'bg-blue-500'
                  const artifactCount = task.artifactCount ?? task.artifacts?.length ?? 0
                  const hasResultLine =
                    artifactCount > 0 ||
                    Boolean(task.outputSummary) ||
                    Boolean(task.validationStatus) ||
                    Boolean(task.childSessionId) ||
                    Boolean(task.resultError)
                  return (
                    <div
                      key={task.id}
                      className={`flex items-start gap-2 p-2 rounded-lg text-xs transition-colors ${
                        task.status === 'running'
                          ? 'bg-blue-50 border border-blue-200'
                          : task.status === 'failed'
                            ? 'bg-red-50 border border-red-200'
                            : 'bg-gray-50'
                      }`}
                    >
                      <StatusIcon status={task.status} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={`font-medium truncate ${
                              task.status === 'failed' ? 'text-red-700' : 'text-gray-700'
                            }`}
                          >
                            {task.title}
                          </span>
                        </div>
                        <span className="text-gray-400">{task.agentName}</span>

                        {task.status === 'running' && task.progress !== undefined && (
                          <div className="mt-1.5">
                            <div className="w-full bg-gray-200 rounded-full h-1.5">
                              <div
                                className={`${progressColor} h-1.5 rounded-full transition-all duration-500`}
                                style={{
                                  width: `${Math.min(100, Math.max(0, task.progress))}%`,
                                }}
                              />
                            </div>
                            {task.progressStatus && (
                              <p className="text-gray-400 mt-0.5 truncate">{task.progressStatus}</p>
                            )}
                          </div>
                        )}

                        {hasResultLine && (
                          <div className="mt-2 space-y-1.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {artifactCount > 0 && (
                                <span className="inline-flex items-center gap-1 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[11px] text-gray-600">
                                  <FileText className="h-3 w-3" />
                                  {artifactCount} 产物
                                </span>
                              )}
                              {task.validationStatus && (
                                <span
                                  className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${validationClass(task.validationStatus)}`}
                                >
                                  <ShieldCheck className="h-3 w-3" />
                                  {validationLabel(task.validationStatus)}
                                </span>
                              )}
                              {task.childSessionId && (
                                <span className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700">
                                  <MessagesSquare className="h-3 w-3" />
                                  成员对话
                                </span>
                              )}
                            </div>
                            {task.outputSummary && (
                              <p className="line-clamp-2 text-[11px] leading-4 text-gray-500">
                                {task.outputSummary}
                              </p>
                            )}
                            {task.resultError && (
                              <p className="line-clamp-2 text-[11px] leading-4 text-red-600">
                                {task.resultError}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}

        {phases.length === 0 && (
          <div className="text-center text-gray-400 text-sm py-8">
            {status === 'planning' ? '正在生成执行计划...' : '暂无阶段信息'}
          </div>
        )}
      </div>
    </div>
  )
}
