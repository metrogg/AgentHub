# Claude Code 流式 Runtime 核心设计

## 目标

本文沉淀一套可迁移到 AgentHub 的 Claude Code 适配与流式输出设计。核心目标不是复刻 Claude Code 终端 UI，而是把 Code Agent 的执行过程翻译成 AgentHub 可持久化、可恢复、可在 Android 渲染的统一事件流。

设计原则：

- Runtime 只产出事实事件，不产出 UI 组件。
- 前端按事件协议派生展示文案、图标、折叠状态和详情面板。
- 流式文本以稳定 ID 做快照 upsert，避免弱网、重连、批量 flush 导致重复消息。
- 工具调用、计划确认、最终回复、错误和用户审批进入同一条 timeline。
- Android 只消费 REST 快照与 WebSocket 增量，不直接运行 Claude Code。

## 总体架构

```text
Android
  ├─ REST 拉取会话 / timeline 快照
  └─ WebSocket 订阅 timeline 增量

AgentHub Server
  ├─ RuntimeRegistry
  ├─ CodeAgentRuntime
  │   └─ ClaudeCodeRunner 子进程 / SDK bridge
  ├─ TimelineStore
  └─ WebSocket broadcaster

Claude Code Runtime
  ├─ Claude Agent SDK / CLI
  ├─ tool permission bridge
  ├─ stream_event dispatcher
  └─ NDJSON / internal event output
```

推荐分层：

- `CodeAgentRuntime`：统一封装 Codex / Claude Code / OpenCode 等代码 Agent。
- `ClaudeCodeRunner`：只负责启动 Claude、读取流式事件、转换成内部事件。
- `TimelineStore`：负责 upsert、排序、快照查询。
- `TimelineDisplay`：前端或共享包里的纯函数，从事实事件派生展示语义。

## 统一 Timeline 事件

Claude Code 的原始消息、工具调用、流式 delta 不应直接暴露给客户端。Server 应先归一化为统一事件：

```ts
type TimelineEvent = {
  id: string
  sessionId: string
  messageId?: string
  turnId: string
  runtime: 'claude-code' | 'codex' | 'opencode' | 'llm'
  kind:
    | 'message'
    | 'reasoning'
    | 'command'
    | 'file_read'
    | 'file_change'
    | 'search'
    | 'todo_list'
    | 'subagent'
    | 'plan'
    | 'approval'
    | 'tool'
    | 'error'
    | 'turn'
  status:
    | 'pending'
    | 'started'
    | 'running'
    | 'success'
    | 'error'
    | 'cancelled'
    | 'requires_action'
  title: string
  summary?: string
  payload: Record<string, unknown>
  turnSeq: number
  intraTurnOrder: number
  createdAt: number
  updatedAt: number
}
```

关键约定：

- `id` 必须稳定。流式 token 到达时更新同一个事件，而不是插入新事件。
- `turnSeq + intraTurnOrder` 是最终排序依据，不能只按时间戳排序。
- `payload` 存事实字段，例如 `command`、`path`、`content`、`output`、`toolName`。
- 不持久化 display 文案、CSS class、组件名。展示语义由客户端现算。

## Claude Code 适配边界

Claude Code Runtime 应做四类适配。

### 1. 系统上下文适配

Claude Agent SDK 默认能力接近 Claude Code，但 Server 仍应显式传入：

- 工作目录 `cwd`
- 模型 `model`
- 恢复会话 ID `resumeSessionId`
- 权限模式 `permission`
- 平台 / Shell 说明

Windows 场景需要特别说明：Claude Code 的 Bash 工具通常走 Git Bash，不识别 PowerShell cmdlet。否则模型可能把 `Get-ChildItem`、`Select-Object` 发进 Bash 导致失败。

### 2. 权限适配

推荐三档：

- `readonly`：读文件、搜索、查看任务允许；写文件、执行命令、未知工具拒绝。
- `ask`：高风险工具通过移动端或 Web 端审批。
- `full`：跳过普通审批，但仍保留审计事件。

工具审批不要只停留在 UI 层。Runtime 的 `canUseTool` / permission hook 必须是实际门禁。

### 3. 工具事件适配

Claude 工具名应映射到 AgentHub 协议：

| Claude 工具 | Timeline kind | 关键 payload |
| --- | --- | --- |
| `Bash` | `command` | `command`, `description`, `output` |
| `Read` | `file_read` | `path`, `offset`, `limit` |
| `Edit` / `MultiEdit` / `Write` | `file_change` | `path`, `editCount`, `subkind` |
| `Glob` / `Grep` / `WebSearch` | `search` | `query`, `path`, `glob` |
| `WebFetch` | `tool` 或 `web_fetch` | `url`, `output` |
| `TodoWrite` | `todo_list` | `items` |
| `Task` | `subagent` | `agentType`, `description`, `prompt` |
| `ExitPlanMode` | `plan` | `plan`, `approved`, `revisionRequest` |

工具开始时写 `started/running`，工具结果到达时用同一个 `id` upsert 为 `success/error`。如果 turn 结束时仍有未完成工具，需要 sweep 成终态，避免 UI 永远卡在运行中。

### 4. 用户提问适配

Claude Code 内部如果需要向用户确认，可以封装一个内部工具，例如 `ask_user_question`：

```ts
type AskUserSpec = {
  title: string
  source: 'Claude'
  questions: Array<{
    id: string
    header: string
    question: string
    mode: 'confirm' | 'single' | 'multi'
    options?: Array<{ id: string; label: string; description?: string }>
  }>
}
```

Server 发出 `approval` 或 `ask_user` timeline 事件，并通过 WebSocket 通知 Android 展示确认卡。用户回答后，Server 将结果写回 Runtime stdin / SDK hook。

## 流式文本设计

Claude 的流式事件可能不是逐 token 到达，而是 1 到 2 秒批量 flush。直接转发会造成 Android 上“块状刷新”。推荐在 Runner 层做 text pacer。

### Block 级 sourceId

每个 assistant `text` content block 分配一个单调递增 `blockKey`：

```text
sourceId = `${sessionId}:text:${blockKey}`
timelineId = `${taskId}:${turnId}:${sourceId}`
```

不要直接使用 SDK 的 content block index。多个 LLM turn 内 index 往往都会从 0 开始，直接使用会覆盖前一轮文本。

### 流式 upsert 流程

```text
content_block_start(text)
  -> 立即 emit 空 running message，占住 intraTurnOrder

content_block_delta(text_delta)
  -> 累积到 buffer
  -> pacer 每 33ms 提交一段累计快照
  -> 同 id upsert payload.content

content_block_stop
  -> 立即 flush 剩余文本
  -> emit success message
  -> UI 停止流式光标
```

空 running message 很重要。它让短开场白先占住 timeline 顺序，避免因为 pacer 延迟，被后续工具调用插到前面。

### Pacer 策略

推荐参数：

- `intervalMs = 33`，约 30 FPS。
- 每 tick 取当前 buffer 的 `ceil(length / 6)`。
- block 结束时 `finishImmediate()`，不要让最终文本被节流器延迟。

伪代码：

```ts
function push(delta: string) {
  buffer += delta
  ensureTimer()
}

function tick() {
  const take = Math.max(1, Math.ceil(buffer.length / 6))
  committed += buffer.slice(0, take)
  buffer = buffer.slice(take)
  emitSnapshot(committed)
}

function finishImmediate() {
  committed += buffer
  buffer = ''
  emitSnapshot(committed)
}
```

Server 到客户端之间还可以有一个轻量 throttle，例如 16ms 一次；终态事件必须立即发出。

## Reasoning / Thinking 设计

Claude 的 thinking 与最终回复应分开：

- `text` block 进入 `message`，作为最终回复展示。
- `thinking` / `redacted_thinking` 进入 `reasoning`，默认可隐藏或折叠。
- `tool_use` 的 partial JSON 不要误归类为文本。

Reasoning 可以持久化用于调试和恢复，但移动端默认不必展示。Android 可以只显示一个轻量状态：“思考中...”，等最终回复或工具节点出现后自然收起。

## 计划确认

Claude Code 的 `ExitPlanMode` 可映射为 `plan` 事件。

流程：

1. Claude 调用 `ExitPlanMode`。
2. Runtime 生成 `kind: "plan"`、`status: "requires_action"`。
3. Android / Web 展示计划卡片和确认按钮。
4. 用户选择：
   - 同意：Runtime 将权限恢复到执行模式，允许 Claude 继续。
   - 取消：Runtime deny，并中断当前 turn。
   - 要求修改：Runtime deny，但返回修改要求，让 Claude 在同一轮重新生成计划。

计划正文只在 timeline 的 `plan.payload.plan` 中出现。审批浮层只引用标题和动作，不复制长正文。

## 持久化与排序

Timeline 表建议拆出 turn 排序键：

```sql
CREATE TABLE timeline_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  turn_seq INTEGER NOT NULL,
  intra_turn_order INTEGER NOT NULL
);

CREATE INDEX idx_timeline_session_turn
  ON timeline_events(session_id, turn_seq, intra_turn_order);
```

插入规则：

- 首次见到某个 `turnId`，分配 `turnSeq = max(turnSeq) + 1`。
- 同一 turn 内首次插入某个事件，分配 `intraTurnOrder = max(intraTurnOrder) + 1`。
- 同一个 `id` upsert 时保留原 `turnSeq`、`intraTurnOrder`、`createdAt`，只更新状态、摘要、payload、updatedAt。

这样流式文本每帧都会更新内容，但位置不会跳动。

## Android 渲染建议

Android 使用 `LazyColumn` 渲染 timeline。不同 `kind` 映射为不同 item：

- `message + role=user`：右侧用户气泡。
- `message + role=assistant`：最终回复 Markdown 卡片。
- `command/file/search/tool`：过程节点，默认单行，可展开。
- `plan`：计划确认卡片，正文可滚动。
- `approval/ask_user`：底部或内联确认卡。
- `error`：错误卡。

流式回复的 Compose 状态：

```kotlin
data class TimelineItemUiState(
  val id: String,
  val kind: String,
  val status: String,
  val content: String,
  val streaming: Boolean,
)
```

判断 streaming：

```kotlin
val streaming =
  item.kind == "message" &&
  item.payload["role"] == "assistant" &&
  item.status in setOf("pending", "started", "running")
```

样式建议：

- 最终回复不必做重边框气泡，使用正文卡片或无框 Markdown 区域。
- streaming 时在 Markdown 末尾显示窄色块光标，使用 alpha 闪烁动画。
- 过程节点标题弱化，运行中节点使用主色，失败节点使用错误色。
- turn 完成后，可把工具过程折叠到最终回复下，移动端默认只显示摘要。

## REST + WebSocket 同步

Android 不应只依赖 WebSocket。

冷启动：

```text
GET /api/sessions
GET /api/sessions/:id/timeline
CONNECT /ws
session:join
```

运行中：

```text
WebSocket timeline:event
  -> 按 id upsert 本地内存状态
  -> LazyColumn 局部重组
```

断线重连：

```text
GET /api/sessions/:id/timeline?afterUpdatedAt=lastSeen
重新 join WebSocket
```

如果后续加入 Room 缓存，Room 也应按 `id` upsert，而不是追加 token 行。

## 最小落地路径

Milestone 1：

- Server 新增 `CodeAgentRuntime` 的统一输出协议。
- Claude Code Runner 先支持 message、command、file_read、file_change、error、turn。
- Android 支持 timeline 快照、WebSocket upsert、assistant 流式光标。

Milestone 2：

- 接入工具审批和只读门禁。
- Android 增加 approval card。
- Server 为高风险工具记录审计事件。

Milestone 3：

- 接入 `plan` 事件和计划确认。
- 工具过程折叠到最终回复下。
- 增加断线后的 timeline 增量补偿。

Milestone 4：

- 接入 reasoning 调试视图。
- 支持多 runtime 并行任务的 timeline 分组。
- 增加外网 relay 与移动端通知摘要。

## 关键取舍

- 选择 timeline 快照 upsert，而不是 token append：牺牲少量网络冗余，换来恢复简单、排序稳定、Android 状态管理轻。
- 选择事实事件 + display 派生，而不是持久化展示字段：后续 UI 文案和样式可迭代，历史数据不需要迁移。
- 选择 block 级流式，而不是 turn 级单消息：工具调用与文本可以按真实发生顺序交错展示。
- 选择 Server 端权限门禁，而不是只做移动端确认：移动端掉线或被绕过时，Runtime 仍有实际安全边界。
