# AgentHub

> 一个本地优先的 AI 工作台，用聊天、房间、任务和产物来协调多个真实 Coding Agent。

[![状态](https://img.shields.io/badge/status-alpha-orange)](#路线图)
[![运行时](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)
[![前端](https://img.shields.io/badge/frontend-React%20%2B%20Vite-61dafb)](https://vite.dev)
[![许可证](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md) · [安全策略](SECURITY.md) · [项目文档](docs/)

AgentHub 正在从 IM 式多 Agent 协作原型，演进为一个接近 Coze / Kimi 风格的开源 AI 工作平台。产品外壳保持 AgentHub 自己的聊天式工作区体验，底层方向是轻量版 HiClaw open kernel：Matrix Room 作为协作事实源，Manager 常驻运行，Worker 真实执行，产物进入共享存储。

它的目标不是“一个模型假装多人协作”，而是下面这条真实链路：

1. 用户从群聊或 Agent 私聊发起目标。
2. Manager / Orchestrator 理解目标，并决定回复、追问、补员、派活或总结。
3. Worker 在自己的房间和工作目录里真实执行。
4. 主群聊展示进度、汇报、产物和最终综合结果。
5. 用户可以进入任务子对话查看完整执行过程。

## 主要特性

- **聊天式工作区**：Agent 私聊、项目群聊、任务子对话。
- **常驻 Manager Runtime**：OpenClaw Manager 是当前主要协调器路径。
- **Matrix-first 通信层**：Room、timeline、participant、mention 是内部协作事实源。
- **真实 Coding Worker**：OpenClaw resident Worker，以及 Codex CLI、Claude Code、OpenCode、Gemini CLI bridge。
- **任务与产物可见**：任务房间、运行状态、进度事件、生成文件、预览和 artifact 记录。
- **本地优先存储**：默认使用本地 filesystem SharedStorage，并按 S3-compatible object key 语义设计。
- **Controller Plane**：Manager skills 和后续 CLI/API 通过统一控制面操作真实资源。
- **开发体验简单**：Bun、Hono、React、Vite、Drizzle、SQLite，Docker Compose 启动本地 Matrix / MinIO。

## 当前状态

AgentHub 仍处于 alpha 快速开发阶段。API、数据库 schema、runtime contract、workspace/storage 格式都还会调整。旧会话、旧任务、旧数据库行和旧 workspace 数据不是当前架构约束，必要时可以清库重建。

适合用来探索：

- 本地优先多 Coding Agent 协作，
- Matrix-backed Agent Room，
- OpenClaw 风格常驻 Manager / Worker，
- 任务子对话和产物交接，
- Coze 风格 AI 工作台的开源产品壳。

## 架构概览

```text
Human
  -> AgentHub Web
  -> AgentHub Server / Controller API
  -> RoomService + Matrix adapter
  -> Matrix homeserver / Tuwunel
  -> OpenClaw Manager
  -> Controller Plane
  -> Worker runtime / task room
  -> ArtifactStore / SharedStorage
  -> UI projections
```

### 分层

| 层 | 职责 |
| --- | --- |
| 产品外壳 | 群聊、私聊、任务子对话、任务看板、产物卡 |
| 编排层 | Manager / Orchestrator、controller actions、run、任务分配、最终复盘 |
| 通信层 | Matrix Room、timeline、participant、mention、file event |
| 协议投影层 | AG-UI 和从 Room/resource event 到前端 UI 的投影 |
| 执行层 | OpenClaw Manager、OpenClaw resident Worker、Codex CLI、Claude Code、OpenCode、Gemini CLI |
| 能力层 | MCP、Skills、Rules、shell、文件、浏览器、模型网关 |
| 存储层 | SQLite 资源索引、本地文件对象存储、可选 MinIO/S3-compatible adapter |

## 目录结构

```text
apps/
  server/       Hono/Bun API、Room、Manager runtime、Worker runtime、Controller Plane
  web/          React/Vite Web 应用
  desktop/      Tauri 桌面壳
  Android/      Android 实验
packages/
  db/           Drizzle schema、migration、SQLite 访问
  shared/       共享 schema、常量和类型
infra/
  docker-compose.hiclaw-lite.yml
  openclaw-runtime/
docs/           产品、架构、迁移文档
tests/          bun:test 集成测试和投影测试
scripts/        开发进程脚本
```

## 快速开始

### 前置依赖

- [Bun](https://bun.sh) >= 1.1.0
- Node.js 可从 PATH 调用
- 推荐安装 Docker Desktop，用于本地 Matrix / MinIO
- 可选本地 Agent CLI：Codex CLI、Claude Code、OpenCode、Gemini CLI

### 安装

```bash
bun install
```

### 配置

```bash
cp .env.example .env
```

至少检查：

- `DATABASE_URL`
- `LLM_PROVIDER`、`LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`
- `AGENTHUB_ROOM_PROVIDER=matrix`
- `AGENTHUB_MATRIX_HOMESERVER_URL`
- `AGENTHUB_MATRIX_SERVER_NAME`
- `AGENTHUB_MATRIX_REGISTRATION_TOKEN`

### 启动本地基础设施

```bash
bun run infra:up
```

这会启动 `infra/docker-compose.hiclaw-lite.yml` 中定义的本地基础设施，包括 Matrix 使用的 Tuwunel 和用于 S3-compatible 存储实验的 MinIO。

### 启动 AgentHub

```bash
bun run dev
```

开发脚本会：

- 执行数据库迁移，
- 启动 server，
- 从 `5644-5700` 自动选择可用 web 端口，
- 把真实 server 端口写入 `.agenthub-port`，
- 在配置允许时自动启动 resident Manager。

通常打开：

```text
http://127.0.0.1:5644/
```

## 常用命令

```bash
bun run dev              # server + web
bun run dev:stop         # 停止旧 AgentHub dev 进程
bun run dev:server       # 只启动 server
bun run dev:web          # 只启动 web
bun run dev:desktop      # 启动桌面壳

bun run infra:up         # 启动 Tuwunel + MinIO
bun run infra:down       # 停止本地基础设施
bun run infra:logs       # 查看基础设施日志

bun run typecheck        # 全仓类型检查
bun --filter @agenthub/server typecheck
bun --filter @agenthub/web typecheck
bun test                 # 运行测试
```

## Runtime 模型

### Manager

OpenClaw Manager 是当前 Manager / Team Leader 的主要 runtime。AgentHub 会在本地用户数据目录下生成 Manager contract，并同步 OpenClaw config、skills、registries、rooms、state 和 heartbeat 文件。

Manager 模型选择顺序：

1. 显式 Manager runtime 环境变量覆盖；
2. `Manager / Team Leader` Agent 绑定的模型；
3. 内部默认模型或当前启用模型。

如果模型来自模型目录，AgentHub 会先解析成供应商真实 `modelId`，再写入 `openclaw.json`。

### Worker

Worker 可以是：

- OpenClaw resident Worker；
- Codex CLI bridge；
- Claude Code bridge；
- OpenCode bridge；
- Gemini CLI bridge。

Worker 会收到 Room 上下文、任务契约、隔离 workdir、RuntimeLease、sandbox 环境变量和 shared storage 引用。

## 配置说明

重要环境变量：

| 变量 | 用途 |
| --- | --- |
| `PORT` | Server 端口，默认 `8000` |
| `DATABASE_URL` | SQLite 数据库路径 |
| `AGENTHUB_ROOM_PROVIDER` | 产品/开发路径应使用 `matrix` |
| `AGENTHUB_MATRIX_HOMESERVER_URL` | Matrix homeserver URL |
| `AGENTHUB_MATRIX_SERVER_NAME` | Matrix server name，通常是 `agenthub.local` |
| `AGENTHUB_OBJECT_STORE_PROVIDER` | 本地 filesystem 或 S3-compatible object storage |
| `AGENTHUB_CONTAINER_RUNTIME` | 设置为 `docker` 时启用 Docker-backed Manager / Worker |
| `AGENTHUB_MANAGER_BACKEND` | 覆盖 Manager backend |
| `AGENTHUB_WORKER_BACKEND` | 覆盖 Worker backend |
| `AGENTHUB_CODE_AGENT_TIMEOUT_MS` | Code Agent 执行超时 |
| `AGENTHUB_SANDBOX_PROVIDER` | `local-workdir` 或可选 Docker sandbox |

完整列表见 `.env.example`。

## 文档

入口文档：

- [AGENTS.md](AGENTS.md)：AI Coding Agent 的权威工程说明。
- [docs/](docs/)：产品、架构和迁移文档。
- [infra/](infra/)：本地 Matrix / MinIO / OpenClaw runtime 基础设施。
- [SECURITY.md](SECURITY.md)：漏洞报告和本地安全边界说明。

部分历史文档可能包含已废弃的 DAG-first、模板优先或本地伪通信路径。若有冲突，以 `AGENTS.md`、本 README 和当前代码为准。

## 路线图

近期：

- 稳定 Matrix room 投影和 runtime 诊断；
- 改进 Manager / Worker 生命周期恢复；
- 强化 ArtifactStore 和 shared storage；
- 优化任务子对话、运行历史和产物资产库；
- 改进模型/runtime 配置体验。

中期：

- Space / Task Center / Asset Center / Expert Center；
- Eval / Trace 页面；
- 长运行 Coding / Deploy 工作流；
- 更完整的 resident Worker 支持；
- 可选 MinIO/S3 生产 adapter。

长期：

- 成为一个 Coze 风格的开源 AI 工作台，服务本地和团队托管的 Coding Agent 协作。

## 贡献

仓库仍在快速变化。修改 runtime、room、task 或 artifact 行为前：

1. 阅读 `AGENTS.md`。
2. 确认自己正在修改哪一层。
3. 优先使用 Room timeline 和资源状态，不要恢复旧 message cache 主路径。
4. 保持 Manager / Worker runtime 边界清晰。
5. 为投影、生命周期和失败可见性添加聚焦测试。

建议检查：

```bash
bun run typecheck
bun test
```

## 安全

不要提交密钥、模型 key、Matrix access token、本地 CLI auth 文件、生成的 workspace 或 runtime 日志。漏洞报告和本地安全假设见 [SECURITY.md](SECURITY.md)。

## 许可证

AgentHub 使用 [MIT License](LICENSE)。
