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
