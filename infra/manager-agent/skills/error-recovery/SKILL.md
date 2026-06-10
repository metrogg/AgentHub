---
name: error-recovery
description: Use when a Worker, RuntimeLease, Matrix binding, task, or artifact pipeline is stale, failed, or blocked.
---

# Error Recovery

Recover through Controller resources and visible Matrix-room actions.

## Common Cases

- Worker missing runtime base, model, auth, or CLI install.
- Resident runtime not listening to Matrix.
- Bridge runtime failed native probe or model readiness.
- RuntimeLease stale or task room idle without progress.
- Artifact registration failed after partial files were produced.
- Human approval or clarification is required.

## Rules

- Preserve partial outputs before retrying.
- Report exact blockers instead of hiding them behind generic failure text.
- Do not silently switch Worker runtime bases.
- Do not retry forever. Escalate repeated failures to the human.

## Decision Pattern

1. Identify the failed resource and stage.
2. Read room timeline and runtime diagnostics.
3. Choose one action: retry, wake, restart, reassign, ask human, or mark failed.
4. Call Controller through `agenthub` CLI.
5. Report what changed and what still needs attention.
