# AgentHub

AgentHub 是一个面向多 Agent 协作的本地工作台。它把 Claude Code、Codex、OpenCode 等 Coding Tools 抽象成统一的聊天对象，让用户可以在一个类似 IM 的界面里创建单聊、群聊、工作区和产物卡片，并逐步把代码、文档、网页预览、技能和部署流程串起来。

当前项目仍处于快速迭代阶段，核心目标是先把“本地多 Agent 协作 + 桌面客户端 + 项目工作区”跑通。

## 主要功能

- **多会话聊天**：每个 Agent 可以作为一个独立聊天对象，支持新建会话、历史上下文、消息编辑、撤回和重新生成。
- **Agent Group 群聊**：在群聊中 `@Agent`，Orchestrator 会拆解任务、生成任务卡、分发给子 Agent，并把子会话挂到主会话下。
- **工作区管理**：支持创建空白工作区、打开已有项目文件夹、为工作区配置目标、Agent、任务和项目路径。
- **Coding Tools 接入**：统一管理 Codex、Claude Code、OpenCode 的运行参数和状态，支持 CLI 执行、过程日志、命令记录、文件变更和产物卡片。
- **产物卡片**：聊天流中可以展示 diff、preview、file、deploy 等 artifact 结构，代码变更可扩展为真实 git diff。
- **办公室可视化**：Office 页面用于观察工作区中 Agent 的状态、活动和任务流转。
- **Skills 市场**：支持 SkillHub 来源搜索、详情查看、安装，并在输入 `/` 时调出已安装技能供 Agent 使用。
- **Coding Tools 配置**：提供 Codex `config.toml` / `auth.json` 编辑，OpenCode 模型读取，Claude Code 配置和 CLI 探测。
- **桌面客户端**：基于 Tauri v2，启动时自动拉起本机 server sidecar，并使用 App Data 保存数据库、配置和日志。

## 技术栈

- Web：React、Vite、Tailwind CSS、assistant-ui、Zustand
- Server：Bun、Hono、SQLite、Drizzle ORM
- Desktop：Tauri v2、Rust、Bun compiled sidecar
- Package manager：Bun workspace

## 项目结构

```text
apps/
  web/        React 前端
  server/     Hono API、WebSocket、Agent runner、静态资源托管
  desktop/    Tauri 桌面壳和 sidecar 打包脚本
packages/
  db/         SQLite schema、数据库初始化
  shared/     共享类型和工具
docs/         项目文档和设计记录
```

## 本地开发

先安装依赖：

```bash
bun install
```

启动 Web 和 Server：

```bash
bun run dev:web
bun run dev:server
```

常用检查：

```bash
bun run typecheck
```

数据库默认写入：

```text
./storage/agenthub.db
```

## 桌面客户端

桌面端会把 `apps/server` 编译成 sidecar，并把 `apps/web/dist` 复制到 Tauri resources。启动客户端后，Tauri 会：

1. 显示启动页。
2. 创建 App Data 目录。
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

构建完成后会生成 MSI 和 NSIS 安装包，例如：

```text
apps/desktop/src-tauri/target/release/bundle/msi/
apps/desktop/src-tauri/target/release/bundle/nsis/
```

桌面端数据路径：

```text
C:\Users\<you>\AppData\Roaming\com.agenthub.desktop\data
C:\Users\<you>\AppData\Roaming\com.agenthub.desktop\config
C:\Users\<you>\AppData\Roaming\com.agenthub.desktop\logs
```

## 环境变量

常用变量：

```bash
PORT=8000
DATABASE_URL=./storage/agenthub.db
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
AGENTHUB_ENABLE_CODE_AGENT_EXECUTION=false
AGENTHUB_CODE_AGENT_TIMEOUT_MS=120000
```

桌面端会自动注入：

```bash
NODE_ENV=production
AGENTHUB_APP_DATA_DIR=<AppData>/com.agenthub.desktop
AGENTHUB_CONFIG_DIR=<AppData>/com.agenthub.desktop/config
AGENTHUB_LOG_DIR=<AppData>/com.agenthub.desktop/logs
AGENTHUB_WEB_DIST=<Tauri resources>/web-dist
```

## Coding Tools 说明

AgentHub 通过统一适配器屏蔽不同 CLI 的差异。当前支持方向包括：

- Codex：读取和编辑本机 `config.toml`、`auth.json`，可作为 Coding Tools 执行任务。
- Claude Code：读取配置并作为 Coding Tools 默认运行参数。
- OpenCode：优先读取本机模型配置，减少重复配置。

如果 CLI 没有凭据、模型配置错误或环境变量缺失，AgentHub 会把诊断信息直接显示到聊天流的过程日志中。

## 自动更新

当前已预留桌面菜单和原生命令入口，但自动更新尚未配置发布通道。要完整启用 Tauri updater，还需要：

- 生成签名密钥。
- 配置 updater public key。
- 发布安装包和 `latest.json` / update manifest。
- 配置稳定可访问的更新 endpoint。

## 当前状态

已验证：

- `bun run typecheck`
- `cargo check`
- `bun --filter @agenthub/desktop prepare:sidecar`
- `bun run build:desktop`
- sidecar 生产模式 `/health` 和首页托管
- App Data 下数据库和日志创建

仍在迭代：

- 自动更新发布通道
- 部署卡片的完整闭环
- 更细粒度的 artifact 操作
- 更稳定的多 Agent 调度策略
