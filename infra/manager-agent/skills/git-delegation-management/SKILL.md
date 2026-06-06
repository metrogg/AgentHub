---
name: git-delegation-management
description: Use when delegating git operations to Workers — commits, branches, PRs. The Manager does not execute git directly.
---

# Git Delegation Management

Delegate git operations to Workers. The Manager coordinates; Workers execute.

## Delegation Pattern

1. Identify which Worker should handle the git operation.
2. Assign a task with clear git instructions in the spec.
3. Worker executes git commands in their workspace.
4. Worker reports results back via task completion.

## Common Delegations

- **Commit**: Ask Worker to commit changes with a specific message.
- **Branch**: Ask Worker to create/switch branches.
- **PR**: Ask Worker to create a pull request (if GitHub/GitLab integration is available).

## Rules

- Never execute git commands directly — always delegate to a Worker.
- Include clear commit messages and branch names in the task spec.
- Workers should set their git user.name to their worker name for traceability.

## Decision Pattern

1. Identify whether git work is really needed and which Worker owns the workspace.
2. Create a task contract with branch, commit, PR, or review instructions.
3. @mention the Worker in the task room.
4. Wait for the Worker to report command output, changed files, and errors.
5. Summarize the git result to the human without pretending the Manager ran the commands.
