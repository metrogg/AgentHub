# agent.md

Scope: `apps\desktop\src-tauri\src`

Role: Tauri Rust commands, desktop runtime glue, and native bridge logic.

Guidelines:
- Read the repository root `AGENTS.md` before editing here.
- Keep changes inside this directory aligned with the owning layer and do not reintroduce legacy multi-agent shortcuts or duplicated session trees.
- Prefer existing local patterns and narrow, testable changes over broad rewrites.

Verification: Run desktop dev/build checks when touching Tauri commands or sidecar scripts.
