import { randomBytes, randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { Hono } from 'hono'
import { env } from '../env'
import { authMiddleware, type AuthVariables } from '../middleware/auth'

const PAIRING_TTL_MS = 2 * 60 * 1000

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
    const host = typeof body.host === 'string' && body.host.trim() ? body.host.trim() : pickLanAddress()
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

function pickLanAddress() {
  return listLanAddresses()[0] ?? '127.0.0.1'
}

function listLanAddresses() {
  const addresses: string[] = []
  for (const items of Object.values(networkInterfaces())) {
    for (const item of items ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue
      addresses.push(item.address)
    }
  }
  return addresses
}
