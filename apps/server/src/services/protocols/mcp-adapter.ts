import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { APP_VERSION } from '@agenthub/shared'

export function createAgentHubMcpServer() {
  return new McpServer(
    {
      name: 'AgentHub',
      version: APP_VERSION,
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
      instructions:
        'AgentHub exposes workspace, agent, task, and artifact context as MCP resources/tools. The first production tools should remain read-only until the AgentHub permission model is fully wired.',
    },
  )
}

export function buildMcpManifest() {
  return {
    name: 'AgentHub MCP',
    version: APP_VERSION,
    status: 'adapter-ready',
    transports: ['streamable-http'],
    plannedResources: [
      'agenthub://workspaces',
      'agenthub://workspaces/{workspaceId}',
      'agenthub://workspaces/{workspaceId}/tasks',
      'agenthub://artifacts/{artifactId}',
    ],
    plannedTools: [
      {
        name: 'agenthub.workspace.inspect',
        safety: 'read-only',
      },
      {
        name: 'agenthub.artifact.open',
        safety: 'read-only',
      },
      {
        name: 'agenthub.task.dispatch',
        safety: 'requires-approval',
      },
    ],
  }
}
