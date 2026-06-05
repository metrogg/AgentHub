import {
  artifacts,
  db,
  orchestratorRuns,
  roomParticipants,
  rooms,
  runtimeLeases,
  taskThreads,
  workspaceAgents,
  workspaceTasks,
  workerInstances,
} from '@agenthub/db'
import { controllerReconcileQueue } from './controller-reconciler'

export interface ControllerPlaneDiagnostics {
  apiVersion: 'agenthub.dev/v1alpha1'
  mode: 'in-process'
  queue: {
    running: boolean
    size: number
    pendingKeys: string[]
    registeredKinds: string[]
  }
  resources: {
    workspaceAgents: number
    workerInstances: number
    rooms: number
    roomParticipants: number
    runs: number
    tasks: number
    taskThreads: number
    runtimeLeases: number
    artifacts: number
  }
  boundaries: {
    controllerOwns: string[]
    managerOwns: string[]
    uiReadsFrom: string[]
  }
}

export async function describeControllerPlane(): Promise<ControllerPlaneDiagnostics> {
  const [
    workspaceAgentRows,
    workerInstanceRows,
    roomRows,
    roomParticipantRows,
    runRows,
    taskRows,
    taskThreadRows,
    runtimeLeaseRows,
    artifactRows,
  ] = await Promise.all([
    db.select({ id: workspaceAgents.id }).from(workspaceAgents),
    db.select({ id: workerInstances.id }).from(workerInstances),
    db.select({ id: rooms.id }).from(rooms),
    db.select({ id: roomParticipants.id }).from(roomParticipants),
    db.select({ id: orchestratorRuns.id }).from(orchestratorRuns),
    db.select({ id: workspaceTasks.id }).from(workspaceTasks),
    db.select({ id: taskThreads.id }).from(taskThreads),
    db.select({ id: runtimeLeases.id }).from(runtimeLeases),
    db.select({ id: artifacts.id }).from(artifacts),
  ])

  return {
    apiVersion: 'agenthub.dev/v1alpha1',
    mode: 'in-process',
    queue: controllerReconcileQueue.describe(),
    resources: {
      workspaceAgents: workspaceAgentRows.length,
      workerInstances: workerInstanceRows.length,
      rooms: roomRows.length,
      roomParticipants: roomParticipantRows.length,
      runs: runRows.length,
      tasks: taskRows.length,
      taskThreads: taskThreadRows.length,
      runtimeLeases: runtimeLeaseRows.length,
      artifacts: artifactRows.length,
    },
    boundaries: {
      controllerOwns: [
        'WorkerInstance readiness and lifecycle reconciliation',
        'Room and participant reconciliation',
        'Run, task, runtime lease, and artifact resource state',
      ],
      managerOwns: [
        'natural-language intent understanding',
        'whether to reply, clarify, propose members, assign work, or review results',
        'skill/tool selection inside OpenClaw/QwenPaw style Manager runtime',
      ],
      uiReadsFrom: [
        'Matrix Room timeline and participants',
        'Controller resource snapshots',
        'AG-UI projections derived from timeline/resource state',
      ],
    },
  }
}
