import { api } from './api'

export type AccountProfile = {
  name: string
  avatar: string
}

export type ProfileSettingsLike = {
  accountName?: unknown
  accountAvatar?: unknown
}

export const defaultAccountProfile: AccountProfile = {
  name: 'You',
  avatar: '',
}

const accountProfileCacheKey = 'agenthub:account-profile-cache'

let cachedAccountProfile: AccountProfile = readStoredAccountProfile()
let pendingAccountProfileLoad: Promise<AccountProfile> | null = null
let lastAccountProfileLoadAt = 0
const accountProfileCacheTtlMs = 30_000

export function getCachedAccountProfile() {
  return cachedAccountProfile
}

export function cacheAccountProfileFromSettingsValue(value?: string) {
  const profile = readAccountProfile(value)
  cacheAccountProfile(profile)
  return profile
}

export function cacheAccountProfileFromProfile(profile: ProfileSettingsLike) {
  const next = {
    name:
      typeof profile.accountName === 'string' && profile.accountName.trim()
        ? profile.accountName.trim()
        : defaultAccountProfile.name,
    avatar: typeof profile.accountAvatar === 'string' ? profile.accountAvatar : '',
  }
  cacheAccountProfile(next)
  return next
}

export async function loadAccountProfileFromSettings(options: { force?: boolean } = {}) {
  if (!options.force && lastAccountProfileLoadAt && Date.now() - lastAccountProfileLoadAt < accountProfileCacheTtlMs) {
    return cachedAccountProfile
  }
  if (pendingAccountProfileLoad) return pendingAccountProfileLoad
  pendingAccountProfileLoad = api
    .getSettings()
    .then((settings) => {
      lastAccountProfileLoadAt = Date.now()
      return cacheAccountProfileFromSettingsValue(settings.APP_SETTINGS)
    })
    .catch(() => cachedAccountProfile)
    .finally(() => {
      pendingAccountProfileLoad = null
    })
  return pendingAccountProfileLoad
}

export function sameAccountProfile(a: AccountProfile, b: AccountProfile) {
  return a.name === b.name && a.avatar === b.avatar
}

function cacheAccountProfile(profile: AccountProfile) {
  cachedAccountProfile = profile
  try {
    window.localStorage.setItem(accountProfileCacheKey, JSON.stringify(profile))
  } catch {
    // localStorage can be unavailable in restricted environments.
  }
}

function readStoredAccountProfile() {
  try {
    const stored = window.localStorage.getItem(accountProfileCacheKey)
    if (!stored) return defaultAccountProfile
    const parsed = JSON.parse(stored) as Partial<AccountProfile>
    return {
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : defaultAccountProfile.name,
      avatar: typeof parsed.avatar === 'string' ? parsed.avatar : '',
    }
  } catch {
    return defaultAccountProfile
  }
}

function readAccountProfile(value?: string): AccountProfile {
  if (!value) return cachedAccountProfile
  try {
    const parsed = JSON.parse(value) as ProfileSettingsLike
    return cacheAccountProfileFromProfile(parsed)
  } catch {
    return cachedAccountProfile
  }
}
