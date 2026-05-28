import { randomBytes, randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Hono } from 'hono'
import { env } from '../env'
import { getRuntimeServerPort } from '../lib/runtime-server'
import { authMiddleware, type AuthVariables } from '../middleware/auth'

const PAIRING_TTL_MS = 2 * 60 * 1000
const execFileAsync = promisify(execFile)

interface PairingRecord {
  code: string
  baseUrl: string
  baseUrls: string[]
  webUrl: string
  webUrls: string[]
  expiresAt: number
}

const pairings = new Map<string, PairingRecord>()
const mobileEvents: Array<{ type: string; message: string; at: string }> = []

export const mobileRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('/pair/start', authMiddleware)
  .use('/connectivity', authMiddleware)
  .use('/firewall/open', authMiddleware)
  .get('/connectivity', async (c) => {
    return c.json(await mobileConnectivityStatus())
  })
  .post('/firewall/open', async (c) => {
    const port = getServerPort()
    const result = await openFirewallPort(port)
    pushMobileEvent({
      type: result.ok ? 'firewall.opened' : 'firewall.failed',
      message: result.message,
    })
    return c.json({
      ...result,
      diagnostics: await mobileConnectivityStatus(),
    })
  })
  .post('/pair/start', async (c) => {
    cleanupExpiredPairings()
    const body: Record<string, unknown> = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({} as Record<string, unknown>))
    const requestedHost = typeof body.host === 'string' && body.host.trim() ? body.host.trim() : ''
    const host = requestedHost || await pickLanAddress()
    const port = typeof body.port === 'number' ? body.port : getServerPort()
    const webPort = typeof body.webPort === 'number' ? body.webPort : env.AGENTHUB_WEB_DIST ? port : 5173
    const code = createPairingCode()
    const expiresAt = Date.now() + PAIRING_TTL_MS
    const hosts = uniqueHosts([host, ...listLanAddresses()])
    const baseUrls = hosts.map((item) => `http://${item}:${port}`)
    const webUrls = hosts.map((item) => `http://${item}:${webPort}`)
    const baseUrl = baseUrls[0] ?? `http://${host}:${port}`
    const webUrl = webUrls[0] ?? `http://${host}:${webPort}`
    const record: PairingRecord = { code, baseUrl, baseUrls, webUrl, webUrls, expiresAt }
    pairings.set(code, record)
    pushMobileEvent({
      type: 'pairing.started',
      message: `已生成移动端配对二维码：${baseUrl}`,
    })
    const payload = {
      version: 1,
      baseUrl,
      baseUrls,
      webUrl,
      webUrls,
      pairingCode: code,
      expiresAt: new Date(expiresAt).toISOString(),
    }
    return c.json({
      ...payload,
      ttlSeconds: Math.floor(PAIRING_TTL_MS / 1000),
      qrPayload: JSON.stringify(payload),
      localAddresses: listLanAddresses(),
      baseUrls,
    })
  })
  .post('/pair/confirm', async (c) => {
    cleanupExpiredPairings()
    pushMobileEvent({
      type: 'pairing.confirm.received',
      message: '收到移动端配对请求',
    })
    const body: Record<string, unknown> = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({} as Record<string, unknown>))
    const code = typeof body.pairingCode === 'string' ? body.pairingCode.trim() : ''
    if (!code) {
      pushMobileEvent({ type: 'pairing.confirm.failed', message: '移动端配对失败：配对码为空' })
      return c.json({ error: '配对码不能为空' }, 400)
    }
    const record = pairings.get(code)
    if (!record) {
      pushMobileEvent({ type: 'pairing.confirm.failed', message: '移动端配对失败：配对码不存在或已过期' })
      return c.json({ error: '配对码不存在或已过期' }, 404)
    }
    if (record.expiresAt < Date.now()) {
      pairings.delete(code)
      pushMobileEvent({ type: 'pairing.confirm.failed', message: '移动端配对失败：配对码已过期' })
      return c.json({ error: '配对码已过期' }, 410)
    }
    pairings.delete(code)
    const requestBaseUrl = requestOrigin(c.req.raw)
    const baseUrl = requestBaseUrl && isAllowedPairingBaseUrl(requestBaseUrl, record.baseUrls)
      ? requestBaseUrl
      : record.baseUrl
    const webUrl = record.webUrls.find((item) => sameHost(item, baseUrl)) ?? record.webUrl
    pushMobileEvent({
      type: 'pairing.confirmed',
      message: `移动端已配对：${baseUrl}`,
    })
    return c.json({
      baseUrl,
      webUrl,
      deviceName: typeof body.deviceName === 'string' && body.deviceName.trim() ? body.deviceName.trim() : 'Android',
      authToken: `mobile_${randomUUID().replace(/-/g, '')}`,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    })
  })

function getServerPort() {
  return getRuntimeServerPort() ?? Number(env.PORT || 8000)
}

function pushMobileEvent(event: { type: string; message: string }) {
  mobileEvents.unshift({ ...event, at: new Date().toISOString() })
  mobileEvents.splice(20)
}

async function mobileConnectivityStatus() {
  const port = getServerPort()
  const addresses = listLanAddresses()
  const baseUrls = addresses.map((address) => `http://${address}:${port}`)
  const [networkProfiles, firewall] = await Promise.all([
    getNetworkProfiles(),
    getFirewallStatus(port),
  ])
  const publicProfiles = networkProfiles.filter((item) => item.networkCategory.toLowerCase() === 'public')
  const activePairings = [...pairings.values()].map((record) => ({
    baseUrl: record.baseUrl,
    baseUrls: record.baseUrls,
    expiresAt: new Date(record.expiresAt).toISOString(),
  }))
  return {
    port,
    localAddresses: addresses,
    baseUrls,
    networkProfiles,
    firewall,
    activePairings,
    recentEvents: mobileEvents,
    message: publicProfiles.length
      ? '当前网络为 Public，Windows 可能阻止手机热点入站连接。建议开放 AgentHub 端口，或将该网络改为专用网络。'
      : firewall.allowed
        ? '局域网连接配置看起来正常。'
        : '未检测到 AgentHub 入站防火墙规则，手机可能无法连接。',
  }
}

async function getNetworkProfiles() {
  if (process.platform !== 'win32') return [] as Array<{ name: string; interfaceAlias: string; networkCategory: string; ipv4Connectivity: string }>
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-NetConnectionProfile | Select-Object Name,InterfaceAlias,NetworkCategory,IPv4Connectivity | ConvertTo-Json -Compress',
      ],
      { timeout: 3000, windowsHide: true },
    )
    return normalizeNetworkProfiles(JSON.parse(stdout || '[]'))
  } catch {
    return []
  }
}

function normalizeNetworkProfiles(value: any) {
  const items = Array.isArray(value) ? value : value ? [value] : []
  return items.map((item) => ({
    name: String(item.Name ?? ''),
    interfaceAlias: String(item.InterfaceAlias ?? ''),
    networkCategory: String(item.NetworkCategory ?? ''),
    ipv4Connectivity: String(item.IPv4Connectivity ?? ''),
  }))
}

async function getFirewallStatus(port: number) {
  const ruleName = firewallRuleName(port)
  if (process.platform !== 'win32') {
    return { ruleName, allowed: true, supported: false, rules: [], message: '当前系统不是 Windows，无需使用 Windows 防火墙修复。' }
  }
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        [
          `$rules = Get-NetFirewallRule -DisplayName ${quotePowerShellString(ruleName)} -ErrorAction SilentlyContinue |`,
          'Select-Object DisplayName,Enabled,Direction,Action,Profile;',
          'if ($rules) { $rules | ConvertTo-Json -Compress } else { "[]" }',
        ].join(' '),
      ],
      { timeout: 3000, windowsHide: true },
    )
    const rules = normalizeFirewallRules(JSON.parse(stdout || '[]'))
    const allowed = rules.some((rule) => rule.enabled && rule.direction === 'Inbound' && rule.action === 'Allow')
    return {
      ruleName,
      allowed,
      supported: true,
      rules,
      message: allowed ? `已放行 ${port} 端口。` : `未检测到 ${ruleName} 防火墙放行规则。`,
    }
  } catch (error: any) {
    return { ruleName, allowed: false, supported: true, rules: [], message: error?.message || '读取 Windows 防火墙状态失败。' }
  }
}

function normalizeFirewallRules(value: any) {
  const items = Array.isArray(value) ? value : value ? [value] : []
  return items.map((item) => ({
    displayName: String(item.DisplayName ?? ''),
    enabled: String(item.Enabled ?? '').toLowerCase() === 'true',
    direction: String(item.Direction ?? ''),
    action: String(item.Action ?? ''),
    profile: String(item.Profile ?? ''),
  }))
}

async function openFirewallPort(port: number) {
  const ruleName = firewallRuleName(port)
  if (process.platform !== 'win32') {
    return { ok: true, message: '当前系统不是 Windows，无需开放 Windows 防火墙端口。' }
  }
  const script = [
    `$name = ${quotePowerShellString(ruleName)};`,
    `$existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue;`,
    'if ($existing) {',
    '  Set-NetFirewallRule -DisplayName $name -Enabled True -Direction Inbound -Action Allow -Profile Any | Out-Null;',
    '} else {',
    `  New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Any | Out-Null;`,
    '}',
  ].join(' ')
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 8000, windowsHide: true })
    return { ok: true, message: `已尝试开放 Windows 防火墙 TCP ${port} 入站端口。` }
  } catch (error: any) {
    const elevated = await openFirewallPortElevated(port)
    if (elevated.ok) return elevated
    return {
      ok: false,
      message: [
        `自动开放 TCP ${port} 端口失败，可能需要以管理员身份运行。`,
        `管理员 PowerShell 可执行：New-NetFirewallRule -DisplayName "${ruleName}" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Any`,
        error?.message ? `错误：${error.message}` : '',
      ].filter(Boolean).join('\n'),
    }
  }
}

async function openFirewallPortElevated(port: number) {
  const ruleName = firewallRuleName(port)
  const elevatedScript = [
    `$name = ${quotePowerShellString(ruleName)};`,
    `$existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue;`,
    'if ($existing) {',
    '  Set-NetFirewallRule -DisplayName $name -Enabled True -Direction Inbound -Action Allow -Profile Any | Out-Null;',
    '} else {',
    `  New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Any | Out-Null;`,
    '}',
  ].join(' ')
  const encoded = Buffer.from(elevatedScript, 'utf16le').toString('base64')
  const launcherScript = [
    `$encoded = ${quotePowerShellString(encoded)};`,
    "Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-EncodedCommand',$encoded) -Verb RunAs -Wait;",
  ].join(' ')
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', launcherScript], { timeout: 90_000, windowsHide: true })
    const status = await getFirewallStatus(port)
    return {
      ok: status.allowed,
      message: status.allowed
        ? `已通过管理员权限开放 Windows 防火墙 TCP ${port} 入站端口。`
        : `已请求管理员权限，但没有检测到 ${ruleName} 规则；可能是 UAC 被取消。`,
    }
  } catch (error: any) {
    return {
      ok: false,
      message: [
        `请求管理员权限开放 TCP ${port} 端口失败。`,
        `请手动以管理员身份运行 PowerShell：New-NetFirewallRule -DisplayName "${ruleName}" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Any`,
        error?.message ? `错误：${error.message}` : '',
      ].filter(Boolean).join('\n'),
    }
  }
}

function firewallRuleName(port: number) {
  return `AgentHub Server ${port}`
}

function quotePowerShellString(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

function createPairingCode() {
  return randomBytes(6).toString('base64url')
}

function cleanupExpiredPairings() {
  const now = Date.now()
  for (const [code, record] of pairings) {
    if (record.expiresAt <= now) pairings.delete(code)
  }
}

function uniqueHosts(hosts: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const host of hosts) {
    const normalized = normalizeHost(host)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function normalizeHost(value: string) {
  return value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
}

function requestOrigin(request: Request) {
  const url = new URL(request.url)
  const host = request.headers.get('host') || url.host
  if (!host) return ''
  const proto = request.headers.get('x-forwarded-proto') || url.protocol.replace(/:$/, '') || 'http'
  return `${proto}://${host}`
}

function isAllowedPairingBaseUrl(value: string, allowed: string[]) {
  const normalized = value.replace(/\/+$/, '').toLowerCase()
  return allowed.some((item) => item.replace(/\/+$/, '').toLowerCase() === normalized)
}

function sameHost(left: string, right: string) {
  try {
    return new URL(left).hostname === new URL(right).hostname
  } catch {
    return false
  }
}

async function pickLanAddress() {
  const addresses = listLanAddresses()
  const defaultRouteAddress = await getDefaultRouteAddress()
  if (defaultRouteAddress && addresses.includes(defaultRouteAddress)) return defaultRouteAddress
  return addresses[0] ?? defaultRouteAddress ?? '127.0.0.1'
}

function listLanAddresses() {
  const candidates: Array<{ address: string; alias: string; score: number }> = []
  for (const [alias, items] of Object.entries(networkInterfaces())) {
    for (const item of items ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue
      const score = scoreNetworkAddress(alias, item.address)
      if (score < 0) continue
      candidates.push({ address: item.address, alias, score })
    }
  }
  return candidates
    .sort((a, b) => b.score - a.score || a.alias.localeCompare(b.alias))
    .map((item) => item.address)
}

async function getDefaultRouteAddress() {
  if (process.platform !== 'win32') return undefined
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        [
          '$route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" |',
          'Where-Object { $_.NextHop -ne "0.0.0.0" } |',
          'Sort-Object RouteMetric,InterfaceMetric |',
          'Select-Object -First 1;',
          'if ($route) {',
          'Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex |',
          'Where-Object { $_.IPAddress -notlike "169.254.*" } |',
          'Select-Object -First 1 -ExpandProperty IPAddress',
          '}',
        ].join(' '),
      ],
      { timeout: 2000, windowsHide: true },
    )
    const address = stdout.trim()
    if (address && scoreNetworkAddress('', address) >= 0) return address
  } catch {
    // PowerShell route probing is best-effort; fall back to Node networkInterfaces.
  }
  return undefined
}

function scoreNetworkAddress(alias: string, address: string) {
  if (address.startsWith('169.254.')) return -1
  if (/(virtual|vmware|virtualbox|hyper-v|vethernet|wsl|tap|radmin|loopback|docker)/i.test(alias)) {
    return -1
  }
  if (address.startsWith('192.168.56.') || address.startsWith('192.168.110.') || address.startsWith('192.168.190.')) return -1
  if (/^(wlan|wi-fi|wifi|无线|以太网|ethernet)/i.test(alias)) return 100
  if (address.startsWith('192.168.') || address.startsWith('10.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) return 50
  return 10
}
