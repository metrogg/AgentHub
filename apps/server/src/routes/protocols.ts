import { Hono } from 'hono'
import { AppError, AppErrorCodes } from '../lib/error'
import { db, and, eq, orchestratorRuns, workspaceTasks, workspaces } from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { loadWorkspaceFull } from '../services/workspace/workspace-queries'
import {
  buildA2ATaskFromWorkspaceTask,
  buildAgUiTaskStatusEvent,
  buildAgUiEventsFromRunEvent,
  buildMcpManifest,
  buildWorkspaceAgentCard,
} from '../services/protocols'
import { listRunEvents } from '../services/orchestrator/run-events'

export const protocolRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/a2a/workspaces/:workspaceId/agent-card', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const { workspace, agents } = await loadWorkspaceFull(workspaceId, c.get('user').sub)
    return c.json(
      buildWorkspaceAgentCard({
        agents,
        baseUrl: requestOrigin(c.req.url),
        workspace,
      }),
    )
  })
  .get('/a2a/workspaces/:workspaceId/agents/:agentId/agent-card', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const agentId = c.req.param('agentId')
    const { workspace, agents } = await loadWorkspaceFull(workspaceId, c.get('user').sub)
    const agent = agents.find((item) => item.id === agentId)
    if (!agent) {
      throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Agent 不存在')
    }
    return c.json(
      buildWorkspaceAgentCard({
        agent,
        baseUrl: requestOrigin(c.req.url),
        workspace,
      }),
    )
  })
  .get('/ag-ui/capabilities', (c) =>
    c.json({
      events: [
        'RUN_STARTED',
        'RUN_FINISHED',
        'RUN_ERROR',
        'STEP_STARTED',
        'STEP_FINISHED',
        'CUSTOM:agenthub.task.status',
        'CUSTOM:agenthub.artifact.created',
        'CUSTOM:agenthub.blackboard.written',
        'CUSTOM:agenthub.run.status',
      ],
      sampleTaskStatusEvent: buildAgUiTaskStatusEvent({
        agentName: 'Researcher',
        status: 'running',
        taskId: 'example-task',
        taskTitle: '示例任务',
      }),
    }),
  )
  .get('/mcp/manifest', (c) => c.json(buildMcpManifest()))
  .get('/a2a/runs/:runId/tasks', async (c) => {
    const run = await findOwnedRun(c)
    const rows = await db
      .select({
        id: workspaceTasks.id,
        title: workspaceTasks.title,
        description: workspaceTasks.description,
        status: workspaceTasks.status,
        agentId: workspaceTasks.agentId,
        artifacts: workspaceTasks.artifacts,
        progressPercent: workspaceTasks.progressPercent,
        progressStatus: workspaceTasks.progressStatus,
        createdAt: workspaceTasks.createdAt,
        updatedAt: workspaceTasks.updatedAt,
      })
      .from(workspaceTasks)
      .where(eq(workspaceTasks.runId, run.id))
      .orderBy(workspaceTasks.orderIdx)

    return c.json({
      items: rows.map((task) =>
        buildA2ATaskFromWorkspaceTask({
          contextId: run.groupSessionId,
          task,
        }),
      ),
    })
  })
  .get('/a2a/runs/:runId/tasks/:taskId', async (c) => {
    const run = await findOwnedRun(c)
    const taskId = c.req.param('taskId')
    const [task] = await db
      .select({
        id: workspaceTasks.id,
        title: workspaceTasks.title,
        description: workspaceTasks.description,
        status: workspaceTasks.status,
        agentId: workspaceTasks.agentId,
        artifacts: workspaceTasks.artifacts,
        progressPercent: workspaceTasks.progressPercent,
        progressStatus: workspaceTasks.progressStatus,
        createdAt: workspaceTasks.createdAt,
        updatedAt: workspaceTasks.updatedAt,
      })
      .from(workspaceTasks)
      .where(and(eq(workspaceTasks.runId, run.id), eq(workspaceTasks.id, taskId)))
      .limit(1)

    if (!task) {
      throw AppError.fromCode(AppErrorCodes.TASK_NOT_FOUND, 'Task 不存在')
    }

    return c.json(buildA2ATaskFromWorkspaceTask({ contextId: run.groupSessionId, task }))
  })
  .get('/ag-ui/runs/:runId/events', async (c) => {
    const run = await findOwnedRun(c)
    const events = await listRunEvents(run.id)
    return c.json({
      items: events.flatMap((event) => buildAgUiEventsFromRunEvent(normalizeRunEvent(event))),
    })
  })

function requestOrigin(url: string) {
  return new URL(url).origin
}

async function findOwnedRun(c: {
  req: { param: (key: string) => string }
  get: (key: string) => { sub: string }
}) {
  const runId = c.req.param('runId')
  const user = c.get('user')
  const [run] = await db
    .select({
      id: orchestratorRuns.id,
      workspaceId: orchestratorRuns.workspaceId,
      groupSessionId: orchestratorRuns.groupSessionId,
      status: orchestratorRuns.status,
      plan: orchestratorRuns.plan,
    })
    .from(orchestratorRuns)
    .innerJoin(workspaces, eq(workspaces.id, orchestratorRuns.workspaceId))
    .where(and(eq(orchestratorRuns.id, runId), eq(workspaces.ownerId, user.sub)))
    .limit(1)

  if (!run) {
    throw AppError.fromCode(AppErrorCodes.ORCHESTRATOR_RUN_NOT_FOUND, 'Run 不存在')
  }

  return run
}

function normalizeRunEvent(event: {
  runId: string
  groupSessionId: string
  taskId: string | null
  agentId: string | null
  type: string
  payload: Record<string, unknown>
  severity: string
  createdAt?: Date | string
}) {
  const timestampMs =
    event.createdAt instanceof Date
      ? event.createdAt.getTime()
      : typeof event.createdAt === 'string'
        ? Date.parse(event.createdAt)
        : undefined
  return {
    runId: event.runId,
    groupSessionId: event.groupSessionId,
    taskId: event.taskId,
    agentId: event.agentId,
    type: event.type,
    payload: event.payload,
    severity: event.severity,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : undefined,
  }
}
