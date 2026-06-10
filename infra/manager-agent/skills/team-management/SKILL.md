---
name: team-management
description: Use when you need to create, manage, or dissolve teams of workers. Teams group workers under a leader for complex multi-worker projects.
---

# Team Management

Manage teams — groups of Workers coordinated by a Team Leader.

## Commands

```bash
# Read the current Controller operation schema before creating Teams.
agenthub schema

# Create a team with a leader and workers
agenthub team create --workspace <id> --name <team-name> --leader-name <leader> --workers w1,w2,w3

# Apply a declarative Team manifest
agenthub apply -f team.yaml

# List all teams
agenthub team list --workspace <id>

# Get team details
agenthub team get --name <team-name> --workspace <id>

# Update team (add/remove workers, change leader model)
agenthub team update --name <team-name> --workspace <id> --workers w1,w2,w3,w4

# Delete a team
agenthub team delete --name <team-name> --workspace <id>
```

## Team Manifest

Team manifests group existing Workers. They do not create missing Workers. Apply Worker manifests first when new members are needed.

```yaml
kind: Team
metadata:
  name: delivery-team
spec:
  workspaceId: <workspace-id>
  leaderName: delivery-lead
  workers:
    - existing-builder
    - existing-reviewer
  description: Coordinates implementation and review.
```

## Rules

- Prefer teams over individual workers for complex multi-step tasks.
- The Team Leader handles internal coordination — you communicate with the Leader, not the team's Workers directly.
- When creating a team, ensure the leader has appropriate skills for the project domain.
- Team workers share a project context but have individual task assignments.
- Team `workers` must refer to existing WorkspaceAgent ids or names. Do not use Team creation to implicitly create missing Workers.
- If a needed worker does not exist, use `worker-management` first with explicit runtime base, model, skills, and sandbox.

## Decision Pattern

1. `agenthub schema` to inspect `teams.create` and `apply.manifest`.
2. Analyze the goal: does it need multiple specialized workers?
3. Confirm required Workers already exist; otherwise create them first through Worker manifests.
4. Create a team with `agenthub team create ...` or `agenthub apply -f team.yaml`.
5. Assign the high-level task to the Team Leader.
6. Monitor progress via `agenthub team get --name <team>`.
7. Dissolve the team when the project completes.
