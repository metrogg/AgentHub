import { randomBytes, randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Hono } from 'hono'
import { env } from '../env'
import { authMiddleware, type AuthVariables } from '../middleware/auth'

const PAIRING_TTL_MS = 2 * 60 * 1000
const execFileAsync = promisify(execFile)

interface PairingRecord {
  code: string
  baseUrl: string
  webUrl: string
  expiresAt: number
}

const pairings = new Map<string, PairingRecord>()

export const mobileRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('/pair/start', authMiddleware)
  .post('/pair/start', async (c) => {
    cleanupExpiredPairings()
    const body: Record<string, unknown> = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({} as Record<string, unknown>))
    const host = typeof body.host === 'string' && body.host.trim() ? body.host.trim() : await pickLanAddress()
    const port = typeof body.port === 'number' ? body.port : Number(env.PORT || 8000)
    const webPort = typeof body.webPort === 'number' ? body.webPort : 5173
    const code = createPairingCode()
    const expiresAt = Date.now() + PAIRING_TTL_MS
    const baseUrl = `http://${host}:${port}`
    const webUrl = `http://${host}:${webPort}`
    const record: PairingRecord = { code, baseUrl, webUrl, expiresAt }
    pairings.set(code, record)
    const payload = {
      version: 1,
      baseUrl,
      webUrl,
      pairingCode: code,
      expiresAt: new Date(expiresAt).toISOString(),
    }
    return c.json({
      ...payload,
      ttlSeconds: Math.floor(PAIRING_TTL_MS / 1000),
      qrPayload: JSON.stringify(payload),
      localAddresses: listLanAddresses(),
    })
  })
  .post('/pair/confirm', async (c) => {
    cleanupExpiredPairings()
    const body: Record<string, unknown> = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({} as Record<string, unknown>))
    const code = typeof body.pairingCode === 'string' ? body.pairingCode.trim() : ''
    if (!code) return c.json({ error: '配对码不能为空' }, 400)
    const record = pairings.get(code)
    if (!record) return c.json({ error: '配对码不存在或已过期' }, 404)
    if (record.expiresAt < Date.now()) {
      pairings.delete(code)
      return c.json({ error: '配对码已过期' }, 410)
    }
    pairings.delete(code)
    return c.json({
      baseUrl: record.baseUrl,
      webUrl: record.webUrl,
      deviceName: typeof body.deviceName === 'string' && body.deviceName.trim() ? body.deviceName.trim() : 'Android',
      authToken: `mobile_${randomUUID().replace(/-/g, '')}`,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    })
  })

function createPairingCode() {
  return randomBytes(6).toString('base64url')
}

function cleanupExpiredPairings() {
  const now = Date.now()
  for (const [code, record] of pairings) {
    if (record.expiresAt <= now) pairings.delete(code)
  }
}

async function pickLanAddress() {
  const defaultRouteAddress = await getDefaultRouteAddress()
  if (defaultRouteAddress) return defaultRouteAddress
  return listLanAddresses()[0] ?? '127.0.0.1'
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
