---
name: artifact-management
description: Use when inspecting, registering, summarizing, or handing off task artifacts.
---

# Artifact Management

Artifacts are delivery evidence, not chat decoration.

## Sources

- Shared task directory: `shared/tasks/{taskId}/artifacts/`
- `result.md`
- ArtifactStore records
- Matrix file events and `mxc://` media refs

## Rules

- Push or register artifacts before claiming completion.
- Preserve partial artifacts when execution fails.
- Use stable shared-storage refs in room summaries.
- Do not ask downstream Workers to read files that are not in the shared task contract or explicit artifact refs.

## Decision Pattern

1. Read task spec and expected outputs.
2. Verify artifact refs exist.
3. If missing, ask the Worker to publish or register them.
4. Summarize artifacts in the room with task id and stable path/ref.
