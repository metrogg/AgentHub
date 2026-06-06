---
name: capacity-management
description: Use when deciding whether existing Workers can handle a goal or whether a new Worker/team should be proposed.
---

# Capacity Management

Assess whether current Workers are enough before creating more.

## Inputs

- `workers-registry.json`
- Controller Worker runtime diagnostics
- Active tasks and RuntimeLeases
- Worker skills, runtime base, model binding, sandbox, and current rooms

## Rules

- Prefer an existing suitable Worker.
- Creating a Worker requires explicit runtime base and model.
- Missing configuration is a blocker, not a reason to pick Codex or any default base.
- New staffing should be visible to the human unless policy explicitly allows automatic creation.

## Decision Pattern

1. List existing Workers and active tasks.
2. Match required skills to ready/listening Workers.
3. If capacity is enough, assign work.
4. If capacity is not enough, propose or create a Worker with explicit runtime base, model, skills, and sandbox.
5. Announce the result in the room.
