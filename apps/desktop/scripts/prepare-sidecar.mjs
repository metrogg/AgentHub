import { copyFile, cp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const desktopTauri = resolve(root, 'apps/desktop/src-tauri')
const resources = resolve(desktopTauri, 'resources')
const webDistSource = resolve(root, 'apps/web/dist')
const webDistTarget = resolve(resources, 'web-dist')
const serverExeSource = resolve(root, 'apps/server/dist/agenthub-server.exe')
const serverExeTarget = resolve(resources, 'binaries/agenthub-server.exe')

await stopStaleDevProcesses()
await run('bun', ['--filter', '@agenthub/web', 'build'])
await run('bun', ['--filter', '@agenthub/server', 'build:exe'])

await rm(webDistTarget, { recursive: true, force: true })
await mkdir(resolve(resources, 'binaries'), { recursive: true })
await cp(webDistSource, webDistTarget, { recursive: true })
await copyFile(serverExeSource, serverExeTarget)

async function stopStaleDevProcesses() {
  if (process.platform !== 'win32') return

  const script = `
$root = ${JSON.stringify(root)}
Get-CimInstance Win32_Process |
  Where-Object {
    $_.ExecutablePath -and
    $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -and
    ($_.Name -in @('agenthub-desktop.exe', 'agenthub-server.exe'))
  } |
  Select-Object -ExpandProperty ProcessId
`
  const output = await runCapture('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script])
  const pids = output
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Best-effort cleanup. If Windows has already ended it, continue.
    }
  }
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))
    })
  })
}

function runCapture(command, args) {
  return new Promise((resolvePromise) => {
    let output = ''
    const child = spawn(command, args, { cwd: root, shell: process.platform === 'win32' })
    child.stdout?.on('data', (chunk) => {
      output += chunk
    })
    child.on('exit', () => resolvePromise(output))
    child.on('error', () => resolvePromise(''))
  })
}
