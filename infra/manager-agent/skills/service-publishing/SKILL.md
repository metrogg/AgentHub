---
name: service-publishing
description: Use when exposing Worker services (web servers, APIs) to external access.
---

# Service Publishing

Expose Worker services for external access.

## How It Works

Workers can run web servers or APIs as part of their tasks. The Manager can expose these services through the platform's gateway.

## Commands

```bash
# Create a worker that exposes ports
agenthub worker create --workspace <id> --name web-builder --runtime-base <openclaw|qwenpaw|opencode|claude-code|codex|gemini> --model <model-id>

# The Worker specifies exposed ports in its task result
# The Manager coordinates port allocation and gateway routing
```

## Rules

- Port conflicts must be resolved before exposing services.
- Exposed services should have health checks.
- Clean up exposed services when the associated task completes.
- Security: exposed services should not contain sensitive credentials in their URLs.

## Decision Pattern

1. Confirm the Worker produced a running service and a health endpoint.
2. Check port allocation, workspace, and security constraints.
3. Ask the human before exposing anything outside local development.
4. Register the service through Controller/gateway APIs when available.
5. Post the service URL, health status, and cleanup policy to the room.
