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
# Create a project run
agenthub run create --workspace <id> --goal "Project: <description>"

# Create tasks with dependencies
agenthub task create --workspace <id> --run <run-id> --title "Phase 1: Design" --assign-to <designer>
agenthub task create --workspace <id> --run <run-id> --title "Phase 2: Build" --assign-to <builder>

# Monitor project progress
agenthub run status --id <run-id>
```

## Rules

- Break complex goals into phases with clear dependencies.
- Each phase should produce concrete artifacts.
- Workers in later phases should read artifacts from earlier phases via shared storage.
- Report project completion to the human admin with a synthesis of all deliverables.
