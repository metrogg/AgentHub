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
3. Ask for approval in the relevant Matrix room before sensitive changes.
4. Apply the human account, room invite, or permission update through Controller APIs.
5. Announce the result in the room.
6. Treat human clarification and approval messages as authoritative task context.
