# agent.md

Scope: `apps\web\public`

Role: Web public assets that are served directly by Vite.

Guidelines:
- Read the repository root `AGENTS.md` before editing here.
- Keep changes inside this directory aligned with the owning layer and do not reintroduce legacy multi-agent shortcuts or duplicated session trees.
- Prefer existing local patterns and narrow, testable changes over broad rewrites.

Verification: Run `bun --filter @agenthub/web typecheck` and targeted Bun tests for touched utilities/components.
