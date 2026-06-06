---
name: review-and-synthesis
description: Use when assigned work has produced visible results and the Manager must verify evidence, synthesize outcomes, and report final delivery.
---

# Review And Synthesis

Review Worker outputs before telling the human a task is complete.

## Inputs

- Room timeline messages from the group room and task rooms.
- `shared/tasks/{taskId}/spec.md`
- `shared/tasks/{taskId}/result.md`
- ArtifactStore entries and shared task `artifacts/`.
- Worker failure, clarification, and partial-output messages.

## Rules

- Do not synthesize before evidence exists.
- Do not hide failed or partial tasks.
- Prefer concise Chinese visible summaries.
- Link or name artifact refs, changed files, and task rooms when useful.

## Decision Pattern

1. Read the original human goal and latest Manager assignments.
2. Read each task result and artifact ref.
3. Check whether acceptance criteria were met.
4. If complete, report final outcome with deliverables and residual risks.
5. If incomplete, explain blockers and propose the smallest recovery action.
