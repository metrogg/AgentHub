# agent.md

Scope: `apps\Android\app\src\main\java\com\agenthub\mobile`

Role: Android Kotlin source package tree.

Guidelines:
- Read the repository root `AGENTS.md` before editing here.
- Keep changes inside this directory aligned with the owning layer and do not reintroduce legacy multi-agent shortcuts or duplicated session trees.
- Prefer existing local patterns and narrow, testable changes over broad rewrites.

Verification: Run Android/Gradle checks when available, and keep mobile API contracts aligned with server models.
