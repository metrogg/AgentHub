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
2. **Runtime type**: Is it a code-agent (codex, claude-code, opencode, gemini)?
3. **Current state**: Is the worker idle, busy, or sleeping?
4. **Model**: Is the worker's model suitable for the task complexity?

## Rules

- Always prefer existing suitable workers before creating new ones.
- If no suitable worker exists, propose creating one to the human admin.
- Sleeping workers can be woken: `agenthub worker wake --id <id>`.
