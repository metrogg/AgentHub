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

await run('bun', ['--filter', '@agenthub/web', 'build'])
await run('bun', ['--filter', '@agenthub/server', 'build:exe'])

await rm(webDistTarget, { recursive: true, force: true })
await mkdir(resolve(resources, 'binaries'), { recursive: true })
await cp(webDistSource, webDistTarget, { recursive: true })
await copyFile(serverExeSource, serverExeTarget)

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))
    })
  })
}
