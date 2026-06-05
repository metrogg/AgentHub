import { join } from 'node:path'
import { db, desc, workerInstances } from '@agenthub/db'
import { getRuntimeServerPort } from '../../lib/runtime-server'
import { agentHubUserDataRoot } from '../system-paths'
import { dockerRuntime } from './docker-runtime'

export const OPENCLAW_RUNTIME_IMAGE =
  process.env.AGENTHUB_OPENCLAW_RUNTIME_IMAGE?.trim() || 'agenthub/openclaw-runtime:local'

export function containersEnabled() {
  return (
    process.env.AGENTHUB_CONTAINER_RUNTIME?.trim().toLowerCase() === 'docker' ||
    process.env.AGENTHUB_WORKER_BACKEND?.trim().toLowerCase() === 'docker' ||
    process.env.AGENTHUB_MANAGER_BACKEND?.trim().toLowerCase() === 'docker'
  )
}

export function managerContainersEnabled() {
  return (
    process.env.AGENTHUB_MANAGER_BACKEND?.trim().toLowerCase() === 'docker' ||
    process.env.AGENTHUB_CONTAINER_RUNTIME?.trim().toLowerCase() === 'docker'
  )
}

export function workerContainersEnabled() {
  return (
    process.env.AGENTHUB_WORKER_BACKEND?.trim().toLowerCase() === 'docker' ||
    process.env.AGENTHUB_CONTAINER_RUNTIME?.trim().toLowerCase() === 'docker'
  )
}

export function managerContainerName(runtime = 'openclaw') {
  return `agenthub-manager-${runtime}`
}

export function workerContainerName(workerInstanceId: string) {
  return `agenthub-worker-${workerInstanceId.slice(0, 18).replace(/[^a-zA-Z0-9_.-]/g, '-')}`
}

export function containerControllerUrl() {
  const configured = process.env.AGENTHUB_CONTAINER_CONTROLLER_URL?.trim()
  if (configured) return configured
  return `http://host.docker.internal:${getRuntimeServerPort() ?? Number(process.env.PORT || 8000)}`
}

export function containerMatrixUrl() {
  return process.env.AGENTHUB_CONTAINER_MATRIX_URL?.trim() || 'http://host.docker.internal:6167'
}

export function containerLlmBaseUrl() {
  const configured = process.env.AGENTHUB_CONTAINER_LLM_BASE_URL?.trim()
  if (configured) return configured
  return `http://host.docker.internal:${getRuntimeServerPort() ?? Number(process.env.PORT || 8000)}/v1`
}

export function runtimeContainerWorkspaceRoot() {
  return join(agentHubUserDataRoot(), 'containers')
}

export async function ensureOpenClawRuntimeImage() {
  if (OPENCLAW_RUNTIME_IMAGE === 'agenthub/openclaw-runtime:local') {
    const present = await dockerRuntime.hasImage(OPENCLAW_RUNTIME_IMAGE)
    if (present.present) return { present: true, pulled: false, built: false, error: null }
    const built = await dockerRuntime.buildImage({
      tag: OPENCLAW_RUNTIME_IMAGE,
      context: process.cwd(),
      dockerfile: join(process.cwd(), 'infra', 'openclaw-runtime', 'Dockerfile'),
    })
    return {
      present: built.built,
      pulled: false,
      built: built.built,
      error: built.error,
      output: built.output,
    }
  }
  const present = await dockerRuntime.ensureImage(OPENCLAW_RUNTIME_IMAGE)
  if (present.present) return { ...present, built: false }
  return { ...present, built: false }
}

export async function describeContainerRuntime() {
  const workerRows = await db
    .select({
      id: workerInstances.id,
      workspaceAgentId: workerInstances.workspaceAgentId,
      runtimeBase: workerInstances.runtimeBase,
      observedState: workerInstances.observedState,
      updatedAt: workerInstances.updatedAt,
    })
    .from(workerInstances)
    .orderBy(desc(workerInstances.updatedAt))
    .limit(20)
  const [docker, image, managerContainer] = await Promise.all([
    dockerRuntime.isAvailable(),
    dockerRuntime.hasImage(OPENCLAW_RUNTIME_IMAGE),
    dockerRuntime.inspect(managerContainerName('openclaw')),
  ])
  const workerContainers = await Promise.all(
    workerRows.map(async (worker) => ({
      workerInstanceId: worker.id,
      workspaceAgentId: worker.workspaceAgentId,
      runtimeBase: worker.runtimeBase,
      observedState: worker.observedState,
      containerName: workerContainerName(worker.id),
      container: await dockerRuntime.inspect(workerContainerName(worker.id)),
    })),
  )
  return {
    provider: 'docker',
    enabled: containersEnabled(),
    managerEnabled: managerContainersEnabled(),
    workerEnabled: workerContainersEnabled(),
    docker,
    image: OPENCLAW_RUNTIME_IMAGE,
    imagePresent: image.present,
    imageError: image.error,
    managerContainer,
    workerContainers,
    workspaceRoot: runtimeContainerWorkspaceRoot(),
    controllerUrlForContainers: containerControllerUrl(),
    matrixUrlForContainers: containerMatrixUrl(),
    llmBaseUrlForContainers: containerLlmBaseUrl(),
    env: {
      AGENTHUB_CONTAINER_RUNTIME: process.env.AGENTHUB_CONTAINER_RUNTIME ?? null,
      AGENTHUB_MANAGER_BACKEND: process.env.AGENTHUB_MANAGER_BACKEND ?? null,
      AGENTHUB_WORKER_BACKEND: process.env.AGENTHUB_WORKER_BACKEND ?? null,
    },
  }
}
