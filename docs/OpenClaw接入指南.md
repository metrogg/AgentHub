# OpenClaw 接入指南

最后更新：2026-06-04

## 什么是 OpenClaw

OpenClaw 是 HiClaw 生态中的 Agent 运行时框架，基于 Node.js。它提供：
- Matrix 集成（sync loop，消息收发，E2EE）
- 工具系统（exec = bash，MCP = 外部工具）
- 技能加载（SKILL.md + scripts/ 目录）
- 会话管理（上下文窗口，历史裁剪）
- 网关模式（接收消息 → LLM 推理 → 工具调用 → 回复）

HiClaw 的 Manager 和 Worker 都是 OpenClaw 实例，只是配置不同。

## AgentHub 接入架构

```text
┌─────────────────────────────────────────────────┐
│  AgentHub Server (Bun/TypeScript)                │
│  ├── Tuwunel (Matrix homeserver, 端口 6167)     │
│  ├── Controller API (Run/Task/Room/Worker/Lease) │
│  ├── RoomService (timeline 投影)                 │
│  ├── ArtifactStore (文件系统)                     │
│  └── 前端 (React UI)                             │
└─────────────────────────────────────────────────┘
         │                    │
         │ Matrix             │ HTTP (Controller API)
         │                    │
┌────────┴────────┐   ┌──────┴──────┐
│  OpenClaw       │   │  OpenClaw   │
│  Manager        │   │  Worker     │
│  (独立进程)      │   │  (独立进程)  │
│  @manager:local │   │  @worker-x  │
│  SOUL.md        │   │  SOUL.md    │
│  16 skills      │   │  exec skills│
│  exec → curl    │   │  exec → CLI │
└─────────────────┘   └─────────────┘
```

## 三种接入方式

### 方式 A：AgentHub 自带 OpenClaw（推荐新手）

AgentHub 自动克隆、构建、配置 OpenClaw。

```bash
# 1. 安装 OpenClaw
bash infra/setup-openclaw.sh

# 2. 启动 Tuwunel
docker compose -f infra/docker-compose.hiclaw-lite.yml up -d tuwunel

# 3. 启动 AgentHub
bun run dev:server

# 4. 启动 Manager
openclaw gateway run --verbose --force
```

### 方式 B：用户已有 OpenClaw，AgentHub 管理启动

用户已有 OpenClaw 安装，AgentHub 生成配置并启动。

```bash
# 告诉 AgentHub OpenClaw 在哪
export OPENCLAW_PATH=/usr/local/bin/openclaw

# 或在代码中：
# launcher.configureFromUserOpenClaw({ openclawPath: '/usr/local/bin/openclaw' })
```

AgentHub 会：
1. 用你的 OpenClaw 二进制
2. 生成 openclaw.json 指向 AgentHub 的 Tuwunel
3. 复制 SOUL.md / AGENTS.md / skills
4. 启动 OpenClaw 连接 Matrix

### 方式 C：用户自己启动 OpenClaw，AgentHub 只连端点

用户自己管理 OpenClaw 生命周期，AgentHub 通过 HTTP 通信。

```bash
# 用户自己启动 OpenClaw（可以用自己的配置）
openclaw gateway run --verbose --force

# 告诉 AgentHub 连哪里
export AGENTHUB_OPENCLAW_MANAGER_ENDPOINT=http://localhost:18799
```

AgentHub 会：
1. 通过 HTTP 调用 OpenClaw gateway API
2. 不管理 OpenClaw 进程生命周期
3. OpenClaw 可以用任意 Matrix homeserver、任意模型配置

### 选择建议

| 场景 | 推荐方式 |
|------|---------|
| 新手，快速体验 | 方式 A |
| 已有 OpenClaw，想让 AgentHub 管理 | 方式 B |
| 已有 OpenClaw 集群，AgentHub 只做编排 | 方式 C |
| 生产环境 | 方式 C（OpenClaw 独立部署） |

## 文件结构

```text
infra/
├── setup-openclaw.sh           # 安装脚本
├── manager-openclaw.json       # Manager 配置模板
├── docker-compose.hiclaw-lite.yml  # Tuwunel + MinIO
└── manager-agent/
    ├── SOUL.md                 # Manager 人格定义
    ├── AGENTS.md               # Manager 行为规则
    ├── HEARTBEAT.md            # 心跳检查清单
    ├── TOOLS.md                # 工具快速参考
    └── skills/
        ├── worker-management/SKILL.md
        ├── task-management/SKILL.md
        └── channel-management/SKILL.md

apps/server/src/services/manager-runtime/
├── types.ts                    # 接口定义
├── skill-loader.ts             # 技能加载器
├── tool-registry.ts            # Controller API 映射
├── local-manager-runtime.ts    # 本地 LLM tool-calling loop（备用）
├── openclaw-launcher.ts        # OpenClaw 进程管理
└── index.ts                    # 统一导出
```

## Manager 如何工作

1. OpenClaw 启动，读取 `openclaw.json`，连接到 Tuwunel Matrix homeserver
2. 用户在群聊中发消息，Matrix sync 推送到 OpenClaw
3. OpenClaw 的 LLM 读取 SOUL.md + AGENTS.md + TOOLS.md，决定做什么
4. 如果需要调用 Controller API，OpenClaw 使用 `exec` tool 运行 `curl` 命令
5. 结果返回给 LLM，LLM 决定下一步或回复用户
6. 回复通过 Matrix 写入 Room

## Worker 运行时

Worker 也可以用 OpenClaw，和 Manager 一样：

```bash
# 生成 Worker 配置并启动
const launcher = new OpenClawLauncher({ matrixUrl, llmBaseUrl, ... })
launcher.launchWorker('builder', { matrixUserId: '@worker-builder:agenthub.local' })
```

Worker 和 Manager 的区别：

| 维度 | Manager | Worker |
|------|---------|--------|
| SOUL.md | 团队负责人人格 | 专业执行者人格 |
| 技能 | worker/task/channel management | 执行技能（coding/file-sync） |
| 工具 | exec → curl Controller API | exec → 写代码/跑命令 |
| 心跳 | 1 小时 | 无 |
| 并发 | maxConcurrent: 8 | maxConcurrent: 4 |
| DM 白名单 | admin | admin + manager |

### Worker 运行时选择

```text
Worker 运行时选择：
├── OpenClaw Worker — 通用任务（调研、分析、文档、协调）
│   ├── infra/worker-agent/SOUL.md
│   ├── infra/worker-agent/AGENTS.md
│   └── infra/worker-openclaw.json
└── Code Agent Worker — 编码任务（Codex/Claude Code/OpenCode/Gemini）
    └── 通过 WorkerRuntimeService.runTaskRoom() 调用 CLI
```

两种 Worker 都通过 Matrix Room 接收任务、汇报进度。选择哪种取决于任务类型。

## 与旧 LocalManagerRuntime 的关系

- `LocalManagerRuntime` 是**备用方案**，在 OpenClaw 不可用时使用
- `OpenClawLauncher` 是**正式方案**，启动真正的 OpenClaw 进程
- 两者的 `ManagerRuntime` 接口相同，可以无缝切换
- 通过 `AGENTHUB_MANAGER_RUNTIME` 环境变量选择

## 当前验收状态

截至 2026-06-04：

- AgentHub 侧 OpenClaw provider / bridge contract 已有自动化端到端测试：`tests/openclaw-bridge-e2e.test.ts`。
- 该测试通过 `AGENTHUB_OPENCLAW_MANAGER_ENDPOINT` 激活 `OpenClawManagerRuntimeProvider`，调用 `POST /step`，并验证返回 `assign` 后能创建 run / task / TaskThread / task room / RuntimeLease；task room assignment 必须是 Matrix mention-first，能回查 Worker participant / WorkerInstance，再继续驱动 WorkerRuntime 写入进度、产物和完成事件。
- 这证明 AgentHub 侧链路已经贯通，但测试里的 OpenClaw endpoint 是 fake bridge。它不能替代真实 OpenClaw 进程现场验收。

真实验收要额外完成：

1. 启动真实 Tuwunel/Synapse/Conduit Matrix homeserver。
2. 启动真实 OpenClaw Manager bridge，并暴露 `GET /health` 与 `POST /step`。
3. 设置 `AGENTHUB_OPENCLAW_MANAGER_ENDPOINT=http://127.0.0.1:<port>`。
4. 在 AgentHub 群聊发送任务，确认链路为：

```text
group room human.message
  -> ManagerRuntimeService
  -> OpenClawManagerRuntimeProvider
  -> POST /step
  -> assign action
  -> task room Matrix mention-first assignment / RuntimeLease
  -> WorkerRuntime
  -> task room timeline + ArtifactStore
```

设置页“控制台”里的 Manager Runtime 卡片只能说明当前 provider、endpoint 和健康检查状态；最终仍要以群聊任务端到端跑通为准。当前 AgentHub 侧是 Matrix mention-first + service dispatch 过渡态，真实 OpenClaw 进程和 resident Worker 通过 Matrix listener 自主接单仍需要现场验收。
