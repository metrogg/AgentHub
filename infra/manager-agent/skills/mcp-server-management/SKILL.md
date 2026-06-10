---
name: mcp-server-management
description: Use when configuring MCP Server tools for Workers. MCP Servers provide external API access through a standardized protocol.
---

# MCP Server Management

Configure MCP Server tools that Workers can use to access external APIs.

## How It Works

MCP Servers are configured in the Worker's `openclaw.json` under the `mcpServers` section. The Manager can push MCP server configurations to Workers via the controller.

## Configuration

MCP server configs are injected into the Worker's workspace as `mcporter-servers.json`:

```json
{
  "servers": {
    "github": {
      "url": "https://mcp.github.com",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

## Rules

- MCP access is scoped per Worker — not all Workers need the same MCP servers.
- Never expose raw API keys in chat messages.
- MCP server changes require a Worker restart or config sync.

## Decision Pattern

1. Determine which Worker needs which MCP capability and why.
2. Check whether the MCP server is supported in the current AgentHub deployment.
3. Ask the human before adding credentials or external access.
4. Apply scoped configuration through Controller APIs or report that the enterprise feature is not enabled.
5. Trigger Worker config sync/restart only after the room-visible approval.
