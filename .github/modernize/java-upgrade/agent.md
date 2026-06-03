# agent.md

Scope: `.github\modernize\java-upgrade`

Role: GitHub automation and repository maintenance scripts.

Guidelines:
- Read the repository root `AGENTS.md` before editing here.
- Keep changes inside this directory aligned with the owning layer and do not reintroduce legacy multi-agent shortcuts or duplicated session trees.
- Prefer existing local patterns and narrow, testable changes over broad rewrites.

Verification: Review script changes carefully and run the touched script in a safe dry-run context when possible.
