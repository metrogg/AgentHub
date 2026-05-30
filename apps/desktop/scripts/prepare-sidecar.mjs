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
const portFile = resolve(root, '.agenthub-port')
const powershellRoot = toPowerShellSingleQuotedString(root)
const cleanupStartedAt = toPowerShellSingleQuotedString(new Date().toISOString())
const skipWebBuild = process.argv.includes('--skip-web-build')

await stopStaleDevProcesses()
await rm(portFile, { force: true })
if (!skipWebBuild) {
  await run('bun', ['--filter', '@agenthub/web', 'build'])
}
await run('bun', ['--filter', '@agenthub/server', 'build:exe'])

await mkdir(resolve(resources, 'binaries'), { recursive: true })
if (!skipWebBuild) {
  await rm(webDistTarget, { recursive: true, force: true })
  await cp(webDistSource, webDistTarget, { recursive: true })
}
await copyFile(serverExeSource, serverExeTarget)

async function stopStaleDevProcesses() {
  if (process.platform !== 'win32') return

  const script = `
$root = ${powershellRoot}
$cleanupStartedAt = [DateTime]::Parse(${cleanupStartedAt}).ToLocalTime()
$devPorts = @(5173, 5174, 5175) + (8000..8079)
$portPids = [System.Collections.Generic.HashSet[int]]::new()
Get-NetTCPConnection -ErrorAction SilentlyContinue |
  Where-Object { $devPorts -contains $_.LocalPort } |
  ForEach-Object { [void]$portPids.Add([int]$_.OwningProcess) }

$protected = [System.Collections.Generic.HashSet[int]]::new()
$cursor = [int]$PID
while ($cursor -gt 0 -and -not $protected.Contains($cursor)) {
  [void]$protected.Add($cursor)
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $cursor" -ErrorAction SilentlyContinue
  if (-not $proc) { break }
  $cursor = [int]$proc.ParentProcessId
}

$targets = Get-CimInstance Win32_Process |
  Where-Object {
    if ($protected.Contains([int]$_.ProcessId)) { return $false }
    $exe = if ($_.ExecutablePath) { $_.ExecutablePath } else { '' }
    if ($exe.StartsWith('\\\\?\\', [System.StringComparison]::OrdinalIgnoreCase)) {
      $exe = $exe.Substring(4)
    }
    $commandLine = if ($_.CommandLine) { $_.CommandLine } else { '' }
    $relativeAgentHubDev = (
      ($commandLine -match 'apps[\\/]server[\\/]src[\\/]index\.ts') -or
      ($commandLine -match 'scripts[\\/]dev-services\.mjs') -or
      ($commandLine -match '--filter\s+@agenthub[\\/]?(web|desktop|server)')
    )
    $inProject = (
      ($exe -and $exe.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) -or
      ($commandLine.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    )
    if (-not $inProject -and -not $relativeAgentHubDev) { return $false }
    if ($_.CreationDate) {
      $createdAt = [System.Management.ManagementDateTimeConverter]::ToDateTime($_.CreationDate)
      if ($createdAt -ge $cleanupStartedAt.AddSeconds(-2)) { return $false }
    }
    if ($_.Name -in @('agenthub-desktop.exe', 'agenthub-server.exe')) { return $true }
    if ($portPids.Contains([int]$_.ProcessId) -and $_.Name -in @('node.exe', 'bun.exe', 'vite.exe', 'esbuild.exe')) { return $true }
    if ($_.Name -in @('vite.exe') -and $commandLine -match 'apps[\\/]web[\\/]node_modules[\\/]\.bin[\\/]vite\.exe') { return $true }
    if ($_.Name -in @('bun.exe') -and $commandLine -match '--filter\s+@agenthub[\\/]?(web|desktop|server)' -and $commandLine -match '\s+(dev|tauri:dev|start)(\s|$)') { return $true }
    if ($commandLine -match 'apps[\\/]desktop[\\/]node_modules[\\/]@tauri-apps[\\/]cli[\\/]tauri\.js"?\s+dev') { return $true }
    if ($commandLine -match 'apps[\\/]web[\\/]node_modules[\\/]vite[\\/]bin[\\/]vite\.js') { return $true }
    return $false
  }

foreach ($target in $targets) {
  $targetPid = [int]$target.ProcessId
  if ($targetPid -le 0 -or $protected.Contains($targetPid)) { continue }
  & taskkill.exe /PID $targetPid /T /F 2>$null | Out-Null
  $targetPid
}
`
  const output = await runCapture('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ])
  const killedPids = output
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0)

  if (killedPids.length > 0) {
    console.warn(`[prepare-sidecar] stopped stale AgentHub dev processes: ${killedPids.join(', ')}`)
  }
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    let outputTail = ''
    const rememberOutput = (chunk) => {
      outputTail += chunk.toString()
      if (outputTail.length > 20000) outputTail = outputTail.slice(-20000)
    }
    const child = spawn(command, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    child.stdout?.on('data', (chunk) => {
      rememberOutput(chunk)
      process.stdout.write(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      rememberOutput(chunk)
      process.stderr.write(chunk)
    })
    child.on('error', (error) => {
      reject(error)
    })
    child.on('exit', (code) => {
      if (code === 0) resolvePromise()
      else {
        const tail = outputTail.trim()
        if (tail) {
          console.error(`[prepare-sidecar] ${command} ${args.join(' ')} failed. Last output:\n${tail}`)
        }
        reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))
      }
    })
  })
}

function runCapture(command, args) {
  return new Promise((resolvePromise) => {
    let output = ''
    const child = spawn(command, args, { cwd: root })
    child.stdout?.on('data', (chunk) => {
      output += chunk
    })
    child.on('exit', () => resolvePromise(output))
    child.on('error', () => resolvePromise(''))
  })
}

function toPowerShellSingleQuotedString(value) {
  return `'${value.replaceAll("'", "''")}'`
}
