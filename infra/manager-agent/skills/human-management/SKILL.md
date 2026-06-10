---
name: human-management
description: Use when managing human users — creating accounts, setting permissions, managing access to teams and workers.
---

# Human Management

Manage human user accounts and their access to the AgentHub platform.

## Commands

```bash
# Read the current Controller operation schema before changing human access.
agenthub schema

# Create a human user
agenthub human create --name <username> --display-name "John Doe" --email john@example.com --permission-level 1

# Apply a declarative Human manifest
agenthub apply -f human.yaml

# Request approval in the current Matrix room before applying sensitive manifests
agenthub apply -f human.yaml --approval-mode request --room <room-id> --reason "Human permission change"

# Confirm or deny a Controller approval request after the human answered in the room
agenthub approval confirm --event <approval-timeline-event-id> --approved-by <human-id> --reason "Human approved in room"
agenthub approval deny --event <approval-timeline-event-id> --denied-by <human-id> --reason "Human denied in room"

# List all human users
agenthub human list

# Delete a human user
agenthub human delete --name <username>
```

## Human Manifest

```yaml
kind: Human
metadata:
  name: admin-user
spec:
  displayName: Admin User
  email: admin@example.test
  permissionLevel: 1
```

## Permission Levels

- **Admin (Level 1)**: Full access — can manage workers, teams, and platform settings.
- **Team (Level 2)**: Can interact with assigned teams and their workers.
- **Worker (Level 3)**: Can observe and interact with assigned workers only.

## Rules

- Human users are first-class collaborators, not just observers.
- New human users should be announced in the relevant room.
- Permission changes take effect immediately.
- Human DM access to the Manager is controlled by the DM allowlist in openclaw.json.

## Decision Pattern

1. `agenthub schema` to inspect `humans.create` and approval metadata.
2. Read the room timeline and determine what human action or permission change is needed.
3. For sensitive changes, write a Room-native approval request with `agenthub apply -f <manifest> --approval-mode request --room <room-id>` instead of applying immediately.
4. When the human approves or denies, resolve the request with `agenthub approval confirm` or `agenthub approval deny`.
5. Apply the human account, room invite, or permission update through Controller APIs only after confirmation when required.
6. Announce the result in the room.
7. Treat human clarification and approval messages as authoritative task context.
