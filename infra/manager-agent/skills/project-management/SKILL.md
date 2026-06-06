---
name: project-management
description: Use when managing multi-worker projects with phases, dependencies, and shared deliverables.
---

# Project Management

Coordinate multi-worker projects with structured phases and task dependencies.

## Project Structure

```
shared/projects/{project-id}/
├── meta.json       # Project metadata (status, team, phases)
├── plan.md         # Project plan with task assignments and dependencies
└── results/        # Collected deliverables
```

## Workflow

1. **Define the project**: Create a project plan with phases and task dependencies.
2. **Assign workers**: Map tasks to workers based on capabilities.
3. **Track progress**: Monitor via `agenthub run status --id <run-id>`.
4. **Coordinate phases**: Workers in later phases wait for dependency tasks to complete.
5. **Collect results**: Gather deliverables from each worker's task directory.

## Commands

```bash
# Read the current Controller operation schema before applying project resources.
agenthub schema

# Create a project run
agenthub run create --workspace <id> --goal "Project: <description>"

# Create tasks with dependencies
agenthub task create --workspace <id> --run <run-id> --title "Phase 1: Design" --assign-to <designer>
agenthub task create --workspace <id> --run <run-id> --title "Phase 2: Build" --assign-to <builder>

# Apply Worker / Room / Task manifests when a project needs auditable setup
agenthub apply -f project-workers.yaml
agenthub apply -f project-rooms.yaml
agenthub apply -f project-tasks.yaml

# Monitor project progress
agenthub run status --id <run-id>
```

## Rules

- Break complex goals into phases with clear dependencies.
- Each phase should produce concrete artifacts.
- Workers in later phases should read artifacts from earlier phases via shared storage.
- Report project completion to the human admin with a synthesis of all deliverables.
- Use Controller manifests for planned project setup. Do not hand-wire rooms, workers, or tasks by calling product UI routes.

## Decision Pattern

1. `agenthub schema` to confirm current Worker / Room / Task capabilities.
2. Read the Matrix room timeline and current workers-registry.json.
3. Decide whether this is truly a multi-worker project or a simple reply/task.
4. Create a visible run and apply Worker / Room / Task manifests through Controller APIs.
5. Let Controller-created task rooms perform the initial @mention assignment.
6. Monitor artifacts and synthesize only after deliverables exist.
