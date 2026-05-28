/**
 * Extract a display-friendly workspace name from a filesystem path.
 * Takes the last non-empty path segment (e.g. "/home/user/my-project" → "my-project").
 * Falls back to '项目文件夹' when the path is empty or contains only slashes.
 */
export function workspaceNameFromPath(value: string, fallback = '项目文件夹'): string {
  const normalized = value.trim().replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).filter(Boolean).pop() || fallback
}
