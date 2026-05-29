# OpenCode 官方文档摘要

整理目的：给 AgentHub 的 OpenCode 适配留一份本地参考，便于后续统一处理 CLI、agents、permissions 和日志事件。

## 主要官方页面

- CLI: https://opencode.ai/docs/cli/
- Agents: https://opencode.ai/docs/agents/
- Permissions: https://opencode.ai/docs/permissions/

## 对 AgentHub 最有用的几点

### CLI

- OpenCode CLI 有全局参数 `--help`、`--version`、`--print-logs`、`--log-level`、`--pure`。
- 环境变量里有 `OPENCODE_PERMISSION`、`OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR`、`OPENCODE_DISABLE_DEFAULT_PLUGINS`、`OPENCODE_DISABLE_CLAUDE_CODE*` 等。
- 这说明 OpenCode 本身就支持比较强的配置化和权限配置，不应把 stderr 直接等同于错误。

### Agents

- Agent 可以用 Markdown 或 JSON 配置。
- 支持 `mode: subagent`。
- 支持 `permission` 配置，按能力细粒度控制，如 `bash`、`edit`、`webfetch`。
- 官方示例里有 build / plan / review / docs 这类通用 agent 形态。

### Permissions

- 权限匹配是模式化的，不只是单一命令名。
- 例如 `grep *` 和 `git status *` 这类带参数命令要单独放行。
- `allow / ask / deny` 是核心语义。
- 这对我们做 OpenCode 适配时很重要，因为“有输出”不等于“有错误”。

## 对我们当前适配的直接结论

- OpenCode 的 stderr 需要按“进度 / 事件 / 真错误”再分层，不能直接染红。
- 运行中的消息要尽早带上 `agentName` / `agentId`，否则头像和名称会晚显示。
- 过程日志应保留为事件流，不要只看工具、命令、文件三项统计。

## 参考链接

- CLI: https://opencode.ai/docs/cli/
- Agents: https://opencode.ai/docs/agents/
- Permissions: https://opencode.ai/docs/permissions/
