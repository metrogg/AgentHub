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
agenthub worker create --workspace <id> --name web-builder --code-agent codex

# The Worker specifies exposed ports in its task result
# The Manager coordinates port allocation and gateway routing
```

## Rules

- Port conflicts must be resolved before exposing services.
- Exposed services should have health checks.
- Clean up exposed services when the associated task completes.
- Security: exposed services should not contain sensitive credentials in their URLs.
