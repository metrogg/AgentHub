# AgentHub

> 全 TypeScript / Bun 单仓的 IM 聊天式多 Agent 协作平台。

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 / 包管理 | **Bun** ≥ 1.1 |
| 单仓 | Bun Workspaces |
| 前端 | React 18 + Vite + MUI + Tailwind + Zustand |
| 后端 | **Hono** (跨运行时 Web 框架) + Bun.serve |
| 数据库 | **SQLite** (via `bun:sqlite`) + **Drizzle ORM** |
| 校验 | **Zod**（前后端共享 schema） |
| 鉴权 | JWT (`jose`) + Argon2id (`Bun.password`) |
| 日志 | Pino |
| 实时 | Bun WebSocket（原生） |

## 项目结构

```
agenthub/
├── package.json              # workspace 根
├── tsconfig.base.json
├── bunfig.toml
├── apps/
│   ├── web/                  # 前端 (Vite + React)
│   └── server/               # 后端 (Hono + Bun)
├── packages/
│   ├── shared/               # Zod schemas + 常量（前后端共享）
│   └── db/                   # Drizzle ORM schema + SQLite
├── sandbox/                  # 用户工作区（运行时生成）
├── scripts/
└── docs/
```

## 快速开始

### 1. 安装 Bun（一次）

Windows PowerShell：

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

macOS / Linux：

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. 安装依赖

```bash
bun install
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

### 4. 初始化数据库

```bash
bun db:generate    # 生成迁移 SQL
bun db:migrate     # 应用迁移到 SQLite
```

### 5. 启动开发

并行启动前后端：

```bash
bun dev
```

或分别启动：

```bash
bun dev:server     # http://localhost:8000
bun dev:web        # http://localhost:5173
```

## 常用脚本

| 命令 | 说明 |
|---|---|
| `bun dev` | 同时运行所有 workspace 的 dev |
| `bun dev:web` | 仅启动前端 |
| `bun dev:server` | 仅启动后端（带 `--hot`） |
| `bun build` | 构建所有 workspace |
| `bun typecheck` | 全仓 TS 类型检查 |
| `bun db:generate` | 由 `schema.ts` 生成迁移 |
| `bun db:migrate` | 执行迁移 |
| `bun db:studio` | 打开 Drizzle Studio |

## 架构亮点

- **端到端类型安全**：Hono RPC 客户端从 server 路由直接推导出前端调用类型，零手写 OpenAPI
- **共享 Zod schema**：`@agenthub/shared` 同时被服务端 `@hono/zod-validator` 和前端表单使用
- **零 Docker 依赖**：SQLite 文件 + Bun 单进程即可本地运行
- **极速冷启动**：Bun 启动 < 50ms，`bun --hot` 毫秒级热重载

## 部署

```bash
bun build
bun --filter @agenthub/server start
```

或编译单文件可执行：

```bash
bun build apps/server/src/index.ts --compile --outfile agenthub-server
```

## 许可证

MIT
