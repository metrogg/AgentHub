# Claude Code 官方资料速查

本目录保存了 Claude Code 官方文档的本地副本，便于后续做兼容适配。

## 已下载页面

- [CLI Reference](./cli-reference.html)
- [Headless Mode](./headless.html)
- [Permissions](./permissions.html)
- [Settings](./settings.html)
- [Agent View](./agent-view.html)
- [Worktrees](./worktrees.html)

## 对接要点

- Headless 建议用 `--output-format stream-json` 做流式解析。
- 需要部分消息时，配合 `--verbose` 和 `--include-partial-messages`。
- `--permission-mode` 是关键开关，常见值包括 `default`、`acceptEdits`、`plan`、`auto`、`dontAsk`、`bypassPermissions`。
- `acceptEdits` 适合普通写入型工作流。
- `plan` 适合只读或预览型工作流。
- `bypassPermissions` 适合显式高权限场景，不应作为默认值。
- `--settings` 和 `--add-dir` 都可以直接用于本地配置注入。

## 当前项目映射

- `read-only` Agent 默认映射到 `plan`。
- `workspace-write` 默认映射到 `acceptEdits`。
- `danger-full-access` 只有在明确配置时才会走 `bypassPermissions`。
- 解析层以 `stream-json` 为主，不再把 Claude 的正常事件误判为错误输出。
