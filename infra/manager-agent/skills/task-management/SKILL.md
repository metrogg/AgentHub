---
name: task-management
description: Use when you need to create runs, assign tasks to workers, or manage task lifecycle.
---

# Task Management

Turn user goals into visible task room assignments via the `agenthub` CLI.

## Commands

```bash
# Read the current Controller operation schema before assigning work.
agenthub schema

# Create a run
agenthub run create --workspace <workspace-id> --goal "Build a website"

# Create and assign a task
agenthub task create --workspace <workspace-id> --title "Build UI" --assign-to <agent-id> --spec "## Goal\n..."

# Apply a declarative Task manifest through Controller assignment
agenthub apply -f task.yaml

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

## Task Manifest

Use a manifest when the task contract must be reviewed, repeated, or handed to another Manager runtime.

```yaml
kind: Task
metadata:
  name: build-ui
spec:
  workspaceId: <workspace-id>
  runId: <run-id>
  title: Build UI
  assignToAgentId: <workspace-agent-id>
  taskSpec: |
    ## Goal
    Build the requested UI change.

    ## Inputs
    - Read the room timeline.
    - Read shared task artifacts from the referenced task directories.

    ## Output
    - Write result.md.
    - Register artifacts through the shared task contract.
```

## Rules

- Do not force ordinary conversation into a task.
- When work is needed, create a run and assign tasks through the controller.
- Each task gets its own task room where the Worker executes.
- Clarification requests happen in the task room, not hidden tables.
- Controller assignment creates the task room and sends the first Matrix @mention. Do not send a duplicate manual @mention unless it is a follow-up after assignment.
- Task state comes from `workspace_tasks`, `task_threads`, `runtime_leases`, artifacts, and Matrix timeline. Do not infer completion from a friendly chat reply alone.

## Decision Pattern

1. `agenthub schema` to confirm Task assignment/apply fields.
2. Analyze the user goal to determine if task execution is needed.
3. If yes, create a run: `agenthub run create --workspace <id> --goal "..."`
4. Create tasks with dependencies: `agenthub task create --workspace <id> --run <run-id> --title "..." --assign-to <agent-id>` or `agenthub apply -f task.yaml`.
5. Monitor progress through `agenthub run status --id <run-id>` and the task room timeline.
6. Synthesize results only when tasks/artifacts show completion.
