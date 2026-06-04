import { API_BASE, ApiError, request } from './apiClient'

export const artifactApi = {
  // Artifacts
  deployStatic: (workspaceId: string) =>
    request<{ deployId: string; url: string; status: 'ready' }>('/artifacts/deploy-static', {
      method: 'POST',
      body: JSON.stringify({ workspaceId }),
    }),
  applyDiff: (workspaceId: string, diff: string) =>
    request<{ success: boolean; message: string; stagedFiles?: string[] }>('/artifacts/apply-diff', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, diff }),
    }),
  downloadZip: async (workspaceId: string) => {
    const res = await fetch(
      `${API_BASE}/artifacts/zip-download?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        credentials: 'include',
      },
    )
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new ApiError(res.status, body?.error ?? body?.message ?? `HTTP ${res.status}`)
    }
    return res.blob()
  },

  // Files
  writeFile: (data: {
    workspaceId: string
    filePath: string
    content: string
    startLine?: number
    endLine?: number
  }) =>
    request<{ ok: boolean; lines?: number }>('/files', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
}
