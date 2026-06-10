---
name: hiclaw-find-worker
description: Use when discovering available workers or checking if a suitable worker exists for a task.
---

# Find Worker

Discover and inspect available Workers for task assignment.

## Commands

```bash
# List all workers in a workspace
agenthub worker list --workspace <id>

# Get specific worker details
agenthub worker get <name> --workspace <id>

# Check worker runtime status
agenthub worker status --id <worker-id>
```

## Selection Criteria

When finding a worker for a task, consider:
1. **Capability tags**: Does the worker have relevant skills?
2. **Worker runtime base**: Is it openclaw, opencode, claude-code, codex, or gemini?
3. **Current state**: Is the worker idle, busy, or sleeping?
4. **Model**: Is the worker's model suitable for the task complexity?

## Rules

- Always prefer existing suitable workers before creating new ones.
- If no suitable worker exists, propose creating one to the human admin.
- Sleeping workers can be woken: `agenthub worker wake --id <id>`.

## Decision Pattern

1. Read workers-registry.json and the current room/task context.
2. Match capability tags, runtime base, model binding, skills, and current state.
3. Prefer a ready/listening Worker already in the room.
4. If no suitable Worker exists, propose an explicit member spec to the human.
5. Never silently create a Worker with a guessed runtime or model.
