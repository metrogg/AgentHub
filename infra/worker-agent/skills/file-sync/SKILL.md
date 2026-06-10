---
name: file-sync
description: Sync files with shared storage. Use when your coordinator or another Worker notifies you of file updates (config changes, task files, shared data, collaboration artifacts).
---

# File Sync

When your coordinator or another Worker notifies you that files have been updated in shared storage (e.g., config changes, task briefs, shared data, collaboration artifacts), check the shared storage path for updates.

**Shared storage root:** configured via `AGENTHUB_SHARED_STORAGE_ROOT` environment variable, typically at:
```
{userDataRoot}/storage/objects/
```

**Task files:** `shared/tasks/{task-id}/`

**When to use**: any time you are told that new files are available, configs have changed, or another agent has written something you need to read.

Always confirm to the sender after sync completes.
