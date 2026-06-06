import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function cleanupStaleDevProcesses(options = {}) {
  const { includeSelf = false, log = console.warn } = options
  if (process.platform !== 'win32') return []
  const script = `
$root = ${powershellString(root)}
$protected = New-Object 'System.Collections.Generic.HashSet[int]'
if (-not ${includeSelf ? '$true' : '$false'}) {
  $protected.Add(${process.pid}) | Out-Null
  try {
    $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
    if ($parent) { $protected.Add([int]$parent) | Out-Null }
  } catch {}
}

$targets = Get-CimInstance Win32_Process | Where-Object {
  $pidValue = [int]$_.ProcessId
  if ($protected.Contains($pidValue)) { return $false }
  $name = $_.Name
  $cmd = [string]$_.CommandLine
  if (-not $cmd) { return $false }
  if ($cmd.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  if ($name -eq 'node.exe' -and $cmd -match 'apps[\\\\/]web[\\\\/]node_modules[\\\\/]vite[\\\\/]bin[\\\\/]vite\\.js') { return $true }
  if ($name -eq 'bun.exe' -and $cmd -match '--watch\\s+apps/server/src/index\\.ts') { return $true }
  if ($name -eq 'bun.exe' -and $cmd -match 'concurrently.*dev:server.*dev:web') { return $true }
  return $false
}

foreach ($target in $targets) {
  $targetPid = [int]$target.ProcessId
  if ($protected.Contains($targetPid)) { continue }
  & taskkill.exe /PID $targetPid /T /F 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Output $targetPid }
}
`
  const output = await capture('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ])
  const killed = output
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
  if (killed.length > 0) {
    log(`[dev] stopped stale AgentHub dev processes: ${killed.join(', ')}`)
  }
  return killed
}

function capture(command, args) {
  return new Promise((resolvePromise, reject) => {
    let output = ''
    const child = spawn(command, args, {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.on('exit', (code) => {
      if (code === 0) resolvePromise(output)
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}: ${output}`))
    })
    child.on('error', reject)
  })
}

function powershellString(value) {
  return `'${value.replace(/'/g, "''")}'`
}
