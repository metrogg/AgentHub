# AgentHub - 多 Agent 协作平台

> IM 聊天式多 Agent 协作平台，基于统一适配器层与主流 Agent 平台，为开发者提供自然交互体验的 AI 驱动开发与协作环境。

## 技术栈

| 层次 | 技术选型 |
|:---|:---|
| 前端 | React 18 + Vite + TypeScript + MUI + Tailwind CSS |
| 状态管理 | Zustand |
| 后端 | Python 3.11 + FastAPI |
| 数据库 | PostgreSQL 15 + SQLAlchemy 2.0 (async) |
| 缓存 | Redis 7 |
| 消息队列 | Redis Pub/Sub |
| 容器化 | Docker + docker-compose |
| 对象存储 | MinIO |

## 快速开始

### 环境要求

- Python >= 3.11
- Node.js >= 18
- Docker & docker-compose (可选)

### 1. 克隆项目

```bash
git clone <repository-url>
cd agenthub
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，填入实际的 API Key 和配置
```

### 3. 方式一：Docker 一键部署

```bash
docker-compose up -d
```

访问前端：`http://localhost`
访问后端 API：`http://localhost:8000`
访问 API 文档：`http://localhost:8000/docs`

### 4. 方式二：本地开发

#### 启动后端

```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt

# 初始化数据库
alembic upgrade head

# 启动服务
uvicorn app.main:app --reload --port 8000
```

#### 启动前端

```bash
cd frontend
npm install
npm run dev
```

前端开发服务器：`http://localhost:5173`

## 项目结构

```
agenthub/
├── docker-compose.yml          # 全栈 Docker 部署
├── Dockerfile                  # 后端镜像
├── Dockerfile.frontend         # 前端镜像
├── .env.example                # 环境变量模板
├── README.md                   # 项目说明
│
├── frontend/                   # 前端工程
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── tailwind.config.js
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── stores/             # Zustand 状态管理
│       ├── api/                # API 客户端
│       ├── components/         # UI 组件
│       ├── pages/              # 页面
│       ├── features/           # 业务特性
│       ├── types/              # TypeScript 类型
│       └── utils/              # 工具函数
│
├── backend/                    # 后端工程
│   ├── requirements.txt
│   ├── pyproject.toml
│   ├── alembic.ini
│   └── app/
│       ├── main.py             # FastAPI 入口
│       ├── config.py           # 配置管理
│       ├── api/                # API 路由
│       ├── core/               # 核心服务
│       ├── orchestrator/       # 编排器
│       ├── adapters/           # 适配器层
│       ├── agents/             # Agent 管理
│       ├── events/             # 事件总线
│       ├── models/             # ORM 模型
│       ├── schemas/            # Pydantic 模型
│       ├── sandbox/            # 代码沙箱
│       ├── deploy/             # 部署服务
│       ├── utils/              # 工具模块
│       └── db/                 # 数据库层
│
├── sandbox/                    # 沙箱运行时目录
│   ├── templates/              # 项目模板
│   └── workspaces/             # 用户工作区
│
├── scripts/                    # 运维脚本
│   ├── init_db.sh
│   └── migrate.sh
│
└── docs/                       # 项目文档
    ├── README.md               # 文档索引
    ├── 00-项目启动/
    ├── 01-需求分析/
    ├── 02-系统设计/
    ├── 03-开发实现/
    ├── 04-测试验收/
    └── 05-部署运维/
```

## 核心功能

- **IM 单聊/群聊**：类似飞书的自然聊天体验，支持 @Agent 指令
- **多会话并行**：同时维护多个独立会话，互不干扰
- **Orchestrator 编排**：自然语言需求自动拆解为子任务并调度 Agent 执行
- **代码 Diff 审查**：行级代码差异展示，支持接受/拒绝
- **实时网页预览**：前端代码生成后自动构建预览
- **一键部署**：支持部署到 Vercel / Netlify 等平台

## 开发规范

- 前端代码风格：Prettier + ESLint
- 后端代码风格：Black + isort + ruff
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)

## 许可证

MIT
