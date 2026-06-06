---
name: agenthub-controller
description: Use when you need to interact with the AgentHub Controller — create tasks, create workers, check status, send heartbeat.
---

# AgentHub Controller CLI

Use the `agenthub` CLI to interact with the AgentHub Controller. It wraps the Controller API into clean commands.

## Authentication

Your Manager token is set in the environment:
```
AGENTHUB_MANAGER_TOKEN=<your-matrix-access-token>
AGENTHUB_CONTROLLER_URL=http://localhost:3001
```

The CLI reads these automatically. No manual header injection needed.

## Commands

### Worker Management

```bash
# List all workers in a workspace
agenthub worker list --workspace <workspace-id>

# Create a new worker with an explicit Worker runtime base
agenthub worker create --workspace <workspace-id> --name builder --runtime-base <openclaw|opencode|claude-code|codex|gemini> --model <model-id> --join-group-room true

# Check worker status
agenthub worker status --id <worker-id>

# Wake a sleeping worker
agenthub worker wake --id <worker-id>

# Stop a running worker
agenthub worker stop --id <worker-id>
```

### Task Management

```bash
# Create and assign a task
agenthub task create --workspace <workspace-id> --title "Build UI" --assign-to <agent-id> --spec "## Goal\nBuild a React dashboard"

# List tasks in a run
agenthub task list --run <run-id>

# Check task status
agenthub task status --id <task-id>

# Mark task complete
agenthub task complete --id <task-id>

# Mark task failed
agenthub task fail --id <task-id> --reason "timeout"

# Retry a failed task
agenthub task retry --id <task-id>
```

### Run Management

```bash
# Create a new run
agenthub run create --workspace <workspace-id> --goal "Build a website"

# Check run status (includes all tasks)
agenthub run status --id <run-id>

# Cancel a run
agenthub run cancel --id <run-id> --reason "user requested"

# List recent runs
agenthub run list --workspace <workspace-id>
```

### Room Operations

```bash
# Create a room
agenthub room create --owner <owner-id> --title "Worker: builder" --kind task

# Read room timeline
agenthub room events --room <room-id> --limit 20

# @mention a participant
agenthub room mention --room <room-id> --agent <agent-id> --body "Please start task task-123"
```

### Workspace State

```bash
# Get full workspace state (tasks, workers, agents, latest run)
agenthub state --workspace <workspace-id>

# Send heartbeat
agenthub heartbeat --workspace <workspace-id>
```

## Output

All commands output JSON by default. Parse with `jq` when needed:
```bash
agenthub worker list --workspace ws-123 | jq '.workers[] | .name'
agenthub run status --id run-456 | jq '.tasks[] | {title, status}'
```

## Decision Pattern

### Simple goal (1 task, 1 Worker)
1. `agenthub worker list --workspace <id>` — check existing workers
2. If no suitable worker: ask for or use the explicitly requested runtime base and model, then `agenthub worker create --workspace <id> --name <name> --runtime-base <runtime-base> --model <model-id>`
3. `agenthub task create --workspace <id> --title "..." --assign-to <agent-id> --spec "..."`
4. `agenthub room mention --room <task-room> --agent <agent-id> --body "Please start task <id>"`

### Complex goal (multiple tasks)
1. `agenthub run create --workspace <id> --goal "..."` — create run
2. `agenthub task create` for each task with `--run <run-id>` and dependency info
3. `agenthub room mention` for each worker when dependencies are met
4. `agenthub run status --id <run-id>` to monitor progress
5. Synthesize results when all tasks complete

## Error Handling

- `Error: HTTP 401` — Token expired. Report to human admin.
- `Error: HTTP 404` — Resource not found. Check IDs.
- `Error: HTTP 422` — Validation failed. Read error message and fix params.
- Network errors — Retry up to 3 times with 2s delay.
