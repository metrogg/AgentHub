export * from './apiClient'
export * from './apiTypes'
export { agentConfigApi } from './agentConfigApi'
export { artifactApi } from './artifactApi'
export { chatApi } from './chatApi'
export { codingToolsApi } from './codingToolsApi'
export { settingsApi } from './settingsApi'
export { workspaceApi } from './workspaceApi'

import { agentConfigApi } from './agentConfigApi'
import { artifactApi } from './artifactApi'
import { chatApi } from './chatApi'
import { codingToolsApi } from './codingToolsApi'
import { settingsApi } from './settingsApi'
import { workspaceApi } from './workspaceApi'

export const api = {
  ...chatApi,
  ...settingsApi,
  ...codingToolsApi,
  ...agentConfigApi,
  ...workspaceApi,
  ...artifactApi,
}
