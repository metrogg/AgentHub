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
AGENTHUB_CONTROLLER_URL=<injected-controller-url>
```

The CLI reads these automatically. No manual header injection needed. Do not hard-code localhost ports; local, Docker, and future remote modes differ.

## Commands

### Capability Discovery

```bash
# Read the Controller operation schema before using unfamiliar capabilities.
agenthub schema
```

### Worker Management

```bash
# List all workers in a workspace
agenthub worker list --workspace <workspace-id>

# Create a new worker with an explicit Worker runtime base
agenthub worker create --workspace <workspace-id> --name builder --runtime-base <openclaw|qwenpaw|copaw|opencode|claude-code|codex|gemini> --model <model-id> --join-group-room true

# Apply a Worker manifest through the Controller.
agenthub apply -f worker.yaml

# Request Room-native approval before applying a manifest.
agenthub apply -f worker.yaml --approval-mode request --room <room-id> --reason "Need confirmation before adding capacity"

# Apply a previously approved Controller approval request.
agenthub approval confirm --event <approval-timeline-event-id> --approved-by <human-or-manager> --reason "Approved in room"

# Deny a pending Controller approval request without applying it.
agenthub approval deny --event <approval-timeline-event-id> --denied-by <human-or-manager> --reason "Not needed"

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

# Apply a Task manifest through the Controller.
agenthub apply -f task.yaml

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

# Apply a Room manifest through the Controller.
agenthub apply -f room.yaml

# Read room timeline
agenthub room events --room <room-id> --limit 20

# @mention a participant
agenthub room mention --room <room-id> --agent <agent-id> --body "Please start task task-123"
```

### Team and Human Management

```bash
# Apply Team/Human manifests through the Controller.
agenthub apply -f team.yaml
agenthub apply -f human.yaml

# Teams group existing Workers; create missing Workers separately first.
agenthub team create --workspace <workspace-id> --name delivery-team --leader-name delivery-lead --workers existing-builder,existing-reviewer

# Humans are first-class collaborators.
agenthub human create --name admin-user --display-name "Admin User" --permission-level 1
```

### Manager Contract Reconcile

```bash
# Refresh Manager SOUL/AGENTS/skills/registries/state/rooms from Controller.
# Without spec.desiredState this is contract-only. With desiredState=running/stopped it also reconciles the resident process lifecycle.
agenthub apply -f manager.yaml
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
1. `agenthub schema` — confirm the current Controller operation contract.
2. `agenthub worker list --workspace <id>` — check existing workers
3. If no suitable worker: ask for or use the explicitly requested runtime base and model.
4. If the room policy or action risk requires confirmation, use `agenthub apply -f worker.yaml --approval-mode request --room <room-id>` and wait for `agenthub approval confirm ...`.
5. Otherwise use `agenthub worker create --workspace <id> --name <name> --runtime-base <runtime-base> --model <model-id>` or `agenthub apply -f worker.yaml`.
6. `agenthub task create --workspace <id> --title "..." --assign-to <agent-id> --spec "..."` or `agenthub apply -f task.yaml`.
7. Let the Controller-created task room @mention wake the Worker; use `agenthub room mention` only for explicit follow-up messages.

### Complex goal (multiple tasks)
1. `agenthub schema` — inspect `tasks.assign`, `apply.manifest`, and `reconcile.resource`.
2. `agenthub run create --workspace <id> --goal "..."` — create run if a multi-task run is needed.
3. `agenthub task create` or `agenthub apply -f tasks.yaml` for each task with `--run <run-id>` and dependency info.
4. Monitor with `agenthub run status --id <run-id>` and room timeline events.
5. Synthesize results when all tasks complete.

## Error Handling

- `Error: HTTP 401` — Token expired. Report to human admin.
- `Error: HTTP 404` — Resource not found. Check IDs.
- `Error: HTTP 422` — Validation failed. Read error message and fix params.
- Network errors — Retry up to 3 times with 2s delay.
- Missing runtime base/model/auth/Matrix binding — report the exact blocker in the room; do not choose a default Worker base.

## Runtime Base Rules

- Manager runtime choices: `openclaw`, `qwenpaw`.
- Worker runtime bases: `openclaw`, `qwenpaw`, `copaw`, `claude-code`, `opencode`, `codex`, `gemini`.
- `openclaw` as Manager and `openclaw` as Worker are different role contracts.
- Bridge-managed CLI Workers still use Matrix room timeline, WorkerInstance, RuntimeLease, SOUL/AGENTS, skills, shared task contract, and ArtifactStore.

## Manager Manifest Rule

`kind: Manager` always reconciles the Manager contract workspace and Controller-backed registries. It is contract-only by default. If the manifest explicitly sets `spec.desiredState: running`, `stopped`, or `observed`, Controller also reconciles the resident OpenClaw/QwenPaw provider lifecycle and records the runtime status/health in the result snapshot.

## Member Reconcile Result

Worker create/apply should be understood as five stages:

1. ResolveMemberSpec
2. ApplyWorkspaceAgent
3. ApplyWorkerInstance
4. JoinRooms
5. AnnounceAndObserve

If any stage fails, report the failed stage and exact blocker.
