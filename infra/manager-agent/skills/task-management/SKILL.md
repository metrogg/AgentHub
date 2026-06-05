---
name: task-management
description: Use when you need to create runs, assign tasks to workers, or manage task lifecycle.
---

# Task Management

Turn user goals into visible task room assignments via the `agenthub` CLI.

## Commands

```bash
# Create a run
agenthub run create --workspace <workspace-id> --goal "Build a website"

# Create and assign a task
agenthub task create --workspace <workspace-id> --title "Build UI" --assign-to <agent-id> --spec "## Goal\n..."

# List tasks in a run
agenthub task list --run <run-id>

# Check task status
agenthub task status --id <task-id>

# Retry a failed task
agenthub task retry --id <task-id>

# Cancel a run
agenthub run cancel --id <run-id> --reason "User requested cancellation"

# Get workspace state
agenthub state --workspace <workspace-id>

# Read room timeline
agenthub room events --room <room-id> --limit 20
```

## Rules

- Do not force ordinary conversation into a task.
- When work is needed, create a run and assign tasks through the controller.
- Each task gets its own task room where the Worker executes.
- Clarification requests happen in the task room, not hidden tables.

## Decision Pattern

1. Analyze the user goal to determine if task execution is needed.
2. If yes, create a run: `agenthub run create --workspace <id> --goal "..."`
3. Create tasks with dependencies: `agenthub task create --workspace <id> --run <run-id> --title "..." --assign-to <agent-id>`
4. Monitor progress: `agenthub run status --id <run-id>`
5. Synthesize results when all tasks complete.
