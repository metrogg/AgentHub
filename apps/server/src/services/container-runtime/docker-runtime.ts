import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logger } from '../../lib/logger'

const execFileAsync = promisify(execFile)

export interface DockerRunInput {
  name: string
  image: string
  args?: string[]
  env?: Record<string, string | null | undefined>
  volumes?: Array<{ host: string; container: string; readonly?: boolean }>
  ports?: Array<{ host: number; container: number }>
  labels?: Record<string, string | null | undefined>
  network?: string
  workdir?: string
  user?: string
  restart?: 'no' | 'unless-stopped' | 'on-failure'
  detach?: boolean
  extraArgs?: string[]
}

export interface DockerContainerStatus {
  name: string
  exists: boolean
  running: boolean
  restarting: boolean
  id: string | null
  image: string | null
  status: string | null
  createdAt: string | null
  labels: Record<string, string>
}

export class DockerRuntime {
  constructor(private readonly dockerBin = process.env.AGENTHUB_DOCKER_BIN?.trim() || 'docker') {}

  async isAvailable() {
    try {
      const { stdout } = await execFileAsync(this.dockerBin, ['version', '--format', '{{.Server.Version}}'], {
        timeout: 8_000,
        windowsHide: true,
      })
      return { available: true, version: stdout.trim() || null, error: null }
    } catch (error: any) {
      return { available: false, version: null, error: error?.message || String(error) }
    }
  }

  async ensureImage(image: string) {
    try {
      await execFileAsync(this.dockerBin, ['image', 'inspect', image], {
        timeout: 15_000,
        windowsHide: true,
      })
      return { present: true, pulled: false, error: null }
    } catch {
      try {
        const { stdout, stderr } = await execFileAsync(this.dockerBin, ['pull', image], {
          timeout: 5 * 60_000,
          windowsHide: true,
          maxBuffer: 1024 * 1024 * 10,
        })
        return { present: true, pulled: true, error: null, output: `${stdout}${stderr}`.trim() }
      } catch (error: any) {
        return { present: false, pulled: false, error: error?.message || String(error) }
      }
    }
  }

  async hasImage(image: string) {
    try {
      await execFileAsync(this.dockerBin, ['image', 'inspect', image], {
        timeout: 15_000,
        windowsHide: true,
      })
      return { present: true, error: null }
    } catch (error: any) {
      return { present: false, error: error?.message || String(error) }
    }
  }

  async buildImage(input: { tag: string; context: string; dockerfile?: string }) {
    const args = [
      'build',
      '-t',
      input.tag,
      input.dockerfile ? '-f' : undefined,
      input.dockerfile,
      input.context,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0)
    try {
      const { stdout, stderr } = await execFileAsync(this.dockerBin, args, {
        timeout: 10 * 60_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 20,
      })
      return { built: true, error: null, output: `${stdout}${stderr}`.trim() }
    } catch (error: any) {
      return { built: false, error: error?.message || String(error), output: error?.stdout || error?.stderr || '' }
    }
  }

  async inspect(name: string): Promise<DockerContainerStatus> {
    try {
      const { stdout } = await execFileAsync(this.dockerBin, [
        'inspect',
        name,
        '--format',
        '{{json .}}',
      ], {
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 5,
      })
      const parsed = JSON.parse(stdout.trim())
      const labels = parsed?.Config?.Labels && typeof parsed.Config.Labels === 'object'
        ? parsed.Config.Labels
        : {}
      return {
        name,
        exists: true,
        running: Boolean(parsed?.State?.Running) && !Boolean(parsed?.State?.Restarting),
        restarting: Boolean(parsed?.State?.Restarting),
        id: typeof parsed?.Id === 'string' ? parsed.Id : null,
        image: typeof parsed?.Config?.Image === 'string' ? parsed.Config.Image : null,
        status: typeof parsed?.State?.Status === 'string' ? parsed.State.Status : null,
        createdAt: typeof parsed?.Created === 'string' ? parsed.Created : null,
        labels,
      }
    } catch {
      return {
        name,
        exists: false,
        running: false,
        restarting: false,
        id: null,
        image: null,
        status: null,
        createdAt: null,
        labels: {},
      }
    }
  }

  async run(input: DockerRunInput) {
    const existing = await this.inspect(input.name)
    if (existing.running) {
      return { started: false, reused: true, container: existing }
    }
    if (existing.exists) {
      await this.remove(input.name, { force: true })
    }

    const args = [
      'run',
      input.detach === false ? undefined : '-d',
      '--name',
      input.name,
      '--restart',
      input.restart ?? 'unless-stopped',
      input.network ? '--network' : undefined,
      input.network,
      input.workdir ? '--workdir' : undefined,
      input.workdir,
      input.user ? '--user' : undefined,
      input.user,
      ...flatEntries(input.labels, (key, value) => ['--label', `${key}=${value}`]),
      ...flatEntries(input.env, (key, value) => ['-e', `${key}=${value}`]),
      ...(input.volumes ?? []).flatMap((volume) => [
        '-v',
        `${volume.host}:${volume.container}${volume.readonly ? ':ro' : ''}`,
      ]),
      ...(input.ports ?? []).flatMap((port) => ['-p', `${port.host}:${port.container}`]),
      ...(input.extraArgs ?? []),
      input.image,
      ...(input.args ?? []),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0)

    logger.info({ name: input.name, image: input.image }, 'Starting Docker runtime container')
    await execFileAsync(this.dockerBin, args, {
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 5,
    })
    return { started: true, reused: false, container: await this.inspect(input.name) }
  }

  async stop(name: string) {
    const existing = await this.inspect(name)
    if (!existing.exists) return { stopped: false, existed: false }
    if (existing.running) {
      await execFileAsync(this.dockerBin, ['stop', name], {
        timeout: 30_000,
        windowsHide: true,
      })
    }
    return { stopped: existing.running, existed: true, container: await this.inspect(name) }
  }

  async remove(name: string, input: { force?: boolean } = {}) {
    const args = ['rm', input.force ? '-f' : undefined, name].filter((value): value is string => Boolean(value))
    await execFileAsync(this.dockerBin, args, {
      timeout: 30_000,
      windowsHide: true,
    }).catch(() => undefined)
  }

  async logs(name: string, tail = 120) {
    try {
      const { stdout, stderr } = await execFileAsync(this.dockerBin, ['logs', '--tail', String(tail), name], {
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 5,
      })
      return { ok: true, output: `${stdout}${stderr}` }
    } catch (error: any) {
      return { ok: false, output: '', error: error?.message || String(error) }
    }
  }
}

function flatEntries(
  entries: Record<string, string | null | undefined> | undefined,
  render: (key: string, value: string) => string[],
) {
  if (!entries) return []
  return Object.entries(entries)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
    .flatMap(([key, value]) => render(key, value))
}

export const dockerRuntime = new DockerRuntime()
