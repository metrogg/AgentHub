---
name: human-management
description: Use when managing human users — creating accounts, setting permissions, managing access to teams and workers.
---

# Human Management

Manage human user accounts and their access to the AgentHub platform.

## Commands

```bash
# Create a human user
agenthub human create --workspace <id> --name <username> --display-name "John Doe" --email john@example.com

# List all human users
agenthub human list --workspace <id>

# Delete a human user
agenthub human delete --name <username> --workspace <id>
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

1. Read the room timeline and determine what human action or permission change is needed.
2. Ask for approval in the relevant Matrix room before sensitive changes.
3. Apply the human account, room invite, or permission update through Controller APIs.
4. Announce the result in the room.
5. Treat human clarification and approval messages as authoritative task context.
