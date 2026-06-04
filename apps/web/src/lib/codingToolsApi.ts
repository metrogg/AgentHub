import { request } from './apiClient'
import type {
  AgentAdapterCatalogResponse,
  CliInstallAction,
  CodexAuthAction,
  CodexAuthStatus,
  CodexConfigFile,
  CodexLoginPoll,
  CodexLoginStart,
  CodingToolProbe,
  CodingToolStatusResponse,
  CodingToolsStartupLifecycleResult,
  LocalAgentRuntimeAddResponse,
  LocalAgentRuntimeCatalogResponse,
  OpenClawAgentsCatalogResponse,
  OpencodeModelsResponse,
} from './apiTypes'

export const codingToolsApi = {
  // Coding tools
  getCodingToolStatus: (tools?: CodingToolProbe[]) =>
    tools?.length
      ? request<CodingToolStatusResponse>('/coding-tools/status', {
          method: 'POST',
          body: JSON.stringify({ tools }),
        })
      : request<CodingToolStatusResponse>('/coding-tools/status'),
  getAgentAdapters: () => request<AgentAdapterCatalogResponse>('/coding-tools/agent-adapters'),
  getOpenClawAgents: () => request<OpenClawAgentsCatalogResponse>('/coding-tools/openclaw/agents'),
  getLocalAgentRuntimes: () =>
    request<LocalAgentRuntimeCatalogResponse>('/coding-tools/local-agent-runtimes'),
  addLocalAgentRuntime: (id: string, data?: { command?: string }) =>
    request<LocalAgentRuntimeAddResponse>(
      `/coding-tools/local-agent-runtimes/${encodeURIComponent(id)}/add`,
      {
        method: 'POST',
        body: data ? JSON.stringify(data) : undefined,
      },
    ),
  installAllCliTools: () =>
    request<CliInstallAction>('/coding-tools/cli/install', { method: 'POST' }),
  ensureCodingToolsStartupLifecycle: () =>
    request<CodingToolsStartupLifecycleResult>('/coding-tools/lifecycle/startup', {
      method: 'POST',
    }),
  getOpencodeModels: () => request<OpencodeModelsResponse>('/coding-tools/opencode/models'),
  getCodexConfig: () => request<CodexConfigFile>('/coding-tools/codex/config'),
  saveCodexConfig: (content: string) =>
    request<CodexConfigFile>('/coding-tools/codex/config', {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  getCodexAuthFile: () => request<CodexConfigFile>('/coding-tools/codex/auth-file'),
  saveCodexAuthFile: (content: string) =>
    request<CodexConfigFile>('/coding-tools/codex/auth-file', {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  getCodexAuthStatus: () => request<CodexAuthStatus>('/coding-tools/codex/auth/status'),
  startCodexChatGptLogin: () =>
    request<CodexLoginStart>('/coding-tools/codex/auth/start', { method: 'POST' }),
  openCodexChatGptDevicePage: () =>
    request<CodexAuthAction>('/coding-tools/codex/auth/open-device', { method: 'POST' }),
  pollCodexChatGptLogin: (loginId: string) =>
    request<CodexLoginPoll>('/coding-tools/codex/auth/poll', {
      method: 'POST',
      body: JSON.stringify({ loginId }),
    }),
  retryCodexChatGptAuth: () =>
    request<CodexAuthAction>('/coding-tools/codex/auth/retry', { method: 'POST' }),
  logoutCodexChatGpt: () =>
    request<CodexAuthAction>('/coding-tools/codex/auth/logout', { method: 'POST' }),
}
