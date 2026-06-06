# Manager Tools Quick Reference

## Skills Overview

| Skill | When to Use | Key Tools |
|-------|-------------|-----------|
| agenthub-controller | Call the Controller action surface | `agenthub ...` |
| worker-management | Create, list, wake, stop workers | `agenthub worker ...` |
| task-management | Create runs, assign tasks, check status | `agenthub task ...`, `agenthub run ...` |
| channel-management | Manage rooms, messages, participants, @mentions | Matrix channel, `agenthub room ...` |
| file-sync-management | Inspect task refs and artifact visibility | `agenthub artifact ...` when available |
| review-and-synthesis | Final review after evidence exists | Room timeline + artifacts |
| heartbeat | Patrol runtime health and room bindings | `agenthub heartbeat ...` |
| project-management | Apply Controller manifests | `agenthub schema`, `agenthub apply -f ...` |

## Cross-Skill Combos

| Scenario | Skill Chain |
|----------|-------------|
| User gives a complex task | task-management (create run) → worker-management (check workers) → channel-management (announce) |
| Worker fails | heartbeat → error-recovery → task-management (retry or cancel) → worker-management (check status) |
| User asks a simple question | Just reply directly (no skill needed) |
| Create a team | team-management → worker-management (create workers) → channel-management (invite/announce) |
| Need capacity | capacity-management → worker-management → channel-management |

## AgentHub Controller API

Use `AGENTHUB_CONTROLLER_URL` and `AGENTHUB_MANAGER_TOKEN`. Do not hard-code localhost ports; local, Docker, and future remote modes differ.

Prefer the bundled `agenthub` CLI. It wraps Controller actions and returns JSON. Start with `agenthub schema` to inspect the current operation contract, then use `agenthub apply -f ...` or the smallest specific command. Read `skills/agenthub-controller/SKILL.md` for concrete commands.

Controller owns:

- Matrix identities and room membership.
- WorkspaceAgent / WorkerInstance resources.
- RuntimeLease lifecycle.
- Task and Run status.
- Shared task contracts and artifacts.
- Manager/Worker contract generation.

Manager owns:

- Intent understanding.
- Skill selection.
- Visible coordination and final synthesis.

Worker owns:

- Execution inside its room/task contract.
- Progress, clarification, result, and artifact reporting.

## Mandatory Rules

1. Use the `agenthub` CLI or Controller API — never try to edit database files directly.
2. Always @mention workers when assigning tasks.
3. Push artifacts before notifying downstream workers.
4. Register every task in the orchestrator before executing.
5. Report only when there are issues — stay quiet if everything is normal.
6. Use concise Chinese for all visible messages unless the room context asks otherwise.
7. A Worker create action must include an explicit runtime base and model, or report a blocker.
8. OpenClaw can be Manager or Worker; do not mix their contracts.
9. Bridge Workers must still communicate through Matrix timeline and shared task contracts.
