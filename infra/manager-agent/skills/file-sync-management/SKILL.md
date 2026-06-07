---
name: file-sync-management
description: Use when managing shared task files and artifact storage. Coordinate file handoffs between workers via shared storage.
---

# File Sync Management

Manage shared task files and artifact references between Workers.

## Shared Storage Layout

```
shared/tasks/{task-id}/
├── spec.md       # Task specification (you write this)
├── plan.md       # Execution plan (Worker writes this)
├── result.md     # Final result (Worker writes this)
└── progress/     # Daily progress logs (Worker writes this)
```

## Workflow

1. Write `spec.md` before creating a task.
2. Worker reads `spec.md`, creates `plan.md`, executes, writes `result.md`.
3. Downstream Workers read `result.md` from dependency tasks.

## Rules

- Shared storage refs are canonical; local files are mirrors.
- Workers must publish final results under `shared/tasks/{task-id}/`.
- Never ask downstream workers to guess relative paths — always use explicit object refs.
- `spec.md` is read-only for Workers — only the Manager writes it.

## Decision Pattern

1. Identify the task id and shared task directory.
2. Ensure spec.md, plan.md, result.md, and artifacts/ refs are explicit.
3. Use Controller/ArtifactStore APIs to register deliverables.
4. Share object refs in the Matrix room instead of ambiguous local paths.
5. Verify downstream Workers can read the referenced artifacts.
