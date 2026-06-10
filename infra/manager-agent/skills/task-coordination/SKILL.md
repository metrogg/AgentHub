---
name: task-coordination
description: Use when coordinating multiple concurrent tasks — tracking processing markers, managing task dependencies, and handling concurrent execution.
---

# Task Coordination

Manage concurrent task execution with dependency tracking and processing markers.

## Processing Markers

When multiple tasks run concurrently, use processing markers to track which tasks are active:

```bash
# Check active tasks in a run
agenthub run status --id <run-id>

# List tasks and their statuses
agenthub task list --run <run-id>
```

## Dependency Management

Tasks can declare dependencies on other tasks. The platform handles dependency resolution:

- Tasks with unmet dependencies are held in `pending` status.
- When a dependency task completes, dependent tasks are automatically released.
- Circular dependencies are detected and rejected at task creation time.

## Rules

- Don't create tasks with circular dependencies.
- Use `--run` to group related tasks under a single orchestration run.
- Monitor blocked tasks via `agenthub run status` and intervene if needed.
- When a dependency task fails, decide whether to retry it or skip dependent tasks.

## Decision Pattern

1. Read the project/run status, task room timeline, and shared task contract.
2. Identify whether the issue is dependency, capacity, clarification, failure, or stale lease.
3. Use Controller APIs to release, retry, pause, cancel, or reassign tasks.
4. Write the coordination decision back to the Matrix room.
5. Ask the human before destructive recovery or scope changes.
