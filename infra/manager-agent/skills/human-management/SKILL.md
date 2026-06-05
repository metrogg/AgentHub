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
