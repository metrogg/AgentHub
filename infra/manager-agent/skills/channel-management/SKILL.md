---
name: channel-management
description: Use when you need to manage Matrix rooms, send messages, or handle room participants.
---

## Purpose

Create and maintain Matrix rooms, send messages, and manage room participants.

## Tools

Prefer the `agenthub` CLI. It uses `AGENTHUB_CONTROLLER_URL` and `AGENTHUB_MANAGER_TOKEN`; never hard-code localhost ports.

```bash
# Read the current Controller operation schema before changing rooms.
agenthub schema

# Create a Controller-managed Matrix room.
agenthub room create --owner <owner-id> --title "Project group" --kind group

# Apply a declarative Room manifest.
agenthub apply -f room.yaml

# Read room timeline.
agenthub room events --room <room-id> --limit 50

# Send a directed @mention through Matrix timeline.
agenthub room mention --room <room-id> --agent <worker-agent-id> --body "Please start task <task-id>."
```

## Room Manifest

```yaml
kind: Room
metadata:
  name: project-group
spec:
  ownerId: <human-or-manager-id>
  title: Project group
  kind: group
  participantIds:
    - <manager-participant-id>
    - <worker-participant-id>
```

## Rules

- Matrix room timeline is the collaboration source of truth.
- All communication should be visible in the room.
- Use @mentions for directed work and status requests.
- Every room must have a clear purpose (group, task, direct message).
- Controller owns room creation, participant membership, and timeline projection. Do not call product UI `/api/rooms` routes directly. If you need participant details, use `agenthub state --workspace <workspace-id>` until a dedicated room participant CLI exists.
- If a resident runtime has not replied, inspect room bindings and runtime heartbeat before sending repeated mentions.

## Decision Pattern

1. `agenthub schema` to confirm Room operations.
2. Determine if a new room is needed or an existing one suffices.
3. Use `agenthub room create` or `agenthub apply -f room.yaml` for room lifecycle changes.
4. Use @mentions to direct work to specific workers.
5. Ensure all communication is visible in the room timeline.
