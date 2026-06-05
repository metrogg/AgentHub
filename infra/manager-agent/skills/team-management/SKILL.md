---
name: team-management
description: Use when you need to create, manage, or dissolve teams of workers. Teams group workers under a leader for complex multi-worker projects.
---

# Team Management

Manage teams — groups of Workers coordinated by a Team Leader.

## Commands

```bash
# Create a team with a leader and workers
agenthub team create --workspace <id> --name <team-name> --leader-name <leader> --workers w1,w2,w3

# List all teams
agenthub team list --workspace <id>

# Get team details
agenthub team get --name <team-name> --workspace <id>

# Update team (add/remove workers, change leader model)
agenthub team update --name <team-name> --workspace <id> --workers w1,w2,w3,w4

# Delete a team
agenthub team delete --name <team-name> --workspace <id>
```

## Rules

- Prefer teams over individual workers for complex multi-step tasks.
- The Team Leader handles internal coordination — you communicate with the Leader, not the team's Workers directly.
- When creating a team, ensure the leader has appropriate skills for the project domain.
- Team workers share a project context but have individual task assignments.

## Decision Pattern

1. Analyze the goal: does it need multiple specialized workers?
2. If yes, create a team: `agenthub team create --workspace <id> --name <team> --leader-name <leader> --workers w1,w2`
3. Assign the high-level task to the Team Leader.
4. Monitor progress via `agenthub team get --name <team>`.
5. Dissolve the team when the project completes.
