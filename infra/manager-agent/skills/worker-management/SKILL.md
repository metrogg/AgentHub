---
name: worker-management
description: Use when you need to create, inspect, wake, sleep, stop, or update Worker agents.
---

# Worker Management

Manage the lifecycle of Worker agents via the `agenthub` CLI.

## Commands

```bash
# List all workers
agenthub worker list --workspace <workspace-id>

# Create a new worker with an explicit Worker runtime base
agenthub worker create --workspace <workspace-id> --name builder --code-agent <openclaw|opencode|claude-code|codex|gemini>

# Check worker status
agenthub worker status --id <worker-id>

# Wake a sleeping worker
agenthub worker wake --id <worker-id>

# Stop a running worker
agenthub worker stop --id <worker-id>
```

## Rules

- Prefer existing suitable workers before creating a new one.
- New worker creation must be visible in the room — announce it.
- Worker names must be lowercase alphanumeric with hyphens.
- Each Worker needs: name, Worker runtime base, model binding, skills, and sandbox policy.
- Never default a missing runtime base to Codex. Ask the human or report the missing configuration.

## Decision Pattern

1. Read the room timeline to understand what worker capability is needed.
2. `agenthub worker list --workspace <id>` to check existing workers.
3. If a suitable worker exists, use it. If not, propose creating one.
4. After creating a worker, announce it in the room.
