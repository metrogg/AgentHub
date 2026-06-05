# AgentHub x HiClaw x ClawTeam 三方对比分析报告

最后更新：2026-06-05

参考范围：

- AgentHub 当前代码库与权威文档：`AGENTS.md`、`README.md`、`docs/当前状态与下一步路线.md`、`docs/AgentHub-HiClaw-lite开源内核重构方案.md`
- HiClaw：`docs/hiclaw-wiki.agent.final.md`、本地 `hiclaw源码参考/`
- ClawTeam：本地 `clawteam源码/ClawTeam/`，重点阅读 `README.md`、`docs/transport-architecture.md`、`clawteam/team/*`、`clawteam/spawn/*`、`clawteam/workspace/*`、`clawteam/harness/*`、`clawteam/board/*`

本文目的不是给三者排名，而是回答 AgentHub 接下来怎么取舍：HiClaw 是企业级透明协作上限，ClawTeam 是轻量 CLI/swarm 落地样板，AgentHub 要走中间路线：保留自己的 Coze/Kimi 风格产品壳，用 HiClaw 的 Room/Manager/Worker/HITL 思想做内核，用 ClawTeam 的轻量实现方法降低落地成本。

## 一句话判断

| 项目 | 一句话定位 | 最值得 AgentHub 学的点 | 不宜照搬的点 |
| --- | --- | --- | --- |
| HiClaw | 企业级 Matrix-native 多 Agent 平台 | Manager/Worker/Room/HITL/SharedStorage/Controller 的完整范式 | K8s、Higress、MinIO、企业多租户等重部署栈不适合作为第一阶段默认 |
| ClawTeam | 极轻量 CLI Agent swarm 工具 | 文件系统任务板、inbox、git worktree、CLI adapter、profile doctor、LeaderWatcher | 文件通信不能替代 AgentHub 已确定的真实 Matrix 主通信层；固定模板只能作参考资产 |
| AgentHub | Web-first 开源 AI 工作台 + HiClaw-lite 内核 | 自研 UI、Coding Agent 组合配置、Room timeline 投影、Controller Plane | 旧 Planner/DAG-first、旧 messages 状态源、直接 service dispatch 还要继续下线 |

核心结论：

- 通信层继续以真实 Matrix 为主，不回到 ClawTeam 的文件 inbox 作为内部主通信。
- Worker 执行层可以大量学习 ClawTeam，因为 AgentHub 和 ClawTeam 都重度依赖 Claude Code / Codex / OpenCode / Gemini / OpenClaw 这类外部 CLI Agent。
- 控制面、Human-in-the-loop、透明审计继续学 HiClaw，因为 ClawTeam 在权限、审计、身份和企业安全上明显更轻。
- 工作区隔离、任务 store 原子性、profile/adapter、watcher、成本追踪、看板快照这几块，ClawTeam 比 HiClaw 更适合 AgentHub 第一阶段落地。

## 总体架构对比

| 维度 | HiClaw | ClawTeam | AgentHub 当前 | AgentHub 应取舍 |
| --- | --- | --- | --- | --- |
| 产品形态 | Matrix/Element + 容器平台 | CLI + tmux/subprocess + 简易 Web 看板 | React Web IM/工作台 + Bun Server | 保留 AgentHub UI，不采用 Element 或纯 CLI |
| 部署方式 | 多容器/企业级基础设施 | `pip install`，默认无服务端 | Bun 单进程 + SQLite + 可选 Tuwunel/MinIO | 第一阶段保持单进程，真实 Matrix 用 Tuwunel |
| 通信事实源 | Matrix Room timeline | 文件 inbox + event log，可选 ZMQ/Redis wakeup | 真实 Matrix Room timeline + SQLite 投影 | 坚持 Matrix，不把 file transport 当主通信 |
| Manager | OpenClaw/QwenPaw runtime + SOUL/skills/state | Leader agent + CLI 命令 + LeaderWatcher | ManagerRuntime 正在接 OpenClaw/QwenPaw，仍有过渡层 | Manager 必须变成真实 runtime + skills，不再是一次性 Planner |
| Worker | 常驻 Worker runtime，Matrix 监听接单 | CLI Agent 子进程，tmux/subprocess，文件 inbox | CLI WorkerRuntime + Matrix mention-first，仍有 service dispatch | 学 ClawTeam adapter/spawn/worktree，目标转 resident worker |
| 任务模型 | Manager skill 操作任务和团队资源 | `TaskStore` 文件任务，锁、依赖、owner、状态 | SQLite `workspace_tasks` + task room + RuntimeLease | 保留 DB 控制面，补任务 claim/锁/超时 |
| 共享存储 | MinIO/S3 object store | 本地共享文件系统 | filesystem-first ArtifactStore，S3-compatible 语义 | 默认本地 object store，保留 S3 adapter |
| 工作区隔离 | 容器/远端运行环境 | Git worktree + 分支 + checkpoint/merge | `.agenthub/workdirs` + Worker dir | 强烈学习 ClawTeam git worktree/冲突检测 |
| 配置模型 | CRD/YAML + runtime config | `config.json` + profile/preset + env priority | 设置页 + DB + env + Agent 配置 | 学 ClawTeam profile doctor/test，保留 AgentHub 三层配置 |
| 运行可视化 | Matrix timeline 天然可审计 | board serve + SSE + tmux attach + event log | Room timeline + TaskBoard + WS | UI 继续 AgentHub，后台快照/事件可学 ClawTeam |
| 安全 | Gateway/consumer token 模式 | 本地 CLI 直接持凭证 | 当前仍偏 env/DB 注入，TokenVault 未完成 | 长期学 HiClaw Gateway，短期至少密钥隔离/脱敏 |

## ClawTeam 源码中真正值得学的模块

### 1. `MailboxManager + Transport`

源码位置：

- `clawteam/team/mailbox.py`
- `clawteam/transport/base.py`
- `clawteam/transport/file.py`
- `clawteam/transport/p2p.py`
- `docs/transport-architecture.md`

ClawTeam 的通信层很轻：上层只调用 `send / receive / peek / count / broadcast`，底层可以是 `FileTransport` 或 `P2PTransport`。文件模式用 `tmp + rename` 原子写入 inbox，同时写一份不可消费的 event log。

AgentHub 不应该照搬它作为主通信，因为我们已经明确真实 Matrix 是协作事实源。但可以学习三点：

- Room timeline 写入也要强调 append-only、原子性和幂等去重。
- Worker 可以有“本地待处理 inbox/lease queue”概念，但它只是 Matrix listener 的本地执行队列，不是通信事实源。
- 事件日志和收件箱分离很清楚：timeline 是审计，inbox/queue 是执行消费，这个区分值得引入到 AgentHub 的 WorkerRuntime。

### 2. `FileTaskStore`

源码位置：

- `clawteam/store/file.py`
- `clawteam/team/models.py`

ClawTeam 的任务模型很小但扎实：每个任务一个 JSON 文件，字段包括 `status / priority / owner / lockedBy / blocks / blockedBy / metadata`，写入有 OS 级文件锁，`in_progress` 会 acquire lock，死 Agent 可以 release stale locks。

AgentHub 当前任务状态更丰富，但“接单原子性”和“锁语义”反而不够硬。应学习：

- Worker claim task 时必须有原子 claim/lock。
- `lockedBy / lockedAt` 或等价字段应该进入 `workspace_tasks` 或 `RuntimeLease`。
- stale lock recovery 不应该散在各处，应由 Controller/Reconciler 统一做。

### 3. `WorkspaceManager`

源码位置：

- `clawteam/workspace/manager.py`
- `clawteam/workspace/conflicts.py`
- `clawteam/workspace/git.py`

ClawTeam 每个 Agent 一个 git worktree，分支形如 `clawteam/{team}/{agent}`，支持 checkpoint、cleanup、merge，并有冲突检测。这个比 AgentHub 当前普通 workdir 隔离更成熟，因为 Git 天生提供 diff、冲突和可回滚。

AgentHub 应采用“默认轻量 local-workdir，项目代码任务可升级到 git worktree”的双策略：

- 无 Git 仓库或临时任务：继续用 worker workdir。
- 用户选择真实项目仓库：优先每个 Worker 一个 git worktree。
- 产物合并不由 Worker 自行写主分支，而由 Manager review/merge action 或人类确认触发。

### 4. `NativeCliAdapter + profile`

源码位置：

- `clawteam/spawn/adapters.py`
- `clawteam/spawn/profiles.py`
- `clawteam/config.py`

ClawTeam 的 CLI adapter 做得很务实：识别 `claude/codex/gemini/kimi/qwen/opencode/openclaw/nanobot`，按不同 CLI 拼接 `--model`、`--message`、`--session`、`--yolo`、workspace 参数和 env。profile 层负责 `agent / command / model / base_url / api_key_env / env_map / args`。

AgentHub 已经有模型管理、Agent Bases、Agent 配置三层，但可以学习 ClawTeam 的两点：

- Agent 配置页应有“组合 profile/health doctor”：这个 agent 使用哪个 base、哪个模型、哪些 env、能否启动。
- code-agent-adapter 应尽量像 ClawTeam adapter 一样分成“命令构造 / env 注入 / session 续接 / 权限参数”几个纯函数，减少平台分支互相污染。

### 5. `LeaderWatcher`

源码位置：

- `clawteam/team/leader_watcher.py`

LeaderWatcher 的设计很适合 AgentHub 的 ManagerPatrol：它收集任务、leader inbox、dead agents，生成 snapshot signature。只有状态变化或 heartbeat 到期才给 Leader 注入提醒，避免无意义轮询轰炸。

AgentHub 应学习：

- ManagerPatrol 不要每轮都“规划”，而是先做 snapshot diff。
- 触发条件应是 task 状态变化、Worker 死亡、用户新消息、artifact 到达、依赖解除、heartbeat 到期。
- 注入给 Manager 的内容应是 evidence + recommended next action，而不是硬编码 plan。

### 6. `Harness`

源码位置：

- `clawteam/harness/orchestrator.py`
- `clawteam/harness/phases.py`
- `clawteam/harness/roles.py`

ClawTeam Harness 把复杂协作抽象成 phases：`discuss -> plan -> execute -> verify -> ship`，每个 phase 有 gate，例如 artifact required、all tasks complete、human approval。它不是实时协作内核，但很适合作为 AgentHub 的“协作契约/质量门”参考。

AgentHub 应采用：

- Spec/Contract 不是固定场景模板，而是用户显式创建的质量门。
- `spec.md / plan.md / result.md / approval-*.json` 可以成为 task/run artifact。
- Human approval gate 要进入 Room timeline 和 Controller 状态，不做前端本地按钮假状态。

### 7. `Board`

源码位置：

- `clawteam/board/server.py`
- `clawteam/board/collector.py`

ClawTeam 的看板很轻：collector 读文件状态，HTTP server 提供 overview/team API，SSE 定时推送 team snapshot。AgentHub 已经有 React/WS，不需要照搬 Flask，但可以学习“服务端 snapshot 是 UI 恢复事实”的方式。

AgentHub 应继续把 TaskBoard、Agent tabs、Artifact cards 从 Room timeline + Controller resource snapshot 投影出来，而不是前端自己拼。

## HiClaw 仍然更强的地方

| 维度 | HiClaw 强点 | ClawTeam 不足 | AgentHub 方向 |
| --- | --- | --- | --- |
| 透明协作 | Matrix Room 中所有 Agent/Human 交流可审计 | 文件 inbox 更像消息队列，不是自然 IM | 坚持真实 Matrix timeline |
| Human-in-the-loop | Human 是一等参与者，可进入任意 Room 干预 | 人更像 CLI 操作者 | 人类消息进入 Room timeline，并驱动 Manager/Worker resume |
| 身份与权限 | Matrix identity + channel policy + OpenHuman | 基本无细粒度权限 | 引入 Human/Team/Room 权限模型 |
| Runtime 原生性 | OpenClaw/QwenPaw/Hermes/OpenHuman | 外部 CLI 拼接为主 | Manager 优先 OpenClaw/QwenPaw，Worker 保留 CLI agent |
| 共享存储 | MinIO/S3 object refs，适合跨节点 | 文件系统共享依赖本机/SSHFS | 本地 filesystem-first，保持 S3-compatible |
| 凭证隔离 | Higress consumer token / Gateway | 外部 Agent 直接持 key | 短期 TokenVault，长期 Gateway |
| Controller/Reconciler | 声明式资源控制面 | CLI 操作文件状态 | 轻量 Controller Plane + durable ReconcileQueue |

HiClaw 是目标范式，不是第一阶段部署方式。AgentHub 应继续对齐它的抽象，而不是搬它的企业基础设施。

## AgentHub 当前位置

AgentHub 已经比早期 Planner-first 走远很多：

- `OrchestratorEngine`、`TaskExecutionService`、`LocalA2ATransport` 已删除。
- 通信主路径已经转向真实 Matrix Room timeline，`TestRoomAdapter` 只用于自动化测试。
- `RoomService / MatrixRoomAdapter / MatrixRuntimeListener / MatrixRoomEventDispatcher` 已形成基础通信闭环。
- `RunController / RoomController / WorkerController / RuntimeLeaseController` 已拆成资源控制入口。
- `Controller Plane` 第一版已有 `ControllerApi / ReconcileQueue / WorkerBackend` seam。
- WorkerRuntime 已能在 task room 写入 started/heartbeat/progress/clarification/artifact/result。
- 前端已开始从 Room timeline + WS 投影任务看板、子对话和产物卡。

但和 HiClaw / ClawTeam 对比后，AgentHub 还差这些关键闭环：

- Manager 还没有完全变成“真实常驻 Agent runtime + skills + state + worker registry”。
- Worker 还没有完全 resident 化，仍有 service dispatch 过渡。
- Matrix listener 还缺 typing、presence、read receipt、durable supervisor、TokenVault。
- Worker claim/lock、任务超时、重试、并发限制还不够硬。
- Git worktree 隔离、冲突检测、merge/review workflow 还没形成。
- Profile/doctor/test 这类用户可理解的组合诊断还不够。
- 成本追踪、运行快照、轻量看板恢复还不完整。

## AgentHub 应该怎么吸收 ClawTeam

### 立即吸收

1. **Worker claim lock**
   - 在 WorkerRuntime 接单前做原子 claim。
   - 绑定 `taskId + workerInstanceId + leaseId`。
   - busy/dead/stale 时可被 Controller 释放。

2. **ManagerPatrol snapshot signature**
   - 不再无脑 step。
   - 对 tasks、runtime leases、worker heartbeats、room unread、artifact arrival 做 signature。
   - 只有变化或 heartbeat 到期才注入 Manager runtime。

3. **CLI adapter 拆分**
   - 把 code-agent-adapter 拆成 profile resolution、env injection、command builder、session resume、permission flags。
   - 每个 CLI 的差异隔离在 adapter 内。

4. **Profile/doctor/test**
   - 设置页和 Agent 配置页提供组合诊断。
   - 输入：agent base、model、env、workspace、Matrix identity、sandbox/workdir。
   - 输出：installed/auth/model/env/session/sandbox/Matrix ready。

5. **服务端 snapshot for UI**
   - TaskBoard 不只吃零散 WS event。
   - 提供 run/team/session snapshot，刷新后可完整恢复。

### 短期吸收

1. **Git worktree workspace mode**
   - 对真实项目仓库启用 per-worker branch。
   - Manager review 后合并。
   - 引入冲突检测和 changed files summary。

2. **CostStore**
   - 按 run/task/worker/model/provider/base 聚合 token、duration、estimated cost。
   - 前端在任务卡、Agent tab、最终汇总展示。

3. **Harness gates**
   - Spec/Contract 显式质量门。
   - Plan approval、artifact required、all tasks complete、human approval 进入 Room/Controller。

4. **Agent session capture**
   - 学 ClawTeam 的 session locator/capture 思路。
   - 对 Claude Code / Codex / OpenCode session 做可恢复、可定位、可审计。

### 不吸收或仅作参考

- 不把 ClawTeam FileTransport 当 AgentHub 内部主通信。
- 不恢复固定 team templates 作为自动执行入口。
- 不把 Leader 强制等同于 Manager；AgentHub Manager 要走 OpenClaw/QwenPaw/skills/runtime。
- 不把所有状态退回文件系统；AgentHub 仍需要 SQLite/Controller resource state。
- 不把纯 CLI 看板替代 AgentHub Web UI。

## 路线建议

### P0：补轻量但关键的执行可靠性

| 任务 | 学习来源 | 说明 |
| --- | --- | --- |
| Worker claim/lock | ClawTeam `FileTaskStore` | 避免重复接单和并发 Worker 踩同一任务 |
| ManagerPatrol snapshot diff | ClawTeam `LeaderWatcher` | 让 Manager 像团队负责人被有意义地唤醒 |
| Matrix ready hard check | HiClaw / 当前 AgentHub 口径 | 不允许假通信层继续存在 |
| CLI adapter 拆分 | ClawTeam `NativeCliAdapter` | 降低 Claude/Codex/OpenCode/OpenClaw 适配混线 |
| Room snapshot API | ClawTeam Board + HiClaw resource view | 刷新后稳定恢复任务、子对话、产物 |

### P1：把 AgentHub 的轻量内核跑顺

| 任务 | 学习来源 | 说明 |
| --- | --- | --- |
| Manager SOUL/skills/state/registry | HiClaw | Manager 不再只是服务端函数 |
| Resident WorkerRuntime | HiClaw + ClawTeam watcher | Worker 通过 Matrix listener 接单，service dispatch 退场 |
| Git worktree mode | ClawTeam `WorkspaceManager` | 项目代码任务默认更安全 |
| Profile doctor/test | ClawTeam profile | 用户能理解 agent base x model x skill x workspace 是否可运行 |
| CostStore | ClawTeam costs | 让多 Agent 协作可评估 |

### P2：补企业级抽象但不默认重部署

| 任务 | 学习来源 | 说明 |
| --- | --- | --- |
| TokenVault / Gateway adapter | HiClaw Higress 思想 | 不让 Worker 到处拿真实 key |
| Team / Human / Permission resource | HiClaw | Human 成为一等参与者 |
| MinIO/S3 adapter 完整化 | HiClaw MinIO | 本地 filesystem 保持默认，S3 可切 |
| Durable ReconcileQueue | HiClaw Controller | 服务重启后不丢任务生命周期 |
| Typing/read receipt/presence | HiClaw Matrix | 提升 IM 可信度 |

## 最终取舍

AgentHub 不应该变成“轻量 ClawTeam Web 版”，也不应该直接变成“HiClaw 企业栈复刻”。最合理的位置是：

```text
产品体验：AgentHub 自己做 Coze/Kimi 风格 Web 工作台
协作范式：学习 HiClaw 的 Room / Manager / Worker / Human / Storage
轻量落地：学习 ClawTeam 的 CLI adapter / worktree / task lock / watcher / profile / board snapshot
通信事实源：真实 Matrix，不回退到本地假 adapter
执行基底：Claude Code / Codex / OpenCode / Gemini / OpenClaw 等外部 Agent runtime
控制面：SQLite + Controller Plane 起步，后续再升级 durable reconciler / gateway / S3
```

一句话：HiClaw 告诉我们“正确的多 Agent 平台应该长什么样”，ClawTeam 告诉我们“怎么用很少基础设施先把它跑起来”，AgentHub 要把这两者合到自己的 Web 产品壳里。
