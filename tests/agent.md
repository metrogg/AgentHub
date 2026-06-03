# agent.md

Scope: `tests`

Role: Bun test suite covering orchestration, runtime, API routes, UI utilities, and regressions.

Guidelines:
- Read the repository root `AGENTS.md` before editing here.
- Keep changes inside this directory aligned with the owning layer and do not reintroduce legacy multi-agent shortcuts or duplicated session trees.
- Prefer existing local patterns and narrow, testable changes over broad rewrites.

Verification: Run the touched test file directly with `bun test <file>` before broadening scope.
