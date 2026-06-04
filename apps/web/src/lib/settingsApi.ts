import { request } from './apiClient'
import type {
  CcswitchModel,
  MobileConnectivityStatus,
  MobileFirewallAction,
  MobilePairStartResult,
  SettingsConsoleLogsResponse,
  SettingsGeneralInfo,
  StarOfficeStatus,
} from './apiTypes'

export const settingsApi = {
  // Settings (map-based)
  getSettings: () => request<Record<string, string>>('/settings'),
  saveSettings: (data: Record<string, string>) =>
    request<{ success: boolean }>('/settings', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  resetAllApplicationData: (confirm = 'RESET_AGENTHUB_DATA') =>
    request<{ success: boolean; message: string; preserved: string[] }>(
      '/settings/reset-all-data',
      {
        method: 'POST',
        body: JSON.stringify({ confirm }),
      },
    ),
  cleanupLegacyData: () =>
    request<{
      success: boolean
      message: string
      deletedSessions: number
      deletedMessages: number
      deletedSessionMembers: number
      deletedWorkspaceTasks: number
      deletedLegacyTasks: number
      deletedLegacyAgents: number
      deletedEmptyWorkspaces: number
      cleanedSettings: number
    }>('/settings/cleanup-legacy-data', {
      method: 'POST',
    }),
  getRuntimeInfo: () =>
    request<{
      git: { runtime: string; path: string; ok: boolean; message: string }
      python: { runtime: string; path: string; ok: boolean; message: string }
    }>('/settings/runtime-info'),
  getSettingsGeneralInfo: () => request<SettingsGeneralInfo>('/settings/general-info'),
  getSettingsConsoleLogs: (limit = 160) =>
    request<SettingsConsoleLogsResponse>(`/settings/console-logs?limit=${encodeURIComponent(String(limit))}`),
  setupDockerSandbox: () =>
    request<{ ok: boolean; message: string; steps: Array<{ command: string; ok: boolean; output: string }>; sandbox: SettingsGeneralInfo['sandbox'] }>(
      '/settings/sandbox/docker/setup',
      {
        method: 'POST',
      },
    ),
  loginDockerSandbox: () =>
    request<{ ok: boolean; started: boolean; message: string; sandbox: SettingsGeneralInfo['sandbox'] }>(
      '/settings/sandbox/docker/login',
      {
        method: 'POST',
      },
    ),
  startMobilePairing: () =>
    request<MobilePairStartResult>('/mobile/pair/start', { method: 'POST' }),
  getMobileConnectivity: () => request<MobileConnectivityStatus>('/mobile/connectivity'),
  openMobileFirewall: () =>
    request<MobileFirewallAction>('/mobile/firewall/open', { method: 'POST', timeout: 12_000 }),
  getStarOfficeStatus: () => request<StarOfficeStatus>('/office/status'),
  startStarOffice: () =>
    request<StarOfficeStatus>('/office/start', { method: 'POST', timeout: 15_000 }),
  joinOfficeAgents: (sessionId: string) =>
    request<{ ok: boolean; joined: string[]; total: number }>('/office/join-agents', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }),
  ensureStorageDirectory: (path: string) =>
    request<{ ok: boolean; path: string; sizeBytes: number; sizeLabel: string; message: string }>(
      '/settings/storage/ensure',
      {
        method: 'POST',
        body: JSON.stringify({ path }),
      },
    ),
  openLocalPath: (path: string) =>
    request<{ ok: boolean; message: string }>('/settings/storage/open-path', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  testModel: (data: {
    provider: string
    apiEndpoint: string
    anthropicEndpoint?: string
    apiKey?: string
    apiKeyEnv?: string
    modelId?: string
  }) =>
    request<{ ok: boolean; status?: number; message: string }>('/settings/test-model', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getCcswitchModels: () =>
    request<{ models: CcswitchModel[] }>('/settings/ccswitch-models'),
}
