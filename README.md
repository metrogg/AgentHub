# AgentHub

> 多 Agent 协作平台，本地桌面工作台，字节跳动 AI 全栈挑战赛参赛作品。

AgentHub 是一个 IM 式多 Agent 协作平台。用户可以与单个 Agent 单聊，也可以在工作区群聊中 `@Agent` 或 `@orchestrator`，由 Orchestrator 自动拆解任务、调度多个 Agent、汇总结果，并把代码 diff、文件、网页预览、部署状态等产物内联展示在聊天流中。

项目当前处于快速迭代阶段，核心目标是跑通“本地多 Agent 协作 + 桌面客户端 + 项目工作区 + Code Agent 产物闭环”。

## 核心特性

- **单聊 Direct**：每个 Agent 都是一个聊天对象，支持 LLM、Code Agent、原生工具运行时。
- **群聊 Group**：Workspace 级别 Agent Group，支持 `@Agent名` 指定回复对象。
- **Orchestrator 调度**：自动生成任务 DAG，按依赖层级调度，支持失败降级、结果合成和风险提示。
- **Code Agent 接入**：统一适配 Codex、Claude Code、OpenCode CLI，展示过程日志、命令记录、文件变更和产物卡片。
- **Git 分支隔离**：非 read-only 任务可切出独立分支，提取 diff，并为多 Agent 变更提供冲突检测基础。
- **产物卡片**：支持 diff、preview、file、deploy 等 artifact 数据结构，便于在聊天流中预览和操作。
- **办公室可视化**：Office 页面用于观察工作区中 Agent 的状态、活动和任务流转。
- **Skills 市场**：支持 SkillHub 来源搜索、详情查看、安装，并在输入 `/` 时调出已安装技能。
- **桌面客户端**：基于 Tauri v2，启动时自动拉起本机 server sidecar，并使用 App Data 保存数据库、配置和日志。

## 技术栈

| 层面 | 技术选型 |
| --- | --- |
| 运行时 | Bun >= 1.1.0 |
| Monorepo | Bun workspaces |
| 后端 | Hono + Bun.serve + WebSocket |
| 前端 | React 18 + Vite + Tailwind CSS + Zustand + Radix UI + assistant-ui |
| 数据库 | SQLite + Drizzle ORM |
| LLM | OpenAI-compatible + Anthropic 流式客户端 |
| 桌面端 | Tauri v2 + Rust + Bun compiled sidecar |

## 项目结构

```text
apps/
  web/        React 前端
  server/     Hono API、WebSocket、Agent runner、静态资源托管
  desktop/    Tauri 桌面壳和 sidecar 打包脚本
packages/
  db/         SQLite schema、数据库初始化和迁移
  shared/     共享类型和工具
tests/        冒烟测试
docs/         产品文档、设计记录和比赛材料
```

## 本地开发

安装依赖：

```bash
bun install
```

复制并填写环境变量：

```bash
cp .env.example .env
```

执行数据库迁移：

```bash
bun run db:migrate
```

启动开发服务：

```bash
bun run dev
```

也可以分别启动：

```bash
bun run dev:server
bun run dev:web
```

默认地址：

```text
Server: http://localhost:8000
Web:    http://localhost:5173
```

## 常用命令

```bash
bun run build
bun run typecheck
bun run lint
bun test
bun run db:generate
bun run db:migrate
bun run db:studio
```

## 桌面客户端

桌面端会把 `apps/server` 编译成 sidecar，并把 `apps/web/dist` 复制到 Tauri resources。启动客户端后，Tauri 会：

1. 显示启动页。
2. 创建 App Data、config、logs、data 目录。
3. 自动寻找 `8000-8079` 内可用端口。
4. 启动 `agenthub-server.exe`。
5. 等待 `/health` 就绪。
6. 加载本机 Web UI。

准备 sidecar：

```bash
bun --filter @agenthub/desktop prepare:sidecar
```

桌面开发：

```bash
bun run dev:desktop
```

构建安装包：

```bash
bun run build:desktop
```

构建完成后会生成 MSI 和 NSIS 安装包：

```text
apps/desktop/src-tauri/target/release/bundle/msi/
apps/desktop/src-tauri/target/release/bundle/nsis/
```

桌面端数据路径示例：

```text
C:\Users\<you>\AppData\Roaming\com.agenthub.desktop\data
C:\Users\<you>\AppData\Roaming\com.agenthub.desktop\config
C:\Users\<you>\AppData\Roaming\com.agenthub.desktop\logs
```

## 架构亮点

```text
API / Routes (Hono)
  -> Orchestrator Engine (DAG 调度、失败降级、冲突解决、LLM 聚合)
  -> Agent Runtime (LLM / Code Agent / Native Tool)
  -> Infrastructure (LLM Client、Tool Registry、Git Branch Manager)
```

### Orchestrator

- 生成任务图并进行拓扑排序。
- 支持并行调度和失败降级。
- 合并多个 Agent 的子会话结果。
- 使用 LLM 汇总贡献、去重、标注风险和下一步。

### Git 分支隔离

每个非 read-only Agent 任务可在独立分支中执行：

1. 保护用户当前工作区。
2. 创建 `agenthub/{runId}/{agentKey}/{taskId}` 分支。
3. Agent 在分支上执行代码变更。
4. 执行完毕后提取 diff 作为 artifact。
5. 冲突检测后由用户确认合并或丢弃。

### 沙箱策略

| 策略 | 行为 |
| --- | --- |
| `read-only` | 不切分支，Agent 只读取文件 |
| `workspace-write` | 切独立 Git 分支，执行后提取 diff |
| `danger-full-access` | 允许更多操作，但仍建议配合分支隔离 |

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `DATABASE_URL` | SQLite 文件路径 | `./storage/agenthub.db` |
| `PORT` | 服务端端口 | `8000` |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | 通用 LLM 配置 | - |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | 供应商专用 Key | - |
| `AGENTHUB_ENABLE_CODE_AGENT_EXECUTION` | Code Agent 执行开关 | `false` |
| `ENABLE_LOCAL_CLI_PROBES` | 探测本机 CLI 工具 | `true` |
| `AGENTHUB_APP_DATA_DIR` | 桌面端 App Data 目录 | - |
| `AGENTHUB_CONFIG_DIR` | 桌面端配置目录 | - |
| `AGENTHUB_LOG_DIR` | 桌面端日志目录 | - |

## 测试

```bash
bun test
```

覆盖方向包括：

- 健康检查、会话和消息 CRUD
- 模型连接测试
- Workspace 任务派发与失败降级
- Agent 草案确认
- TaskGraph DAG 拓扑排序与环检测
- ConflictResolver 多 Agent 文件冲突检测
- GitBranchManager 分支生命周期

## 开发约定

- 全项目 ESM。
- TypeScript 开启 strict / isolatedModules。
- 代码格式以 Prettier 为准。
- 用户界面默认中文，关键类型和协议字段保留英文命名。

## 比赛信息

- 赛事：字节跳动 AI 全栈挑战赛
- 赛道：多 Agent 协作平台
- 截止时间：2026 年 6 月 10 日

## License

MIT
