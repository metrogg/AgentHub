# Coze 3.0 技术架构分析

> 基于官网公开信息、GitHub 开源仓库、技术博客和竞品分析推断

---

## 1. 整体架构推断

### 1.1 前端架构

| 端 | 技术栈推断 | 依据 |
|----|-----------|------|
| **桌面端** | Electron + React/Vue | 系统级工作台，可访问本地文件 |
| **Web 端** | React + TypeScript | 可视化工作流编排，现代 SPA |
| **移动端** | React Native / Flutter | 跨端任务同步，遥控电脑文件 |

### 1.2 后端架构

Coze 采用 **Golang 微服务架构**，遵循 **DDD（领域驱动设计）** 原则：

```
┌─────────────────────────────────────────────────────────┐
│                      API Gateway                          │
│                    (统一入口 + 鉴权)                       │
├─────────────────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │ 用户服务  │ │ Agent服务 │ │ 项目服务  │ │ 消息服务  │   │
│  │ (User)   │ │ (Agent)  │ │ (Project)│ │ (Message)│   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘   │
│       │            │            │            │          │
│  ┌────┴────────────┴────────────┴────────────┴─────┐    │
│  │              Event Bus / Message Queue            │    │
│  │              (Redis Stream / RabbitMQ)           │    │
│  └──────────────────────┬────────────────────────────┘   │
│                         │                                │
│  ┌──────────────────────┴────────────────────────────┐   │
│  │ 数据层                                             │   │
│  │  ┌────────┐ ┌──────────┐ ┌──────────┐           │   │
│  │  │ MySQL  │ │Elasticsearch│ │  MinIO   │           │   │
│  │  │(关系数据)│ │(向量检索)   │ │(对象存储)│           │   │
│  │  └────────┘ └──────────┘ └──────────┘           │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**核心服务**：
- **用户服务**：认证、权限、用户画像
- **Agent 服务**：Agent 定义、模型配置、技能管理、长期记忆
- **项目服务**：项目 CRUD、资产沉淀、文件管理
- **消息服务**：群聊消息、Thread 管理、消息路由、预算计数
- **编排服务**：工作流编排、多 Agent 调度、任务分解
- **沙箱服务**：云端开发环境、容器管理、部署流水线
- **视频服务**：Seedance 2.0 集成、视频生成、导出剪映

### 1.3 数据层

| 存储 | 用途 | 推断技术 |
|------|------|---------|
| **MySQL** | 配置存储、用户数据、项目元数据、Agent 定义 | 关系型数据库 |
| **Elasticsearch** | 向量检索、知识库搜索、语义搜索 | 全文检索 + 向量检索 |
| **MinIO** | 对象存储、文件上传、视频产物、项目资产 | S3-compatible |
| **Redis** | 在线状态、消息缓存、预算计数、速率限制 | 热数据缓存 |
| **PostgreSQL** | 消息历史、会话数据、审计日志 | 关系型数据库（可选） |

### 1.4 部署架构

```
┌────────────────────────────────────────────┐
│              CDN + 负载均衡                    │
│              (域名 + SSL 证书)               │
└────────────────────┬───────────────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
   ┌────┴──┐   ┌────┴──┐   ┌────┴──┐
   │  Web  │   │ Desktop│   │ Mobile│
   │ 前端  │   │ 桌面端 │   │ 移动端 │
   └──┬───┘   └──┬───┘   └──┬───┘
       │         │          │
       └─────────┬──────────┘
                 │
        ┌────────┴────────┐
        │   API Gateway   │
        │   (K8s Ingress) │
        └────────┬────────┘
                 │
        ┌────────┴────────┐
        │   K8s Cluster   │
        │  ┌───────────┐  │
        │  │ Microservices│ │
        │  │ (Docker Pods)│ │
        │  └───────────┘  │
        └─────────────────┘
```

**关键部署特性**：
- 支持 Docker Compose 一键部署（最低配置：双核 CPU + 4GB 内存）
- 支持 Kubernetes 集群部署（企业级）
- 支持私有化部署（数据本地，敏感行业适用）
- 云手机 + 云电脑服务（火山引擎基础设施）

---

## 2. 多模型网关设计

### 2.1 统一适配层

Coze 支持 Doubao-Seed / Kimi / GLM / Minimax / DeepSeek / Qwen / Gemini 等 10+ 模型，推断其设计了一个 **统一 LLM 适配层**：

```typescript
// 推断的 LLM Gateway 设计
interface LLMProvider {
  name: string;
  baseURL: string;
  models: string[];
  authType: 'token' | 'oauth' | 'api_key';

  // 统一调用接口
  chatCompletion(params: ChatParams): Promise<ChatResult>;
  streamCompletion(params: ChatParams): AsyncGenerator<ChatChunk>;

  // 能力检测
  supportsFeature(feature: string): boolean;
}

class LLMGateway {
  private providers: Map<string, LLMProvider> = new Map();

  // 注册模型提供商
  registerProvider(config: ProviderConfig): void {
    this.providers.set(config.name, createProvider(config));
  }

  // 统一调用
  async call(params: {
    model: string;           // 如 "doubao-seed", "gpt-4o", "claude-sonnet"
    messages: Message[];
    temperature?: number;
    responseFormat?: string;
  }): Promise<ChatResult> {
    const provider = this.resolveProvider(params.model);
    return provider.chatCompletion(params);
  }

  // 模型切换策略
  resolveProvider(model: string): LLMProvider {
    // 优先使用用户指定的模型
    // 若不可用，fallback 到默认模型
    // 考虑成本、延迟、质量等因素
  }
}
```

### 2.2 模型配置隔离

每个 Agent 可以独立配置模型：

```yaml
# 推断的 Agent 模型配置格式
agents:
  CoordinatorAgent:
    model: doubao-pro-128k
    temperature: 0.3
    system_prompt: prompts/coordinator.txt

  FrontendAgent:
    model: claude-3-5-sonnet
    api_key: ${CLAUDE_KEY}
    temperature: 0.7

  BackendAgent:
    model: gpt-4o
    api_key: ${OPENAI_KEY}
    temperature: 0.5

  DataAgent:
    model: deepseek-v3
    base_url: https://api.deepseek.com
    temperature: 0.2
```

### 2.3 API 密钥管理

- 每个 Agent 独立的 API Key（环境变量隔离）
- 支持密钥轮换（自动检测过期并切换备用密钥）
- 密钥加密存储（KMS 或 HashiCorp Vault）
- 成本追踪：按 Agent 统计 API 调用费用

---

## 3. 云端沙箱环境

### 3.1 开发沙箱推断

Coze 的 "扣子编程" 功能提供云端开发环境，推断技术方案：

```
┌─────────────────────────────────────────┐
│           用户请求：开发一个网页           │
│                   ↓                     │
│         ┌───────────────┐               │
│         │  编排服务     │               │
│         │  (任务分解)   │               │
│         └───────┬───────┘               │
│                 │                       │
│         ┌───────┴───────┐               │
│         ▼               ▼               │
│  ┌────────────┐  ┌────────────┐         │
│  │ 沙箱 Pod 1 │  │ 沙箱 Pod 2 │         │
│  │ (Frontend) │  │ (Backend)  │         │
│  │            │  │            │         │
│  │ 文件系统    │  │ 文件系统    │         │
│  │ 终端       │  │ 终端       │         │
│  │ 预览服务   │  │ API 服务   │         │
│  └──────┬─────┘  └──────┬─────┘         │
│         │               │               │
│         └───────┬───────┘               │
│                 │                       │
│         ┌───────┴───────┐               │
│         │   部署服务    │               │
│         │  (域名+SSL)   │               │
│         └───────────────┘               │
└─────────────────────────────────────────┘
```

**推断技术方案**：
- **容器隔离**：每个开发任务一个独立的 Docker 容器
- **文件系统**：容器内挂载临时存储卷，任务完成后归档到 MinIO
- **终端**：Web Terminal（基于 xterm.js + WebSocket）
- **预览服务**：容器内运行 Vite dev server，通过反向代理暴露外网 URL
- **数据库集成**：每个项目分配一个独立的 PostgreSQL schema 或 SQLite 文件
- **对象存储**：MinIO 作为 S3-compatible 存储，存放用户上传的资源和产物

### 3.2 一键部署链路

```
代码完成 → 构建镜像 → 推送仓库 → 配置域名 → 申请 SSL → 部署到 K8s → 返回 URL
   │         │           │          │          │          │         │
   │         │           │          │          │          │         └─ 用户获得 https://xxx.coze.cn
   │         │           │          │          │          └─ kubectl apply
   │         │           │          │          └─ Let's Encrypt 自动签发
   │         │           │          └─ DNS 配置（泛域名 *.coze.cn）
   │         │           └─ Docker Registry
   │         └─ Docker build
   └─ 用户点击 "部署"
```

---

## 4. 长期记忆系统

### 4.1 推断的架构

```
┌─────────────────────────────────────────┐
│           长期记忆系统                    │
│                                         │
│  ┌──────────────┐  ┌──────────────┐     │
│  │ 用户画像     │  │ 项目知识库    │     │
│  │ (User Profile)│  │ (Project KB) │     │
│  └──────┬───────┘  └──────┬───────┘     │
│         │                  │             │
│  ┌──────┴──────┐  ┌──────┴──────┐       │
│  │ 向量数据库   │  │ 图数据库     │       │
│  │ (ES/Milvus) │  │ (Neo4j)     │       │
│  │             │  │             │       │
│  │ 对话摘要向量 │  │ Agent关系图  │       │
│  │ 偏好向量     │  │ 项目依赖图   │       │
│  │ 技能向量     │  │ 知识关联图   │       │
│  └─────────────┘  └─────────────┘       │
│                                         │
│  ┌────────────────────────────────────┐ │
│  │         记忆更新管道               │ │
│  │  对话 → 摘要 → 向量化 → 存储 → 检索 │ │
│  └────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

**推断实现细节**：
- **对话摘要**：每次对话结束后，LLM 自动生成摘要，提取关键信息
- **偏好学习**：用户选择、修改、反馈被记录为偏好向量
- **知识积累**：项目中的文档、代码、产物被索引到知识库
- **跨项目共享**：公共知识库（如通用编程知识）vs 项目私有知识库

---

## 5. 技能系统

### 5.1 / 命令触发机制

Coze 的 "技能引用" 功能，输入 `/` 快速引用技能或文件，推断实现：

```typescript
// 技能注册
interface Skill {
  id: string;
  name: string;           // 如 "web_search", "code_interpreter"
  icon: string;
  description: string;
  trigger: string;        // 触发词，如 "/search"
  handler: SkillHandler;  // 处理函数
  permissions: string[];  // 需要的权限
}

// 技能注册中心
class SkillRegistry {
  private skills: Map<string, Skill> = new Map();

  register(skill: Skill): void {
    this.skills.set(skill.trigger, skill);
  }

  // 解析用户输入中的 / 命令
  parseCommand(input: string): { command: string; args: string } | null {
    const match = input.match(/^\/([\w-]+)\s*(.*)$/);
    if (!match) return null;
    return { command: match[1], args: match[2] };
  }

  async execute(command: string, args: string, context: ExecutionContext): Promise<SkillResult> {
    const skill = this.skills.get('/' + command);
    if (!skill) throw new Error(`Unknown command: ${command}`);
    return skill.handler(args, context);
  }
}
```

### 5.2 技能包分发

```
技能市场（官方）
  ├── 编程技能包
  │     ├── code_interpreter
  │     ├── git_manager
  │     └── deploy_tool
  ├── 办公技能包
  │     ├── email_sender
  │     ├── calendar_sync
  │     └── document_parser
  └── 行业技能包
        ├── medical_diagnosis
        ├── legal_analysis
        └── financial_report
```

---

## 6. 跨端同步

### 6.1 推断的同步机制

```
桌面端 ──WebSocket──┐
                    │
Web 端 ───WebSocket──┼──→ 消息同步服务 ──→ Redis Pub/Sub ──→ 各端
                    │
移动端 ──WebSocket──┘
```

**同步内容**：
- 消息实时同步（WebSocket）
- 任务状态同步（Server-Sent Events）
- 文件传输（WebRTC P2P / 服务器中转）
- 项目资产同步（增量同步，基于版本号）

### 6.2 本地文件授权

桌面端 Agent 访问本地文件的桥接方案推断：

```typescript
// 桌面端本地文件桥接
class LocalFileBridge {
  // 用户授权后，Agent 可以读取本地文件
  async requestAccess(path: string): Promise<boolean> {
    // 弹出系统授权对话框
    return nativeAPI.showFileAccessDialog(path);
  }

  async readFile(path: string): Promise<string> {
    if (!await this.hasAccess(path)) throw new Error('No access');
    return nativeAPI.readFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (!await this.hasAccess(path)) throw new Error('No access');
    return nativeAPI.writeFile(path, content);
  }
}
```

---

## 7. 复刻技术方案

### 7.1 推荐技术栈

| 模块 | 推荐技术 | 理由 |
|------|---------|------|
| **前端** | React 18 + Vite + Tailwind CSS | 生态成熟，组件化适合 IM UI |
| **桌面端** | Tauri（Rust + Web） | 比 Electron 更轻量，更安全 |
| **后端** | Node.js + Fastify / Golang + Gin | 高并发，异步友好 |
| **数据库** | PostgreSQL + Redis | 关系型 + 缓存 |
| **向量检索** | pgvector / Milvus | 知识库语义搜索 |
| **对象存储** | MinIO | S3-compatible，轻量 |
| **消息队列** | Redis Stream / RabbitMQ | 可靠投递 |
| **容器** | Docker + Docker Compose | 一键部署 |
| **LLM 网关** | 自研适配器层 | 统一接口，支持多厂商 |

### 7.2 实现难度评估

| 功能 | 难度 | 估计工期 |
|------|------|---------|
| 群聊对话流 + 消息路由 | ⭐⭐ | 1 周 |
| @mention 调度 + Agent 接入 | ⭐⭐⭐ | 1 周 |
| 项目制管理 | ⭐⭐ | 3 天 |
| 产物预览（iframe + 代码） | ⭐⭐⭐ | 1 周 |
| 多模型网关 | ⭐⭐⭐⭐ | 2 周 |
| 云端沙箱环境 | ⭐⭐⭐⭐⭐ | 3 周+ |
| 长期记忆系统 | ⭐⭐⭐⭐ | 2 周 |
| 技能系统 | ⭐⭐⭐ | 1 周 |
| 跨端同步 | ⭐⭐⭐⭐ | 2 周 |
| 一键部署 | ⭐⭐⭐⭐ | 2 周 |

### 7.3 MVP 复刻路径

**Phase 1（2 周）：核心群聊 + 基础 Agent**
- 群聊对话流（React + Socket.io）
- @mention 调度（MessageRouter）
- 2 个 Agent 接入（Frontend + Backend）
- 产物预览（iframe + CodeBlock）
- 项目创建和切换

**Phase 2（2 周）：Orchestrator + 质量**
- Orchestrator 自动调度（意图分析 + 任务分解）
- 审阅-迭代流程
- 讨论预算控制
- 多模型网关（至少 2 个模型）

**Phase 3（2 周）：扩展功能**
- 技能系统（/ 命令）
- 云端沙箱（简单版本）
- 长期记忆（对话摘要）
- 跨端同步（Web + 桌面）

---

## 8. 开源参考

### 8.1 Coze 官方开源

| 项目 | 地址 | 技术栈 | 用途 |
|------|------|--------|------|
| Coze Studio | github.com/coze-dev/coze-studio | React + Golang | 可视化 Agent 开发平台 |
| Coze Loop | github.com/coze-dev/coze-loop | Golang + K8s | Agent 全生命周期管理 |
| Coze Python SDK | github.com/coze-dev/coze-py | Python | API 调用 SDK |
| Coze Java SDK | github.com/coze-dev/coze-java | Java | API 调用 SDK |

### 8.2 同类开源项目参考

| 项目 | Stars | 技术栈 | 特点 |
|------|-------|--------|------|
| ChatDev 2.0 | 15K+ | Vue 3 + FastAPI | 零代码多 Agent 平台，已支持 OpenClaw |
| Multica | 15.8K | TypeScript | "虚拟员工" 管理，任务分配 + 技能积累 |
| AgentVerse | 4.9K | Python | 并行工作流多 Agent 协作 |
| Hiclaw | 1.9K | Shell | 基于 IM 的多 Agent 协作，人机协同 |
| Agent Chat UI | 1K+ | Next.js | LangGraph 聊天前端 |
| pi-multi-agent | 500+ | TypeScript | WebSocket 企业级 A2A 通信 |
| Entire | 新 | 未知 | 前 GitHub CEO 开源，人类-Agent 协作平台 |

---

> **免责声明**：以上技术架构分析基于 Coze 官网公开信息、GitHub 开源仓库、技术博客和竞品分析推断，非官方技术文档。实际实现可能有差异。
