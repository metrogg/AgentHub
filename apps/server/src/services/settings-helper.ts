import { db, eq, settings } from '@agenthub/db'

export async function getSettingValue(key: string): Promise<string | undefined> {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1)
  return rows[0]?.value
}

export async function getBooleanSetting(key: string, fallback: boolean): Promise<boolean> {
  const value = await getSettingValue(key)
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false
  return fallback
}
