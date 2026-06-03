# agent.md

Scope: `apps\web\src\pages`

Role: Top-level React route pages and feature screens.

Guidelines:
- Read the repository root `AGENTS.md` before editing here.
- Keep changes inside this directory aligned with the owning layer and do not reintroduce legacy multi-agent shortcuts or duplicated session trees.
- Prefer existing local patterns and narrow, testable changes over broad rewrites.

Verification: Run `bun --filter @agenthub/web typecheck` and targeted Bun tests for touched utilities/components.
