# AgentHub 系统架构设计文档

> **版本**: v1.0  
> **日期**: 2026-05-17  
> **架构师**: 高见远 (Bob)  
> **项目代号**: agenthub

---

## 目录

1. [实现方案与框架选型](#1-实现方案与框架选型)
2. [系统架构图](#2-系统架构图)
3. [文件列表及相对路径](#3-文件列表及相对路径)
4. [数据结构与接口](#4-数据结构与接口)
5. [程序调用流程](#5-程序调用流程)
6. [任务列表](#6-任务列表)
7. [依赖包列表](#7-依赖包列表)
8. [共享知识](#8-共享知识)
9. [待明确事项](#9-待明确事项)
10. [创新点设计](#10-创新点设计)

---

## 1. 实现方案与框架选型

### 1.1 技术选型总览

| 层次 | 选型 | 版本 | 选型理由 |
|:---|:---|:---|:---|
| 前端框架 | React | ^18.2.0 | 赛题要求，生态最成熟，组件复用率高 |
| 构建工具 | Vite | ^5.0.0 | 赛题要求，极速HMR，现代ESM原生支持 |
| UI组件库 | MUI + Tailwind CSS | ^5.14.0 / ^3.3.0 | 赛题要求，MUI提供企业级基础组件，Tailwind提供原子化样式灵活性 |
| 状态管理 | Zustand | ^4.5.0 | 轻量（<1KB），无需Provider，适合IM高频状态更新 |
| 后端框架 | **FastAPI (Python)** | ^0.110.0 | **详见下方论证**，Python是AI/Agent开发生态的核心语言 |
| 数据库 | PostgreSQL | ^15.0 | ACID事务、JSONB原生支持、行级安全策略 |
| 缓存/消息 | Redis | ^7.0 | Pub/Sub支持WebSocket广播、会话状态缓存、分布式锁 |
| 实时通信 | WebSocket + SSE | Native / fastapi-sse | WebSocket用于双向聊天，SSE用于Agent流式响应 |
| 容器化 | Docker + docker-compose | ^24.0 | 一键部署、环境一致性、沙箱隔离基础 |
| 代码Diff | Monaco Editor + diff-match-patch | ^0.45.0 | VS Code内核，工业级代码对比能力 |
| 沙箱执行 | Docker-in-Docker + seccomp | Native | 代码在隔离容器中运行，限制系统调用 |

### 1.2 后端框架选型论证：FastAPI vs Node.js

**决策结论：选用 Python FastAPI**

| 维度 | Python FastAPI | Node.js (Express/NestJS) | 结论 |
|:---|:---|:---|:---|
| **Agent生态** | Python是AI/LLM生态的核心语言，OpenAI SDK、Anthropic SDK、LangChain、LlamaIndex等均为Python原生 | Node.js有SDK但多为Python的移植版，功能滞后 | **FastAPI胜** |
| **MCP协议** | MCP官方SDK提供Python/TypeScript双版本，Python版本更成熟 | TypeScript版本可用但社区活跃度较低 | **FastAPI胜** |
| **异步性能** | 基于asyncio + uvicorn，性能接近Node.js | Node.js原生异步，事件循环模型成熟 | 平手 |
| **类型安全** | 原生Pydantic集成，自动生成OpenAPI/Swagger文档 | 需额外配置Zod等校验库 | **FastAPI胜** |
| **团队技能** | 比赛中AI/算法逻辑用Python更自然 | 前端团队可共享TypeScript知识 | 平手 |
| **沙箱执行** | Python subprocess + Docker SDK for Python更成熟 | Node.js child_process也可实现 | 平手 |
| **部署便捷** | Uvicorn单进程即可运行，Gunicorn多 worker 简单配置 | PM2/cluster模式同样便捷 | 平手 |

**核心论据**：AgentHub的核心竞争力在于**统一适配器层**和**Orchestrator编排器**，这两个模块深度依赖LLM SDK、MCP协议和A2A协议。Python生态在这些领域具有压倒性优势。FastAPI的Pydantic原生集成还能自动生成API文档，减少前后端联调成本。

### 1.3 核心架构模式

```
┌─────────────────────────────────────────────────────────────────────┐
│                    AgentHub 架构模式: Event Stream + 分层适配         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐         │
│   │   前端层      │    │   API网关层   │    │   核心服务层  │         │
│   │  (React)     │◄──►│  (FastAPI)   │◄──►│  (Python)    │         │
│   └──────────────┘    └──────────────┘    └──────────────┘         │
│          ▲                    ▲                  ▲                  │
│          │ WebSocket          │ SSE              │ gRPC/HTTP        │
│          │                    │                  │                  │
│   ┌──────┴────────────────────┴──────────────────┴──────┐           │
│   │              Event Bus (Redis Pub/Sub)              │           │
│   └─────────────────────────────────────────────────────┘           │
│                                                                     │
│   设计模式:                                                         │
│   - 前端: MVVM (Zustand状态管理 + React组件)                        │
│   - 后端: 依赖注入 + Repository模式 + Event-driven                  │
│   - 适配器: Strategy模式 (不同Agent用不同策略实现统一接口)           │
│   - Orchestrator: Chain of Responsibility + Observer                │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. 系统架构图

### 2.1 整体架构图

```mermaid
graph TB
    subgraph Client["客户端层 (Client Layer)"]
        FE["React + Vite<br/>MUI + Tailwind"]
        Browser["Chrome/Edge/Safari"]
    end

    subgraph Gateway["网关层 (Gateway Layer)"]
        APIGateway["FastAPI Gateway<br/>• JWT Auth<br/>• Rate Limit<br/>• CORS"]
        WSServer["WebSocket Server<br/>• 连接管理<br/>• 心跳检测<br/>• 消息路由"]
        SSEServer["SSE Server<br/>• 流式推送<br/>• Agent响应流"]
    end

    subgraph CoreService["核心服务层 (Core Service Layer)"]
        SessionMgr["Session Manager<br/>• 会话CRUD<br/>• 上下文隔离"]
        MsgMgr["Message Manager<br/>• 消息存储<br/>• 历史查询"]
        Orchestrator["Orchestrator<br/>• 意图理解<br/>• 任务拆解<br/>• Agent调度"]
        DiffEngine["Diff Engine<br/>• 代码比对<br/>• Patch生成"]
        PreviewSvc["Preview Service<br/>• 前端构建<br/>• iframe托管"]
        DeploySvc["Deploy Service<br/>• 平台适配<br/>• 一键部署"]
    end

    subgraph AdapterLayer["统一适配器层 (Adapter Layer)"]
        AdapterRegistry["Adapter Registry<br/>• 适配器注册<br/>• 能力发现"]
        ClaudeAdapter["Claude Code Adapter"]
        CodexAdapter["Codex Adapter"]
        MCPAdapter["MCP Adapter<br/>• Tool调用"]
        A2AAdapter["A2A Adapter<br/>• Agent间通信"]
    end

    subgraph DataLayer["数据层 (Data Layer)"]
        PG[("PostgreSQL<br/>• Users/Sessions<br/>• Messages/Tasks<br/>• Projects")]
        Redis[("Redis<br/>• 会话状态<br/>• 消息队列<br/>• WebSocket连接")]
        MinIO[("MinIO/S3<br/>• 代码文件<br/>• 预览产物<br/>• 构建产物")]
    end

    subgraph Sandbox["沙箱层 (Sandbox Layer)"]
        DockerSandbox["Docker Sandbox<br/>• 代码执行<br/>• 资源限制<br/>• 网络隔离"]
        BuildEnv["Build Environment<br/>• Node.js<br/>• Python<br/>• Vite"]
    end

    subgraph External["外部系统 (External)"]
        AnthropicAPI["Anthropic API"]
        OpenAIAPI["OpenAI API"]
        VercelAPI["Vercel API"]
        NetlifyAPI["Netlify API"]
        MCPServers["MCP Servers"]
    end

    FE -->|"HTTPS / REST"| APIGateway
    FE -->|"WebSocket"| WSServer
    FE -->|"SSE"| SSEServer

    APIGateway --> SessionMgr
    APIGateway --> MsgMgr
    APIGateway --> DiffEngine
    APIGateway --> PreviewSvc
    APIGateway --> DeploySvc

    WSServer --> MsgMgr
    WSServer --> Redis

    SSEServer --> AdapterRegistry

    SessionMgr --> PG
    MsgMgr --> PG
    MsgMgr --> Redis

    Orchestrator --> AdapterRegistry
    Orchestrator --> SessionMgr
    Orchestrator --> MsgMgr

    AdapterRegistry --> ClaudeAdapter
    AdapterRegistry --> CodexAdapter
    AdapterRegistry --> MCPAdapter
    AdapterRegistry --> A2AAdapter

    ClaudeAdapter --> AnthropicAPI
    CodexAdapter --> OpenAIAPI
    MCPAdapter --> MCPServers
    A2AAdapter --> ClaudeAdapter
    A2AAdapter --> CodexAdapter

    DiffEngine --> MinIO
    PreviewSvc --> DockerSandbox
    PreviewSvc --> MinIO
    DeploySvc --> VercelAPI
    DeploySvc --> NetlifyAPI

    DockerSandbox --> BuildEnv
    DockerSandbox --> MinIO

    SessionMgr --> Redis
    Orchestrator --> Redis
```

### 2.2 核心模块依赖图

```mermaid
graph LR
    subgraph Frontend["前端模块"]
        ChatUI["Chat UI"]
        DiffViewer["Diff Viewer"]
        PreviewPanel["Preview Panel"]
        TaskDashboard["Task Dashboard"]
        AgentStore["Agent Store"]
    end

    subgraph Core["后端核心模块"]
        SessionService["Session Service"]
        MessageService["Message Service"]
        OrchestratorService["Orchestrator Service"]
        UserService["User Service"]
    end

    subgraph Infra["基础设施模块"]
        WebSocketManager["WebSocket Manager"]
        EventBus["Event Bus"]
        AuthMiddleware["Auth Middleware"]
    end

    subgraph Adapter["适配器模块"]
        BaseAdapter["Base Adapter Interface"]
        ClaudeAdapter["Claude Adapter"]
        CodexAdapter["Codex Adapter"]
        MCPHub["MCP Hub"]
        A2AGateway["A2A Gateway"]
    end

    ChatUI --> WebSocketManager
    ChatUI --> SessionService
    DiffViewer --> MessageService
    PreviewPanel --> OrchestratorService
    TaskDashboard --> OrchestratorService
    AgentStore --> BaseAdapter

    SessionService --> EventBus
    MessageService --> EventBus
    MessageService --> WebSocketManager
    OrchestratorService --> BaseAdapter
    OrchestratorService --> EventBus
    UserService --> AuthMiddleware

    BaseAdapter --> ClaudeAdapter
    BaseAdapter --> CodexAdapter
    BaseAdapter --> MCPHub
    BaseAdapter --> A2AGateway
```

---

## 3. 文件列表及相对路径

### 3.1 项目根目录结构

```
agenthub/
├── docker-compose.yml              # 全栈一键部署
├── Dockerfile                      # 后端服务镜像
├── Dockerfile.frontend             # 前端构建镜像
├── README.md
├── .env.example                    # 环境变量模板
├── docs/                           # 文档目录
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── sequence-diagram.mermaid
│   └── class-diagram.mermaid
│
├── frontend/                       # 前端工程 (Vite + React)
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── tailwind.config.js
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx                # 应用入口
│   │   ├── App.tsx                 # 根组件
│   │   ├── index.css               # 全局样式
│   │   │
│   │   ├── stores/                 # Zustand 状态管理
│   │   │   ├── authStore.ts
│   │   │   ├── sessionStore.ts
│   │   │   ├── messageStore.ts
│   │   │   ├── orchestratorStore.ts
│   │   │   └── uiStore.ts
│   │   │
│   │   ├── api/                    # API 客户端
│   │   │   ├── client.ts           # axios/fetch封装
│   │   │   ├── auth.ts
│   │   │   ├── sessions.ts
│   │   │   ├── messages.ts
│   │   │   ├── agents.ts
│   │   │   ├── tasks.ts
│   │   │   ├── diff.ts
│   │   │   ├── preview.ts
│   │   │   └── deploy.ts
│   │   │
│   │   ├── hooks/                  # 自定义React Hooks
│   │   │   ├── useWebSocket.ts
│   │   │   ├── useSSE.ts
│   │   │   ├── useChat.ts
│   │   │   ├── useAgentRegistry.ts
│   │   │   └── useAuth.ts
│   │   │
│   │   ├── components/             # 公共UI组件
│   │   │   ├── common/
│   │   │   │   ├── Avatar.tsx
│   │   │   │   ├── StatusBadge.tsx
│   │   │   │   ├── LoadingDots.tsx
│   │   │   │   └── ErrorBoundary.tsx
│   │   │   ├── layout/
│   │   │   │   ├── Sidebar.tsx
│   │   │   │   ├── TopBar.tsx
│   │   │   │   ├── ResizablePanel.tsx
│   │   │   │   └── MainLayout.tsx
│   │   │   └── chat/
│   │   │       ├── MessageBubble.tsx
│   │   │       ├── MessageList.tsx
│   │   │       ├── MessageInput.tsx
│   │   │       ├── CodeBlock.tsx
│   │   │       ├── MarkdownRenderer.tsx
│   │   │       ├── TypingIndicator.tsx
│   │   │       ├── AgentMention.tsx
│   │   │       └── AgentLogPanel.tsx
│   │   │
│   │   ├── pages/                  # 页面级组件
│   │   │   ├── LoginPage.tsx
│   │   │   ├── RegisterPage.tsx
│   │   │   ├── ChatPage.tsx        # IM主界面
│   │   │   ├── SessionListPage.tsx
│   │   │   ├── AgentStorePage.tsx
│   │   │   └── SettingsPage.tsx
│   │   │
│   │   ├── features/               # 业务特性组件
│   │   │   ├── chat/
│   │   │   │   ├── ChatContainer.tsx
│   │   │   │   ├── ChatHeader.tsx
│   │   │   │   ├── SessionList.tsx
│   │   │   │   ├── SessionItem.tsx
│   │   │   │   ├── GroupMemberList.tsx
│   │   │   │   └── CreateSessionModal.tsx
│   │   │   ├── diff/
│   │   │   │   ├── DiffViewer.tsx
│   │   │   │   ├── FileTree.tsx
│   │   │   │   ├── DiffActions.tsx
│   │   │   │   └── DiffModal.tsx
│   │   │   ├── preview/
│   │   │   │   ├── PreviewPanel.tsx
│   │   │   │   ├── PreviewToolbar.tsx
│   │   │   │   ├── DeviceSwitcher.tsx
│   │   │   │   └── ShareButton.tsx
│   │   │   ├── orchestrator/
│   │   │   │   ├── TaskTree.tsx
│   │   │   │   ├── TaskNode.tsx
│   │   │   │   ├── TaskProgress.tsx
│   │   │   │   ├── OrchestratorPanel.tsx
│   │   │   │   └── HumanApprovalGate.tsx
│   │   │   └── agent/
│   │   │       ├── AgentCard.tsx
│   │   │       ├── AgentConfigForm.tsx
│   │   │       └── AgentCapabilityList.tsx
│   │   │
│   │   ├── types/                  # TypeScript类型定义
│   │   │   ├── user.ts
│   │   │   ├── session.ts
│   │   │   ├── message.ts
│   │   │   ├── agent.ts
│   │   │   ├── task.ts
│   │   │   ├── diff.ts
│   │   │   ├── websocket.ts
│   │   │   └── api.ts
│   │   │
│   │   └── utils/                  # 工具函数
│   │       ├── formatters.ts
│   │       ├── validators.ts
│   │       ├── constants.ts
│   │       └── websocket.ts
│   │
│   └── public/
│       └── favicon.ico
│
├── backend/                        # 后端工程 (FastAPI + Python)
│   ├── requirements.txt
│   ├── pyproject.toml
│   ├── alembic.ini                 # 数据库迁移
│   ├── alembic/                    # 迁移脚本目录
│   │   ├── env.py
│   │   └── versions/
│   ├── Dockerfile
│   │
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py                 # FastAPI应用入口
│   │   ├── config.py               # 配置管理 (Pydantic Settings)
│   │   ├── dependencies.py         # 依赖注入
│   │   ├── exceptions.py           # 全局异常处理
│   │   └── constants.py            # 业务常量
│   │
│   ├── app/api/                    # API路由层
│   │   ├── __init__.py
│   │   ├── v1/
│   │   │   ├── __init__.py
│   │   │   ├── router.py           # API v1总路由
│   │   │   ├── auth.py             # 认证API
│   │   │   ├── users.py            # 用户API
│   │   │   ├── sessions.py         # 会话API
│   │   │   ├── messages.py         # 消息API
│   │   │   ├── agents.py           # Agent API
│   │   │   ├── tasks.py            # 任务API
│   │   │   ├── diff.py             # Diff API
│   │   │   ├── preview.py          # 预览API
│   │   │   └── deploy.py           # 部署API
│   │   └── websocket/
│   │       ├── __init__.py
│   │       ├── router.py           # WebSocket路由
│   │       ├── manager.py          # 连接管理器
│   │       └── handlers.py         # 消息处理器
│   │
│   ├── app/core/                   # 核心服务层
│   │   ├── __init__.py
│   │   ├── auth_service.py         # 认证服务
│   │   ├── session_service.py      # 会话服务
│   │   ├── message_service.py      # 消息服务
│   │   ├── user_service.py         # 用户服务
│   │   ├── task_service.py         # 任务服务
│   │   ├── diff_service.py         # Diff服务
│   │   ├── preview_service.py      # 预览服务
│   │   └── deploy_service.py       # 部署服务
│   │
│   ├── app/orchestrator/           # Orchestrator编排器
│   │   ├── __init__.py
│   │   ├── orchestrator.py         # 主编排器
│   │   ├── intent_classifier.py    # 意图分类器
│   │   ├── task_planner.py         # 任务规划器
│   │   ├── task_decomposer.py      # 任务拆解器
│   │   ├── agent_router.py         # Agent路由器
│   │   ├── agent_scheduler.py      # Agent调度器
│   │   ├── result_aggregator.py    # 结果聚合器
│   │   └── context_manager.py      # 上下文管理器
│   │
│   ├── app/adapters/               # 统一适配器层
│   │   ├── __init__.py
│   │   ├── base_adapter.py         # 适配器抽象基类
│   │   ├── adapter_registry.py     # 适配器注册表
│   │   ├── adapter_factory.py      # 适配器工厂
│   │   ├── claude_adapter.py       # Claude Code适配器
│   │   ├── codex_adapter.py        # Codex适配器
│   │   ├── mcp_adapter.py          # MCP协议适配器
│   │   └── a2a_adapter.py          # A2A协议适配器
│   │
│   ├── app/agents/                 # Agent定义与管理
│   │   ├── __init__.py
│   │   ├── agent_registry.py       # Agent注册表
│   │   ├── agent_manager.py        # Agent生命周期管理
│   │   ├── builtin_agents.py       # 内置Agent定义
│   │   └── agent_config.py         # Agent配置模型
│   │
│   ├── app/events/                 # Event Stream事件总线
│   │   ├── __init__.py
│   │   ├── event_bus.py            # 事件总线核心
│   │   ├── event_types.py          # 事件类型枚举
│   │   ├── event_stream.py         # 事件流处理器
│   │   ├── handlers/               # 事件处理器
│   │   │   ├── message_handler.py
│   │   │   ├── agent_handler.py
│   │   │   └── task_handler.py
│   │   └── publishers/             # 事件发布器
│   │       ├── websocket_publisher.py
│   │       └── sse_publisher.py
│   │
│   ├── app/models/                 # ORM数据模型
│   │   ├── __init__.py
│   │   ├── base.py                 # SQLAlchemy基类
│   │   ├── user.py
│   │   ├── session.py
│   │   ├── message.py
│   │   ├── agent.py
│   │   ├── task.py
│   │   ├── project.py
│   │   └── file_change.py
│   │
│   ├── app/schemas/                # Pydantic数据模型
│   │   ├── __init__.py
│   │   ├── user.py
│   │   ├── session.py
│   │   ├── message.py
│   │   ├── agent.py
│   │   ├── task.py
│   │   ├── diff.py
│   │   ├── websocket.py
│   │   └── common.py               # 通用响应格式
│   │
│   ├── app/sandbox/                # 代码沙箱
│   │   ├── __init__.py
│   │   ├── sandbox.py              # 沙箱管理器
│   │   ├── docker_runner.py        # Docker执行器
│   │   ├── build_engine.py         # 前端构建引擎
│   │   └── security.py             # 安全策略
│   │
│   ├── app/deploy/                 # 部署服务
│   │   ├── __init__.py
│   │   ├── deploy_manager.py       # 部署管理器
│   │   ├── vercel_deployer.py      # Vercel部署
│   │   ├── netlify_deployer.py     # Netlify部署
│   │   └── deploy_config.py        # 部署配置
│   │
│   ├── app/utils/                  # 工具模块
│   │   ├── __init__.py
│   │   ├── crypto.py               # 加密工具 (API Key)
│   │   ├── jwt_helper.py           # JWT工具
│   │   ├── diff_utils.py           # Diff计算工具
│   │   ├── validators.py           # 输入校验
│   │   └── logger.py               # 结构化日志
│   │
│   └── app/db/                     # 数据库层
│       ├── __init__.py
│       ├── session.py              # DB Session管理
│       ├── connection.py           # 连接池
│       └── migrations/             # 迁移脚本
│
├── sandbox/                        # 沙箱运行时目录 (挂载卷)
│   ├── templates/                  # 项目模板
│   └── workspaces/                 # 用户工作区
│
└── scripts/                        # 运维脚本
    ├── init_db.sh
    ├── migrate.sh
    └── seed_data.py
```

---

## 4. 数据结构与接口

### 4.1 核心实体类图

```mermaid
classDiagram
    class User {
        +UUID id
        +String email
        +String username
        +String password_hash
        +String avatar_url
        +UserRole role
        +String api_key_encrypted
        +DateTime created_at
        +DateTime updated_at
        +Boolean is_active
        +login(credentials) AuthToken
        +update_profile(data) User
        +rotate_api_key() String
    }

    class Session {
        +UUID id
        +String title
        +SessionType type
        +UUID owner_id
        +UUID project_id
        +DateTime created_at
        +DateTime updated_at
        +Boolean is_archived
        +add_member(user_id, role)
        +remove_member(user_id)
        +get_members() Member[]
        +archive()
    }

    class Message {
        +UUID id
        +UUID session_id
        +UUID sender_id
        +SenderType sender_type
        +String content
        +MessageType type
        +MessageStatus status
        +JSON metadata
        +DateTime created_at
        +DateTime updated_at
        +edit(new_content) Message
        +mark_as_read()
        +serialize() Dict
    }

    class Agent {
        +UUID id
        +String name
        +String display_name
        +String description
        +AgentType type
        +JSON capabilities
        +String system_prompt
        +JSON config
        +Boolean is_builtin
        +Boolean is_active
        +DateTime created_at
        +invoke(messages, context) EventStream
        +get_capabilities() Capability[]
        +validate_config() Boolean
    }

    class Task {
        +UUID id
        +UUID parent_id
        +UUID session_id
        +String title
        +String description
        +TaskStatus status
        +UUID assigned_agent_id
        +UUID created_by
        +JSON result
        +DateTime created_at
        +DateTime started_at
        +DateTime completed_at
        +Float progress
        +start() Task
        +complete(result) Task
        +fail(error) Task
        +pause() Task
        +resume() Task
        +get_children() Task[]
    }

    class Project {
        +UUID id
        +String name
        +String description
        +UUID owner_id
        +String repo_url
        +JSON file_tree
        +DateTime created_at
        +DateTime updated_at
        +import_from_repo(url)
        +get_file_tree() FileNode[]
        +apply_changes(diff) Boolean
    }

    class FileChange {
        +UUID id
        +UUID project_id
        +UUID message_id
        +String file_path
        +ChangeType type
        +String old_content
        +String new_content
        +String diff_patch
        +ChangeStatus status
        +DateTime created_at
        +approve() FileChange
        +reject() FileChange
        +get_diff() String
    }

    class SessionMember {
        +UUID session_id
        +UUID member_id
        +MemberType member_type
        +MemberRole role
        +DateTime joined_at
    }

    class Adapter {
        <<abstract>>
        +String adapter_id
        +String adapter_type
        +JSON config
        +connect() Boolean
        +disconnect()
        +send(messages) EventStream
        +get_status() AdapterStatus
        +validate_messages(messages) Boolean
    }

    class ClaudeAdapter {
        +String api_key
        +String model
        +send(messages) EventStream
        +handle_tool_call(tool_call) ToolResult
    }

    class CodexAdapter {
        +String api_key
        +String model
        +send(messages) EventStream
        +handle_code_request(request) CodeResult
    }

    class MCPAdapter {
        +String server_url
        +List~Tool~ tools
        +discover_tools() Tool[]
        +call_tool(name, params) ToolResult
    }

    class Orchestrator {
        +UUID id
        +String name
        +classify_intent(message) Intent
        +decompose_task(intent) Task[]
        +route_task(task, agents) Agent
        +schedule_tasks(tasks) ExecutionPlan
        +aggregate_results(results) String
        +handle_approval(task) Task
    }

    User "1" --> "*" Session : owns
    User "1" --> "*" SessionMember : participates
    Session "1" --> "*" SessionMember : has
    Session "1" --> "*" Message : contains
    Session "1" --> "*" Task : has
    Message "1" --> "*" FileChange : generates
    Agent "1" --> "*" Task : assigned to
    Project "1" --> "*" FileChange : has
    User "1" --> "*" Project : owns
    Adapter <|-- ClaudeAdapter
    Adapter <|-- CodexAdapter
    Adapter <|-- MCPAdapter
    Agent --> Adapter : uses
    Orchestrator --> Agent : routes to
    Orchestrator --> Task : manages
```

### 4.2 适配器接口详细定义

```mermaid
classDiagram
    class BaseAdapter {
        <<abstract>>
        +String adapter_id
        +String adapter_type
        +String display_name
        +JSON config
        +AdapterStatus status
        +__init__(config)
        +connect() Boolean
        +disconnect()
        +send(messages, context) AsyncIterator~Event~
        +get_capabilities() Capability[]
        +get_status() AdapterStatus
        +validate_config() Boolean
        +health_check() Boolean
    }

    class IEventStream {
        <<interface>>
        +stream() AsyncIterator~Event~
        +on_event(callback)
        +on_error(callback)
        +on_complete(callback)
        +cancel()
    }

    class Event {
        +EventType type
        +String adapter_id
        +UUID session_id
        +UUID message_id
        +JSON payload
        +DateTime timestamp
        +to_json() String
    }

    class Capability {
        +String name
        +String description
        +CapabilityType type
        +JSON parameters_schema
        +JSON returns_schema
    }

    BaseAdapter --> IEventStream : returns
    IEventStream --> Event : produces
    BaseAdapter --> Capability : exposes
```

### 4.3 REST API 接口定义

| 模块 | 方法 | 路径 | 说明 |
|:---|:---|:---|:---|
| **Auth** | POST | `/api/v1/auth/register` | 用户注册 |
| | POST | `/api/v1/auth/login` | 用户登录 |
| | POST | `/api/v1/auth/refresh` | 刷新Token |
| | POST | `/api/v1/auth/logout` | 登出 |
| **User** | GET | `/api/v1/users/me` | 获取当前用户 |
| | PUT | `/api/v1/users/me` | 更新用户信息 |
| | PUT | `/api/v1/users/api-key` | 更新API Key |
| **Session** | GET | `/api/v1/sessions` | 获取会话列表 |
| | POST | `/api/v1/sessions` | 创建会话 |
| | GET | `/api/v1/sessions/{id}` | 获取会话详情 |
| | PUT | `/api/v1/sessions/{id}` | 更新会话 |
| | DELETE | `/api/v1/sessions/{id}` | 删除会话 |
| | POST | `/api/v1/sessions/{id}/members` | 添加成员 |
| | DELETE | `/api/v1/sessions/{id}/members/{member_id}` | 移除成员 |
| **Message** | GET | `/api/v1/sessions/{id}/messages` | 获取消息历史 |
| | POST | `/api/v1/sessions/{id}/messages` | 发送消息 |
| | PUT | `/api/v1/messages/{id}` | 编辑消息 |
| | DELETE | `/api/v1/messages/{id}` | 删除消息 |
| **Agent** | GET | `/api/v1/agents` | 获取Agent列表 |
| | GET | `/api/v1/agents/{id}` | 获取Agent详情 |
| | POST | `/api/v1/agents` | 创建自定义Agent |
| | PUT | `/api/v1/agents/{id}` | 更新Agent配置 |
| | POST | `/api/v1/agents/{id}/test` | 测试Agent连接 |
| **Task** | GET | `/api/v1/sessions/{id}/tasks` | 获取任务树 |
| | GET | `/api/v1/tasks/{id}` | 获取任务详情 |
| | POST | `/api/v1/tasks/{id}/approve` | 人工审批通过 |
| | POST | `/api/v1/tasks/{id}/reject` | 人工审批拒绝 |
| **Diff** | GET | `/api/v1/messages/{id}/diff` | 获取消息关联的Diff |
| | POST | `/api/v1/diff/{id}/apply` | 应用代码变更 |
| | POST | `/api/v1/diff/{id}/reject` | 拒绝代码变更 |
| | POST | `/api/v1/diff/batch-apply` | 批量应用变更 |
| **Preview** | GET | `/api/v1/sessions/{id}/preview` | 获取预览URL |
| | POST | `/api/v1/sessions/{id}/preview/build` | 触发构建 |
| | GET | `/api/v1/preview/{token}/` | 预览代理服务 |
| **Deploy** | POST | `/api/v1/sessions/{id}/deploy` | 一键部署 |
| | GET | `/api/v1/deployments` | 获取部署历史 |
| | POST | `/api/v1/deployments/{id}/rollback` | 回滚部署 |

### 4.4 WebSocket 事件协议

```typescript
// 客户端 → 服务端
interface ClientEvents {
  "message:send": { session_id: string; content: string; type: "text" | "mention" };
  "message:typing": { session_id: string; is_typing: boolean };
  "agent:invoke": { session_id: string; agent_id: string; content: string };
  "task:approve": { task_id: string; approved: boolean };
  "session:join": { session_id: string };
  "session:leave": { session_id: string };
  "ping": {};
}

// 服务端 → 客户端
interface ServerEvents {
  "message:received": Message;
  "message:stream": { message_id: string; delta: string };
  "message:completed": Message;
  "agent:typing": { session_id: string; agent_id: string };
  "agent:log": { session_id: string; agent_id: string; log: AgentLog };
  "task:updated": Task;
  "task:needs_approval": { task_id: string; description: string };
  "diff:generated": { message_id: string; changes: FileChange[] };
  "preview:ready": { session_id: string; url: string };
  "deploy:completed": { deployment_id: string; url: string };
  "error": { code: string; message: string };
  "pong": {};
}
```

---

## 5. 程序调用流程

### 5.1 单聊流程

```mermaid
sequenceDiagram
    actor User
    participant FE as Frontend (React)
    participant WS as WebSocket Manager
    participant Auth as Auth Middleware
    participant MsgSvc as Message Service
    participant EventBus as Event Bus
    participant Adapter as Adapter Registry
    participant Claude as Claude Adapter
    participant PG as PostgreSQL
    participant Redis as Redis

    User->>FE: 输入消息并发送
    FE->>WS: emit("message:send")
    WS->>Auth: 验证JWT Token
    Auth-->>WS: Token有效
    WS->>MsgSvc: create_message(session_id, content)
    MsgSvc->>PG: INSERT message
    PG-->>MsgSvc: message记录
    MsgSvc->>Redis: pub(channel, "message:received")
    Redis-->>WS: 广播消息
    WS-->>FE: on("message:received")
    FE-->>User: 显示用户消息

    MsgSvc->>EventBus: publish("agent.invoke", {session, message})
    EventBus->>Adapter: get_adapter_for_session(session)
    Adapter->>Claude: invoke(messages, context)
    Claude->>Claude: 调用Anthropic API
    Claude-->>Adapter: EventStream (SSE)

    loop 流式响应
        Adapter->>EventBus: publish("message:stream", delta)
        EventBus->>Redis: pub(channel, delta)
        Redis-->>WS: 推送增量
        WS-->>FE: on("message:stream")
        FE-->>User: 逐字显示Agent回复
    end

    Adapter->>EventBus: publish("message:completed")
    EventBus->>MsgSvc: save_message(agent_response)
    MsgSvc->>PG: INSERT agent_message
    PG-->>MsgSvc: 完成
    MsgSvc->>Redis: pub(channel, "message:completed")
    Redis-->>WS: 广播完成事件
    WS-->>FE: on("message:completed")
    FE-->>User: 显示完整回复
```

### 5.2 群聊 @Agent 流程

```mermaid
sequenceDiagram
    actor User
    participant FE as Frontend
    participant WS as WebSocket
    participant MsgSvc as Message Service
    participant MentionParser as Mention Parser
    participant Orchestrator as Orchestrator
    participant Router as Agent Router
    participant EventBus as Event Bus
    participant AdapterA as Adapter A (FrontendAgent)
    participant AdapterB as Adapter B (BackendAgent)

    User->>FE: 输入 "@FrontendAgent 写登录页 @BackendAgent 写API"
    FE->>WS: emit("message:send")
    WS->>MsgSvc: create_message()
    MsgSvc->>MentionParser: parse_mentions(content)
    MentionParser-->>MsgSvc: ["FrontendAgent", "BackendAgent"]
    MsgSvc->>EventBus: publish("message:mentioned", {mentions, message})

    EventBus->>Orchestrator: on_message(session, message)
    Orchestrator->>Orchestrator: classify_intent(message)
    Orchestrator->>Router: route_to_agents(mentions, intent)
    Router->>Router: match_agents(mentions)
    Router-->>Orchestrator: [AdapterA, AdapterB]

    par 并行调度
        Orchestrator->>EventBus: publish("agent:invoke", AdapterA)
        EventBus->>AdapterA: invoke(messages)
        AdapterA-->>EventBus: EventStream A
        EventBus->>WS: stream "agent:typing" (A)
        WS-->>FE: 显示A正在输入
        loop 流式响应A
            EventBus->>WS: stream "message:stream" (A)
            WS-->>FE: 显示A的回复
        end
    and
        Orchestrator->>EventBus: publish("agent:invoke", AdapterB)
        EventBus->>AdapterB: invoke(messages)
        AdapterB-->>EventBus: EventStream B
        EventBus->>WS: stream "agent:typing" (B)
        WS-->>FE: 显示B正在输入
        loop 流式响应B
            EventBus->>WS: stream "message:stream" (B)
            WS-->>FE: 显示B的回复
        end
    end

    Orchestrator->>EventBus: publish("message:completed")
    EventBus->>MsgSvc: save_messages([A_response, B_response])
```

### 5.3 Orchestrator 任务拆解流程

```mermaid
sequenceDiagram
    actor User
    participant FE as Frontend
    participant REST as REST API
    participant Orchestrator as Orchestrator
    participant IntentCls as Intent Classifier
    participant TaskPlanner as Task Planner
    participant TaskDecomposer as Task Decomposer
    participant AgentRouter as Agent Router
    participant Scheduler as Agent Scheduler
    participant TaskSvc as Task Service
    participant PG as PostgreSQL

    User->>FE: 输入 "创建一个带JWT登录的Todo应用"
    FE->>REST: POST /api/v1/sessions/{id}/tasks/auto
    REST->>Orchestrator: auto_decompose(session_id, requirement)

    Orchestrator->>IntentCls: classify(requirement)
    IntentCls->>IntentCls: LLM意图分类
    IntentCls-->>Orchestrator: Intent{category: "fullstack_app", complexity: "medium"}

    Orchestrator->>TaskPlanner: plan(intent, requirement)
    TaskPlanner->>TaskPlanner: LLM生成顶层任务
    TaskPlanner-->>Orchestrator: ["UI设计", "数据库设计", "API开发", "前端实现"]

    loop 递归拆解
        Orchestrator->>TaskDecomposer: decompose(task, depth)
        TaskDecomposer->>TaskDecomposer: LLM子任务拆解
        TaskDecomposer-->>Orchestrator: SubTask[]
    end

    Orchestrator->>AgentRouter: assign_agents(task_tree, available_agents)
    AgentRouter->>AgentRouter: 能力匹配算法
    AgentRouter-->>Orchestrator: Task[] with agent_id

    Orchestrator->>Scheduler: schedule(tasks)
    Scheduler->>Scheduler: 拓扑排序 + 并行度分析
    Scheduler-->>Orchestrator: ExecutionPlan

    Orchestrator->>TaskSvc: create_task_tree(tasks)
    TaskSvc->>PG: INSERT tasks (with parent_id)
    PG-->>TaskSvc: task_ids[]
    TaskSvc-->>Orchestrator: TaskTree

    Orchestrator-->>REST: TaskTree + ExecutionPlan
    REST-->>FE: {code: 200, data: task_tree}
    FE-->>User: 显示任务拆解树

    Orchestrator->>Scheduler: execute_plan(execution_plan)
    Scheduler->>Scheduler: 启动无依赖任务
```

### 5.4 代码 Diff 生成流程

```mermaid
sequenceDiagram
    actor User
    participant FE as Frontend
    participant WS as WebSocket
    participant MsgSvc as Message Service
    participant Adapter as Adapter Registry
    participant Claude as Claude Adapter
    participant DiffEngine as Diff Engine
    participant ProjectSvc as Project Service
    participant PG as PostgreSQL
    participant MinIO as MinIO

    User->>FE: 请求 "把Button改成蓝色"
    FE->>WS: emit("message:send")
    WS->>MsgSvc: create_message()
    MsgSvc->>EventBus: publish("agent:invoke")
    EventBus->>Claude: invoke_with_context(requirement, project_files)

    Claude->>Claude: 分析代码变更
    Claude-->>Adapter: response {tool_calls: [edit_file]}
    Adapter->>DiffEngine: generate_diff(file_path, old, new)
    DiffEngine->>ProjectSvc: get_file_content(project_id, path)
    ProjectSvc->>MinIO: read_object(path)
    MinIO-->>ProjectSvc: original_content
    ProjectSvc-->>DiffEngine: old_content
    DiffEngine->>DiffEngine: diff-match-patch(old, new)
    DiffEngine-->>Adapter: diff_patch

    Adapter->>PG: INSERT file_change
    PG-->>Adapter: change_id
    Adapter->>EventBus: publish("diff:generated", change)
    EventBus->>WS: emit("diff:generated")
    WS-->>FE: on("diff:generated")
    FE-->>User: 弹出Diff查看器

    User->>FE: 点击"查看Diff"
    FE->>FE: 渲染Monaco Diff Editor
    FE->>FE: 文件树 + 行级Diff展示
    User->>FE: 点击"接受变更"
    FE->>WS: emit("diff:apply")
    WS->>DiffEngine: apply_diff(change_id)
    DiffEngine->>ProjectSvc: write_file(path, new_content)
    ProjectSvc->>MinIO: update_object(path, new_content)
    DiffEngine->>PG: UPDATE file_change status=applied
    WS-->>FE: emit("diff:applied")
    FE-->>User: 显示"已应用"
```

### 5.5 网页预览流程

```mermaid
sequenceDiagram
    actor User
    participant FE as Frontend
    participant REST as REST API
    participant PreviewSvc as Preview Service
    participant Sandbox as Docker Sandbox
    participant BuildEngine as Build Engine
    participant MinIO as MinIO
    participant Nginx as Preview Nginx

    User->>FE: 点击"预览"
    FE->>REST: POST /api/v1/sessions/{id}/preview/build
    REST->>PreviewSvc: build_preview(session_id)

    PreviewSvc->>MinIO: get_project_files(project_id)
    MinIO-->>PreviewSvc: files[]
    PreviewSvc->>Sandbox: create_container(image="node:20", files)
    Sandbox-->>PreviewSvc: container_id

    PreviewSvc->>BuildEngine: build(container_id, files)
    BuildEngine->>BuildEngine: npm install
    BuildEngine->>BuildEngine: vite build
    BuildEngine-->>PreviewSvc: dist/

    PreviewSvc->>MinIO: upload_dist(dist/, preview_token)
    MinIO-->>PreviewSvc: public_url

    PreviewSvc->>Nginx: register_route(preview_token, public_url)
    Nginx-->>PreviewSvc: proxy_url

    PreviewSvc-->>REST: {preview_url, build_time}
    REST-->>FE: {code: 200, data: {url}}
    FE-->>User: iframe加载预览页面

    User->>FE: 切换移动端视图
    FE->>FE: iframe width=375px
    FE-->>User: 显示移动端预览
```

### 5.6 一键部署流程

```mermaid
sequenceDiagram
    actor User
    participant FE as Frontend
    participant REST as REST API
    participant DeploySvc as Deploy Service
    participant PreviewSvc as Preview Service
    participant VercelDeployer as Vercel Deployer
    participant VercelAPI as Vercel API
    participant PG as PostgreSQL

    User->>FE: 点击"一键部署到Vercel"
    FE->>REST: POST /api/v1/sessions/{id}/deploy
    REST->>DeploySvc: deploy(session_id, platform="vercel")

    DeploySvc->>PreviewSvc: get_build_artifact(session_id)
    PreviewSvc->>DeploySvc: dist.zip

    DeploySvc->>VercelDeployer: deploy(artifact, config)
    VercelDeployer->>VercelDeployer: validate_config(api_token, project_name)
    VercelDeployer->>VercelAPI: POST /v13/deployments
    VercelAPI-->>VercelDeployer: {deployment_id, url, state: "BUILDING"}

    loop 轮询部署状态
        VercelDeployer->>VercelAPI: GET /v13/deployments/{id}
        VercelAPI-->>VercelDeployer: {state: "BUILDING" | "READY" | "ERROR"}
    end

    VercelDeployer-->>DeploySvc: {deployment_id, url, status}
    DeploySvc->>PG: INSERT deployment record
    DeploySvc-->>REST: {code: 200, data: {url, status}}
    REST-->>FE: 显示部署结果
    FE-->>User: 展示可访问URL

    alt 部署失败
        VercelDeployer-->>DeploySvc: error
        DeploySvc->>DeploySvc: 自动重试1次
        DeploySvc->>VercelDeployer: retry
        VercelDeployer->>VercelAPI: 重新部署
    end
```

---

## 6. 任务列表

### T01: 项目基础设施与数据库层

**优先级**: P0  
**依赖**: 无  
**说明**: 搭建前后端项目骨架、数据库模型、迁移脚本、Docker环境

| 文件 | 说明 |
|:---|:---|
| `docker-compose.yml` | PostgreSQL + Redis + MinIO + Nginx + 后端 + 前端全栈编排 |
| `backend/requirements.txt` | Python依赖声明 |
| `backend/pyproject.toml` | Poetry/Setuptools配置 |
| `backend/alembic.ini` | Alembic迁移配置 |
| `backend/alembic/env.py` | 迁移环境 |
| `backend/app/main.py` | FastAPI应用入口、中间件挂载 |
| `backend/app/config.py` | Pydantic Settings配置管理 |
| `backend/app/dependencies.py` | 依赖注入容器 |
| `backend/app/exceptions.py` | 全局异常处理 |
| `backend/app/db/session.py` | SQLAlchemy异步Session |
| `backend/app/db/connection.py` | 数据库连接池 |
| `backend/app/models/base.py` | ORM基类 |
| `backend/app/models/user.py` | User模型 |
| `backend/app/models/session.py` | Session模型 |
| `backend/app/models/message.py` | Message模型 |
| `backend/app/models/agent.py` | Agent模型 |
| `backend/app/models/task.py` | Task模型 |
| `backend/app/models/project.py` | Project模型 |
| `backend/app/models/file_change.py` | FileChange模型 |
| `backend/app/schemas/*.py` | Pydantic Schema定义 |
| `frontend/package.json` | npm依赖声明 |
| `frontend/vite.config.ts` | Vite构建配置 |
| `frontend/tsconfig.json` | TypeScript配置 |
| `frontend/tailwind.config.js` | Tailwind配置 |
| `frontend/index.html` | 入口HTML |
| `frontend/src/main.tsx` | React应用入口 |
| `frontend/src/App.tsx` | 根组件 |
| `frontend/src/index.css` | 全局样式 |
| `frontend/src/types/*.ts` | TypeScript类型定义 |

### T02: 认证与会话管理层

**优先级**: P0  
**依赖**: T01  
**说明**: 用户认证、会话CRUD、WebSocket连接管理、消息基础接口

| 文件 | 说明 |
|:---|:---|
| `backend/app/utils/crypto.py` | AES-256加密工具 (API Key) |
| `backend/app/utils/jwt_helper.py` | JWT生成/验证 |
| `backend/app/core/auth_service.py` | 认证业务逻辑 |
| `backend/app/core/user_service.py` | 用户管理 |
| `backend/app/core/session_service.py` | 会话管理 |
| `backend/app/core/message_service.py` | 消息管理 |
| `backend/app/api/v1/auth.py` | 认证路由 |
| `backend/app/api/v1/users.py` | 用户路由 |
| `backend/app/api/v1/sessions.py` | 会话路由 |
| `backend/app/api/v1/messages.py` | 消息路由 |
| `backend/app/api/websocket/manager.py` | WebSocket连接池 |
| `backend/app/api/websocket/handlers.py` | WebSocket消息处理 |
| `backend/app/api/websocket/router.py` | WebSocket路由 |
| `frontend/src/stores/authStore.ts` | 认证状态管理 |
| `frontend/src/stores/sessionStore.ts` | 会话状态管理 |
| `frontend/src/stores/messageStore.ts` | 消息状态管理 |
| `frontend/src/api/auth.ts` | 认证API客户端 |
| `frontend/src/api/sessions.ts` | 会话API客户端 |
| `frontend/src/api/messages.ts` | 消息API客户端 |
| `frontend/src/hooks/useAuth.ts` | 认证Hook |
| `frontend/src/hooks/useWebSocket.ts` | WebSocket Hook |
| `frontend/src/pages/LoginPage.tsx` | 登录页 |
| `frontend/src/pages/RegisterPage.tsx` | 注册页 |
| `frontend/src/pages/ChatPage.tsx` | IM主界面框架 |
| `frontend/src/features/chat/SessionList.tsx` | 会话列表 |
| `frontend/src/features/chat/ChatContainer.tsx` | 聊天容器 |
| `frontend/src/features/chat/MessageList.tsx` | 消息列表 |
| `frontend/src/features/chat/MessageInput.tsx` | 消息输入框 |

### T03: 统一适配器层与核心聊天

**优先级**: P0  
**依赖**: T02  
**说明**: Agent适配器抽象、Claude/Codex适配器实现、MCP适配器、单聊/群聊完整功能

| 文件 | 说明 |
|:---|:---|
| `backend/app/adapters/base_adapter.py` | 适配器抽象基类 |
| `backend/app/adapters/adapter_registry.py` | 适配器注册表 |
| `backend/app/adapters/adapter_factory.py` | 适配器工厂 |
| `backend/app/adapters/claude_adapter.py` | Claude Code适配器 |
| `backend/app/adapters/codex_adapter.py` | Codex适配器 |
| `backend/app/adapters/mcp_adapter.py` | MCP协议适配器 |
| `backend/app/agents/agent_registry.py` | Agent注册表 |
| `backend/app/agents/agent_manager.py` | Agent生命周期 |
| `backend/app/agents/builtin_agents.py` | 内置Agent定义 |
| `backend/app/agents/agent_config.py` | Agent配置模型 |
| `backend/app/events/event_types.py` | 事件类型枚举 |
| `backend/app/events/event_bus.py` | Event Bus核心 |
| `backend/app/events/event_stream.py` | 事件流处理器 |
| `backend/app/events/handlers/*.py` | 事件处理器 |
| `backend/app/api/v1/agents.py` | Agent API路由 |
| `frontend/src/stores/orchestratorStore.ts` | Orchestrator状态 |
| `frontend/src/api/agents.ts` | Agent API客户端 |
| `frontend/src/hooks/useAgentRegistry.ts` | Agent注册Hook |
| `frontend/src/hooks/useChat.ts` | 聊天逻辑Hook |
| `frontend/src/hooks/useSSE.ts` | SSE流式响应Hook |
| `frontend/src/components/chat/MessageBubble.tsx` | 消息气泡 |
| `frontend/src/components/chat/CodeBlock.tsx` | 代码块渲染 |
| `frontend/src/components/chat/MarkdownRenderer.tsx` | Markdown渲染 |
| `frontend/src/components/chat/AgentMention.tsx` | @Agent提及 |
| `frontend/src/components/chat/TypingIndicator.tsx` | 输入指示器 |
| `frontend/src/components/chat/AgentLogPanel.tsx` | Agent日志面板 |
| `frontend/src/features/chat/GroupMemberList.tsx` | 群成员列表 |
| `frontend/src/pages/AgentStorePage.tsx` | Agent商店 |
| `frontend/src/features/agent/AgentCard.tsx` | Agent卡片 |
| `frontend/src/features/agent/AgentConfigForm.tsx` | Agent配置表单 |

### T04: Orchestrator、Diff与预览部署

**优先级**: P0 / P1  
**依赖**: T03  
**说明**: 任务拆解编排器、代码Diff引擎、沙箱预览、一键部署

| 文件 | 说明 |
|:---|:---|
| `backend/app/orchestrator/orchestrator.py` | 主编排器 |
| `backend/app/orchestrator/intent_classifier.py` | 意图分类器 |
| `backend/app/orchestrator/task_planner.py` | 任务规划器 |
| `backend/app/orchestrator/task_decomposer.py` | 任务拆解器 |
| `backend/app/orchestrator/agent_router.py` | Agent路由器 |
| `backend/app/orchestrator/agent_scheduler.py` | Agent调度器 |
| `backend/app/orchestrator/result_aggregator.py` | 结果聚合器 |
| `backend/app/orchestrator/context_manager.py` | 上下文管理器 |
| `backend/app/orchestrator/human_approval_gate.py` | 人工审批节点 |
| `backend/app/core/task_service.py` | 任务服务 |
| `backend/app/core/diff_service.py` | Diff服务 |
| `backend/app/core/preview_service.py` | 预览服务 |
| `backend/app/core/deploy_service.py` | 部署服务 |
| `backend/app/sandbox/sandbox.py` | 沙箱管理器 |
| `backend/app/sandbox/docker_runner.py` | Docker执行器 |
| `backend/app/sandbox/build_engine.py` | 前端构建引擎 |
| `backend/app/sandbox/security.py` | 安全策略 |
| `backend/app/deploy/deploy_manager.py` | 部署管理器 |
| `backend/app/deploy/vercel_deployer.py` | Vercel部署器 |
| `backend/app/deploy/netlify_deployer.py` | Netlify部署器 |
| `backend/app/utils/diff_utils.py` | Diff计算工具 |
| `backend/app/api/v1/tasks.py` | 任务API |
| `backend/app/api/v1/diff.py` | Diff API |
| `backend/app/api/v1/preview.py` | 预览API |
| `backend/app/api/v1/deploy.py` | 部署API |
| `frontend/src/api/tasks.ts` | 任务API客户端 |
| `frontend/src/api/diff.ts` | Diff API客户端 |
| `frontend/src/api/preview.ts` | 预览API客户端 |
| `frontend/src/api/deploy.ts` | 部署API客户端 |
| `frontend/src/features/diff/DiffViewer.tsx` | Diff查看器 |
| `frontend/src/features/diff/FileTree.tsx` | 文件树 |
| `frontend/src/features/diff/DiffActions.tsx` | Diff操作栏 |
| `frontend/src/features/preview/PreviewPanel.tsx` | 预览面板 |
| `frontend/src/features/preview/PreviewToolbar.tsx` | 预览工具栏 |
| `frontend/src/features/preview/DeviceSwitcher.tsx` | 设备切换 |
| `frontend/src/features/orchestrator/TaskTree.tsx` | 任务树组件 |
| `frontend/src/features/orchestrator/TaskNode.tsx` | 任务节点 |
| `frontend/src/features/orchestrator/TaskProgress.tsx` | 任务进度 |
| `frontend/src/features/orchestrator/OrchestratorPanel.tsx` | 编排器面板 |
| `frontend/src/features/orchestrator/HumanApprovalGate.tsx` | 审批门 |
| `frontend/src/components/layout/ResizablePanel.tsx` | 可调整面板 |

### T05: 集成测试、优化与部署配置

**优先级**: P1  
**依赖**: T04  
**说明**: 全链路集成、Docker镜像优化、性能调优、文档完善

| 文件 | 说明 |
|:---|:---|
| `Dockerfile` | 后端生产镜像 |
| `Dockerfile.frontend` | 前端生产镜像 |
| `nginx.conf` | Nginx反向代理配置 |
| `scripts/init_db.sh` | 数据库初始化脚本 |
| `scripts/migrate.sh` | 迁移脚本 |
| `scripts/seed_data.py` | 种子数据 |
| `backend/app/utils/logger.py` | 结构化日志 |
| `backend/app/utils/validators.py` | 输入校验器 |
| `frontend/src/components/common/ErrorBoundary.tsx` | 错误边界 |
| `frontend/src/components/layout/MainLayout.tsx` | 主布局 |
| `frontend/src/components/layout/Sidebar.tsx` | 侧边栏 |
| `frontend/src/components/layout/TopBar.tsx` | 顶部栏 |
| `frontend/src/utils/websocket.ts` | WebSocket工具 |
| `frontend/src/utils/formatters.ts` | 格式化工具 |
| `frontend/src/pages/SettingsPage.tsx` | 设置页 |
| `README.md` | 项目README |
| `.env.example` | 环境变量模板 |

### 任务依赖图

```mermaid
graph TD
    T01["T01: 项目基础设施<br/>与数据库层"] --> T02["T02: 认证与会话管理<br/>WebSocket连接"]
    T02 --> T03["T03: 统一适配器层<br/>单聊/群聊/@Agent"]
    T03 --> T04["T04: Orchestrator编排<br/>Diff + 预览 + 部署"]
    T04 --> T05["T05: 集成测试<br/>Docker部署优化"]

    style T01 fill:#ffcccc
    style T02 fill:#ffcccc
    style T03 fill:#ffcccc
    style T04 fill:#ccffcc
    style T05 fill:#ccffff
```

---

## 7. 依赖包列表

### 7.1 前端依赖 (package.json)

```json
{
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.22.0",
    "@mui/material": "^5.14.0",
    "@mui/icons-material": "^5.14.0",
    "@emotion/react": "^11.11.0",
    "@emotion/styled": "^11.11.0",
    "@monaco-editor/react": "^4.6.0",
    "zustand": "^4.5.0",
    "axios": "^1.6.0",
    "socket.io-client": "^4.7.0",
    "react-markdown": "^9.0.0",
    "remark-gfm": "^4.0.0",
    "react-syntax-highlighter": "^15.5.0",
    "diff-match-patch": "^1.0.5",
    "date-fns": "^3.0.0",
    "lodash-es": "^4.17.21",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "@types/lodash-es": "^4.17.0",
    "@types/uuid": "^9.0.0",
    "@types/diff-match-patch": "^1.0.36",
    "typescript": "^5.3.0",
    "vite": "^5.0.0",
    "@vitejs/plugin-react": "^4.2.0",
    "tailwindcss": "^3.3.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "eslint": "^8.55.0",
    "@typescript-eslint/eslint-plugin": "^6.15.0",
    "@typescript-eslint/parser": "^6.15.0",
    "prettier": "^3.1.0"
  }
}
```

### 7.2 后端依赖 (requirements.txt)

```
# Web Framework
fastapi==0.110.0
uvicorn[standard]==0.27.0
python-multipart==0.0.9

# WebSocket
python-socketio==5.11.0
websockets==12.0

# SSE
fastapi-sse==0.5.0

# Database
sqlalchemy[asyncio]==2.0.27
asyncpg==0.29.0
alembic==1.13.1
redis==5.0.1

# Pydantic & Validation
pydantic==2.6.1
pydantic-settings==2.1.0
email-validator==2.1.0

# Authentication
pyjwt==2.8.0
passlib[bcrypt]==1.7.4
python-jose[cryptography]==3.3.0
cryptography==42.0.0

# AI / LLM
openai==1.12.0
anthropic==0.18.0
langchain==0.1.0
langchain-openai==0.0.5

# MCP Protocol
mcp==0.4.0

# HTTP Client
httpx==0.26.0
aiohttp==3.9.1

# Diff & Code
diff-match-patch==20230430

# Docker SDK
docker==7.0.0

# Utilities
python-dotenv==1.0.0
structlog==24.1.0
orjson==3.9.0
tenacity==8.2.0

# Testing
pytest==8.0.0
pytest-asyncio==0.23.0
httpx==0.26.0

# Development
black==24.1.0
isort==5.13.0
mypy==1.8.0
```

---

## 8. 共享知识

### 8.1 代码风格

```
前端 (TypeScript/React):
- 使用函数组件 + Hooks，禁止使用Class组件
- 组件命名: PascalCase (MessageBubble.tsx)
- Hook命名: camelCase with "use" prefix (useWebSocket.ts)
- 状态管理: Zustand store文件用 camelCase + "Store"后缀
- 接口定义: I前缀可选，优先用描述性命名
- 文件组织: 每个组件一个目录，含index.tsx + styles.ts

后端 (Python):
- 遵循PEP 8，使用black格式化 (line-length: 100)
- import排序: isort (stdlib → third-party → local)
- 类型注解: 全部函数必须加类型注解
- 异步优先: 所有I/O操作使用async/await
- 异常: 自定义异常继承自AppException基类
```

### 8.2 命名规范

```
数据库表: 复数小写 + 下划线 (users, session_members)
Python类: PascalCase (SessionManager)
Python函数/变量: snake_case (create_message)
TypeScript接口: PascalCase (MessagePayload)
TypeScript类型: PascalCase with Type suffix (MessageType)
API路径: kebab-case (api/v1/session-members)
环境变量: UPPER_SNAKE_CASE (DATABASE_URL)
WebSocket事件: camelCase with colon (message:received)
```

### 8.3 错误处理策略

```python
# 后端统一响应格式
{
    "code": 0,           # 0=成功, >0=业务错误码
    "data": {...},       # 业务数据
    "message": "ok"      # 人类可读信息
}

# 错误码规范
# 1xxx: 通用错误
# 2xxx: 认证相关
# 3xxx: 会话/消息
# 4xxx: Agent/适配器
# 5xxx: 任务/Orchestrator
# 6xxx: Diff/预览/部署

# 异常层级
class AppException(Exception):
    def __init__(self, code: int, message: str, status_code: int = 400):
        ...

class AuthException(AppException): code=2001
class SessionException(AppException): code=3001
class AgentException(AppException): code=4001
class TaskException(AppException): code=5001
class DeployException(AppException): code=6001
```

### 8.4 日志规范

```python
# 使用structlog结构化日志
# 每个请求生成唯一trace_id，贯穿全链路

# 日志级别
DEBUG: 详细调试信息（开发环境）
INFO: 正常业务流程（登录、消息发送、任务完成）
WARNING: 非致命异常（Agent响应慢、重试）
ERROR: 业务异常（API调用失败、数据库错误）
CRITICAL: 系统级异常（数据库断开、沙箱逃逸）

# 必含字段
trace_id: 链路追踪ID
user_id: 操作用户
session_id: 关联会话
agent_id: 关联Agent（如有）
duration_ms: 操作耗时
```

### 8.5 WebSocket连接规范

```
1. 连接建立: 携带JWT Token作为query param (?token=xxx)
2. 心跳机制: 客户端每30s发送ping，服务端回复pong
3. 断线重连: 客户端自动重连，指数退避 (1s, 2s, 4s, 8s, max 30s)
4. 房间管理: 用户加入会话 = 订阅session:{id}频道
5. 消息顺序: 依赖服务端时间戳排序，客户端不做重排
6. 流式消息: SSE用于Agent流式响应，WebSocket用于状态推送
```

### 8.6 适配器接口契约

```python
# 所有适配器必须实现的统一接口
class BaseAdapter(ABC):
    @abstractmethod
    async def connect(self) -> bool: ...

    @abstractmethod
    async def disconnect(self) -> None: ...

    @abstractmethod
    async def send(
        self,
        messages: List[Message],
        context: Optional[Dict] = None
    ) -> AsyncIterator[Event]: ...

    @abstractmethod
    def get_capabilities(self) -> List[Capability]: ...

    @abstractmethod
    def health_check(self) -> bool: ...

# 事件类型统一枚举
class EventType(Enum):
    TEXT_DELTA = "text_delta"       # 文本增量
    TOOL_CALL = "tool_call"         # 工具调用
    TOOL_RESULT = "tool_result"     # 工具结果
    THINKING = "thinking"           # 思考过程
    ERROR = "error"                 # 错误
    COMPLETE = "complete"           # 完成
    LOG = "log"                     # 执行日志
```

### 8.7 数据库设计约定

```
- 所有表必须有: id (UUID, PK), created_at, updated_at
- 软删除: is_deleted字段 (不物理删除)
- 外键约束: 所有关系必须声明外键
- 索引策略: 查询频率高的字段必须建索引
- JSON字段: 使用PostgreSQL JSONB类型，配合GIN索引
- 分区策略: 消息表按session_id哈希分区（预留）
```

---

## 9. 待明确事项

基于PRD中的Open Questions，从架构层面给出建议决策：

| 编号 | 问题 | 架构建议决策 | 理由 |
|:---|:---|:---|:---|
| **OQ-001** | 用户自带API Key还是平台统一提供？ | **支持双模式**：平台提供默认Key（演示用），用户可配置个人Key（生产用） | 比赛演示时不需要观众注册API Key；生产环境用户自有Key可降低成本 |
| **OQ-002** | 群聊Agent串行还是并行响应？ | **默认并行，支持串行模式**。@多个Agent时并行；Agent间有依赖时串行 | 并行提升响应速度，串行保证逻辑正确性。由Orchestrator的Scheduler决定 |
| **OQ-003** | 预览构建在服务端还是客户端？ | **服务端构建（Docker Sandbox）** | 安全性（代码隔离）、资源可控（限制CPU/内存）、支持npm生态（需要Node.js） |
| **OQ-004** | 一键部署支持哪些平台？ | **P0: Vercel；P1: Netlify** | Vercel API最成熟，对前端项目支持最好。Netlify作为备选 |
| **OQ-005** | 本地运行还是纯Web应用？ | **纯Web应用（优先），预留桌面端扩展接口** | 比赛提交要求公网可访问，Web应用最符合。后续可通过Tauri封装桌面端 |
| **OQ-006** | 沙箱资源限制？ | **CPU: 1核, 内存: 1GB, 时长: 5分钟, 网络: 禁止出站** | 平衡安全性与功能性。构建超时5分钟足够大多数前端项目 |
| **OQ-007** | 语音消息支持？ | **P2功能，架构预留接口** | 比赛时间有限，优先核心功能。Web Speech API可作为低成本实现方案 |
| **OQ-008** | Agent通信协议：自研 vs A2A/MCP？ | **MCP作为工具接入标准，A2A作为跨Agent通信标准，自研Event Stream作为内部通信** | 三层协议栈：对内Event Stream，对外MCP/A2A。既兼容标准又保持灵活性 |
| **OQ-009** | 多人实时协作编辑？ | **P2功能，架构预留但本轮不实现** | 需要OT/CRDT算法，复杂度极高。当前版本采用"独占编辑+Diff申请"模式 |
| **OQ-010** | Demo预设场景？ | **场景1: Todo应用（全栈）** 覆盖单聊→群聊→代码→预览→部署全链路 | Todo应用足够展示所有核心功能，复杂度可控 |

---

## 10. 创新点设计

### 10.1 架构层面创新

#### 创新点 1: **三层协议栈统一适配层** ⭐核心创新

```
┌──────────────────────────────────────────────────────────────┐
│                    AgentHub 三层协议栈                         │
├──────────────────────────────────────────────────────────────┤
│  Layer 3: Event Stream (内部通信)                             │
│  • 借鉴Agent TARS的Event Stream架构                          │
│  • 所有Agent行为序列化为结构化Event                          │
│  • 支持回放、调试、可观测性                                  │
├──────────────────────────────────────────────────────────────┤
│  Layer 2: MCP (工具接入标准)                                  │
│  • 统一接入文件系统、浏览器、数据库等外部工具                │
│  • Claude Code/Codex的工具调用均通过MCP Hub                  │
├──────────────────────────────────────────────────────────────┤
│  Layer 1: A2A (跨Agent通信)                                   │
│  • Agent间通过A2A标准协议互操作                              │
│  • 支持AgentCard能力发现                                     │
│  • 可对接外部A2A兼容Agent                                    │
└──────────────────────────────────────────────────────────────┘
```

**与竞品差异化**：AutoGen/CrewAI没有协议分层概念，LangGraph没有A2A/MCP兼容。AgentHub是业界首个同时集成Event Stream + MCP + A2A三层协议的平台。

#### 创新点 2: **Orchestrator 智能路由引擎**

```python
# 多维度Agent匹配算法
class AgentRouter:
    def match(self, task: Task, agents: List[Agent]) -> Agent:
        scores = {}
        for agent in agents:
            score = 0.0
            # 维度1: 能力匹配度 (语义嵌入)
            score += self.capability_similarity(task, agent) * 0.4
            # 维度2: 历史成功率
            score += self.historical_success_rate(agent, task.type) * 0.25
            # 维度3: 当前负载
            score += self.load_balance_score(agent) * 0.20
            # 维度4: 上下文连续性
            score += self.context_continuity(task, agent) * 0.15
            scores[agent.id] = score
        return max(scores, key=scores.get)
```

**比赛亮点**：动态路由算法结合了语义匹配、历史数据、负载均衡、上下文连续性四个维度，远超简单轮询或静态映射。

#### 创新点 3: **实时成本透明仪表板**

```
每个Session实时展示:
├── Token消耗: Input/Output分离统计
├── API调用次数: 按Agent/按时间维度
├── 响应延迟热力图
├── 费用估算 (基于各平台定价)
└── 历史趋势对比

架构实现:
├── Adapter拦截所有LLM调用
├── 统一记录token用量、latency、cost
├── Event Bus广播到前端仪表板
└── Redis时序数据结构聚合统计
```

**比赛亮点**：竞品几乎没有成本控制可视化。这既是功能亮点，也体现了工程设计的完整性。

### 10.2 技术实现创新

| 创新点 | 技术方案 | 评分优势 |
|:---|:---|:---|
| **Event Stream全链路追踪** | 所有Agent操作生成结构化Event，支持倍速回放 | 可视化创新性(13分) + Agent架构(20分) |
| **智能上下文压缩** | LLM对话超过上下文窗口时，自动摘要历史消息 | Agent架构设计深度 |
| **人机协同审批节点** | Orchestrator在关键步骤自动暂停，等待人工确认 | 功能完整度(25分) |
| **代码沙箱动态隔离** | 每个预览/部署请求创建独立Docker容器，秒级销毁 | 安全需求 + 工程规范 |
| **流式Diff生成** | Agent回复过程中实时检测代码变更，边回复边生成Diff | 可视化创新性 |
| **Agent能力雷达图** | 前端可视化展示各Agent的能力分布和置信度 | 可视化创新性 |

### 10.3 演示策略建议

**Demo黄金路径**（90秒完整演示）：

```
1. [0-10s]  登录 → 进入AgentHub主界面
2. [10-20s] 创建群聊，邀请 FrontendAgent + BackendAgent
3. [20-40s] 发送 "@Orchestrator 创建一个带登录的Todo应用"
4. [40-55s] Orchestrator实时拆解任务树，Agent并行协作
5. [55-70s] 查看代码Diff，接受修改
6. [70-80s] 实时预览网页效果
7. [80-90s] 一键部署到Vercel，展示线上URL
```

---

## 附录 A: 核心评分对标

| 评分维度 | 满分 | AgentHub设计对应点 |
|:---|:---|:---|
| 文档完整性与可复现性 | 15 | PRD + ARCHITECTURE + docker-compose一键启动 |
| 功能实现完整度 | 25 | P0全实现 + P1核心功能 + P2预留架构 |
| 可视化创新性 | 13 | Event Stream回放、成本仪表板、Agent雷达图、TaskTree可视化 |
| **Agent架构设计** | **20** | **三层协议栈、统一适配器、智能路由、上下文压缩** |
| 代码质量与工程规范 | 17 | 类型安全、结构化日志、依赖注入、测试覆盖 |
| 创新与自由发挥 | 10 | MCP+A2A双协议、人机协同审批、成本透明 |
| **合计** | **100** | **目标冲刺90+分** |

---

*文档结束*
