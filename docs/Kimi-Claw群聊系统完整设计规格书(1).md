# Kimi Claw 群聊系统完整设计规格书

> **版本**：v1.0 — 可 100% 复刻版
> **日期**：2026-06-02
> **总页数**：约 4600 行，涵盖 26 个章节
> **目标读者**：负责复刻 Kimi Claw 群聊协作系统的开发者、架构师、产品经理

---

## 总纲

本文档分为五大部分，共 26 章：

- **Part 1 — 架构与角色**（产品视角）：系统架构总览、数据流与消息流转、角色权限矩阵
- **Part 2 — 交互机制**（产品视角）：消息可见性、Thread 机制、审阅迭代、预算收敛、沉默检查、Worker 对话
- **Part 3 — Prompt 工程**（产品视角）：Coordinator Prompt、Worker Prompt、风格约束、收敛信号
- **Part 4 — 技术架构**（技术视角）：模块职责与接口、数据库 Schema、状态机设计
- **Part 5 — API 与通信**（技术视角）：REST API、前端组件、Socket.io 协议
- **Part 6 — 工程与部署**（技术视角）：技能系统、安全模型、Docker 部署、测试方案
- **Part 7 — 附录**：竞品对比、设计决策记录、MVP 复刻路径

---

> **版本**：v1.0 — 可复刻版
> **日期**：2026-06-02
> **技术栈**：React + Node.js + Socket.io + SQLite（MVP 阶段）
> **目标读者**：负责复刻 Kimi Claw 群聊协作系统的开发者与架构师
> **阅读建议**：Part 1 解决"系统长什么样"，Part 2 解决"交互怎么跑"，Part 3 解决"Prompt 怎么写"。

---

## 目录

- [Part 1 — 架构与角色](#part-1--架构与角色)
  - [1. 系统架构总览](#1-系统架构总览)
  - [2. 数据流与消息流转](#2-数据流与消息流转)
  - [3. 角色权限矩阵](#3-角色权限矩阵)
- [Part 2 — 交互机制](#part-2--交互机制)
  - [4. 消息可见性规则](#4-消息可见性规则)
  - [5. Thread 机制](#5-thread-机制)
  - [6. 审阅-迭代流程](#6-审阅-迭代流程)
  - [7. 讨论预算与收敛机制](#7-讨论预算与收敛机制)
  - [8. 沉默检查与超时处理](#8-沉默检查与超时处理)
  - [9. Worker-to-Worker 有限对话](#9-worker-to-worker-有限对话)
- [Part 3 — Prompt 工程](#part-3--prompt-工程)
  - [10. Coordinator System Prompt](#10-coordinator-system-prompt)
  - [11. Worker System Prompt](#11-worker-system-prompt)
  - [12. 风格约束 Prompt](#12-风格约束-prompt)
  - [13. 收敛信号规范](#13-收敛信号规范)

---

# Part 1 — 架构与角色

---

## 1. 系统架构总览

### 1.1 设计理念

Kimi Claw 不是"多个 AI 在同一个聊天框里抢话"，而是**指挥者-工作者模型（Coordinator-Worker Model）**的严格实现：

- **Worker 不是对等节点**。它们的上下文范围不是全局的，而是由 Coordinator 的 `@mention` 显式授权决定。没有 `@` 的 Worker，即使在群里，也看不到消息、不会主动回复。
- **讨论有预算**。每个 Thread 分配 10 turn 对话上限，防止无限发散。
- **质量有把关**。Greenlight / Feedback 审阅 + 最多 3 轮迭代，确保交付物达标。
- **协作有隔离**。Thread 机制将并行子任务隔离到独立空间，防止主群消息泛滥和任务间信息污染。

### 1.2 三层架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                        第一层：交互层（Interaction Layer）               │
│  ┌─────────────┐  ┌──────────────────────────────────────────────┐  │
│  │ Kimi 桌面端  │  │ Electron 前端：群聊 UI、消息渲染、产物卡片预览      │  │
│  │   App       │  │ 承载 OpenClaw Gateway 子进程，本地运行               │  │
│  └─────────────┘  └──────────────────────────────────────────────┘  │
│                                                                     │
│  技术：Electron + React（渲染进程）                                   │
└─────────────────────────────────────────────────────────────────────┘
                                    │ IPC / WebSocket
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        第二层：网关层（Gateway Layer）                  │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ OpenClaw Gateway — Node.js 守护进程                              │  │
│  │                                                                │  │
│  │ 职责：                                                         │  │
│  │ 1. 消息路由（Message Routing）：解析 @mention，按可见性规则分发      │  │
│  │ 2. Session 管理：维护多个 LLM 会话实例的生命周期                    │  │
│  │ 3. Tool 调度：协调各 Worker 的工具调用（文件读写、网络请求等）        │  │
│  │ 4. 心跳维护：检测 Agent 在线/离线状态                             │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  技术：Node.js + Express + Socket.io                                │
└─────────────────────────────────────────────────────────────────────┘
                                    │ 内部 API / 消息队列
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        第三层：智能层（Intelligence Layer）             │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐     │
│  │ Coordinator│  │ Worker A   │  │ Worker B   │  │ Worker C   │     │
│  │  Session   │  │  Session   │  │  Session   │  │  Session   │     │
│  │            │  │（Frontend）│  │（Backend） │  │（Data）    │     │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘     │
│                                                                     │
│  每个 Session = 一个独立的 LLM 实例，持有独立的上下文窗口              │
│  技术：OpenAI SDK 适配器 / Claude API / 其他模型 Provider              │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.3 各层级职责详表

| 层级 | 核心职责 | 关键组件 | 通信方式 |
|------|---------|---------|---------|
| **交互层** | 渲染群聊 UI、展示消息气泡、处理用户输入、渲染产物卡片 | Electron 主进程 / React 渲染进程 | 与 Gateway 通过 IPC（本地）或 WebSocket（远程）通信 |
| **网关层** | 消息路由分发、Session 生命周期管理、工具权限控制、心跳检测 | OpenClaw Gateway / MessageRouter / SessionManager | 接收前端消息 → 转发给智能层 → 接收 Worker 回复 → 回传前端 |
| **智能层** | 理解用户意图、执行任务、生成回复、调用工具 | Coordinator Session / Worker Sessions | 通过 Gateway 的抽象接口收发消息，不直接感知其他 Session |

### 1.4 技术栈（MVP）

| 组件 | 技术选型 | 选型理由 |
|------|---------|---------|
| 前端框架 | React 18 + Vite | 组件化适合 IM UI，Vite 热更新快 |
| 前端状态 | Zustand | 轻量、无样板代码，适合聊天消息列表的频繁更新 |
| 前端样式 | Tailwind CSS | 原子化 CSS，快速迭代聊天气泡样式 |
| 实时通信 | Socket.io | WebSocket 封装成熟，自动降级 HTTP 长轮询，房间机制天然适合群聊 |
| 网关服务 | Node.js + Express | 异步 I/O 友好，IM 高并发场景适合 |
| 数据库 | SQLite | MVP 零配置，单文件，足够支撑消息历史和任务状态 |
| 代码编辑 | Monaco Editor | VS Code 同款，Diff 视图、语法高亮、自动补全 |
| LLM 调用 | OpenAI SDK 适配器模式 | 兼容多模型（GPT-4 / Claude / Kimi），统一接口 |

### 1.5 注意事项

1. **Gateway 是单点，但不是瓶颈**：MVP 阶段一个 Gateway 实例足够。若需水平扩展，将 Gateway 拆分为"接入网关"（WebSocket）+ "逻辑网关"（消息路由），中间用 Redis Stream 解耦。
2. **Electron 的 IPC 限制**：前端 React 进程不能直接调用 Node.js API，所有文件操作、网络请求必须通过 Gateway 代理。防止前端代码逃逸。
3. **Session 不是线程**：每个 Session 对应一个 LLM API 调用上下文，不是操作系统线程。不要混用"线程"和"Session"两个概念。
4. **SQLite 并发写限制**：MVP 阶段读多写少，SQLite 足够。若群聊消息量 > 1000 条/分钟，升级到 PostgreSQL。

---

## 2. 数据流与消息流转

### 2.1 设计理念

消息流转是群聊系统的"血液循环"，设计目标是：

- **每条消息都有明确的发送者和可见范围**：不是广播给所有人，而是按规则精确分发。
- **Worker 的上下文只包含它需要看到的消息**：防止信息过载、防止任务污染、减少 Token 消耗。
- **数据格式统一**：Gateway 作为翻译层，将各前端消息格式和各后端 LLM API 格式统一为内部标准格式。

### 2.2 数据格式定义

#### 2.2.1 内部标准消息格式（Gateway 层流通）

```typescript
interface InboundMessage {
  id: string;              // 全局唯一消息 ID，UUIDv4
  chatId: string;          // 所属群聊/会话 ID
  threadId?: string;       // 所属 Thread ID（可选）
  sender: {
    type: "user" | "coordinator" | "worker";
    shortId: string;       // 发送者短 ID，如 "u_xxx" / "b_xxx"
    name: string;           // 显示名称
  };
  content: string;         // 消息正文（Markdown / 纯文本）
  contentType: "text" | "code" | "artifact" | "system" | "diff";
  mentions: string[];      // 消息中 @到的 shortId 列表
  timestamp: number;       // 毫秒时间戳
  metadata: {
    taskId?: string;       // 关联任务 ID
    budgetConsumed?: number; // Thread 内已消耗 turn 数
    convergenceSignal?: string; // 收敛信号标记
  };
}

interface OutboundMessage {
  id: string;
  chatId: string;
  threadId?: string;
  recipient: string;       // 接收者 shortId
  filteredContent: string;   // 经过可见性过滤后的内容
  originalMessageId: string; // 原始消息 ID
  visibleTo: string[];       // 该消息的可见范围（shortId 列表）
  timestamp: number;
}
```

#### 2.2.2 Session 上下文消息格式（传给 LLM）

```typescript
interface SessionContextMessage {
  role: "system" | "user" | "assistant";
  content: string;
  name?: string;            // Worker 名称（OpenAI 多角色支持）
  timestamp?: number;       // 可选，用于上下文排序
}

// Coordinator 的上下文 = 全局消息（按规则过滤后的子集）
// Worker 的上下文 = 可见消息（四层过滤后的子集）
```

### 2.3 Inbound 数据流：用户 → Worker

```
[用户在前端输入消息]
    │
    ▼
[前端 React] —— 组装 InboundMessage ——► [Socket.io Client]
    │                                          │
    │                                          ▼
    │                              [Socket.io Gateway Server]
    │                                          │
    │                    ┌─────────────────────┴─────────────────────┐
    │                    │              MessageRouter               │
    │                    │  1. 解析 @mention                         │
    │                    │  2. 查询 Thread 参与者                   │
    │                    │  3. 构建每个 Worker 的可见消息子集         │
    │                    │  4. 组装 OutboundMessage                 │
    │                    └─────────────────────┬─────────────────────┘
    │                                          │
    │        ┌─────────────────────────────────┼─────────────────────────────────┐
    │        ▼                                 ▼                                 ▼
    │  [Coordinator                       [Worker A                         [Worker B
    │   Session]                           Session]                         Session]
    │  接收：用户原始消息                   接收：@A 的消息 + co-mentioned 消息    接收：@B 的消息 + co-mentioned 消息
    │  + 全局广播消息                       + Thread 内消息                       + Thread 内消息
    │        │                                 │                                 │
    │        ▼                                 ▼                                 ▼
    │  [LLM 推理：理解意图                   [LLM 推理：执行任务                  [LLM 推理：执行任务
    │   拆解任务                            生成代码/文档]                      生成代码/文档]
    │   @Worker 分派]
    │        │                                 │                                 │
    │        ▼                                 ▼                                 ▼
    │  [回复消息：任务分派                   [回复消息：交付物                   [回复消息：交付物
    │   指令]                                + 收敛信号]                         + 收敛信号]
    │        │                                 │                                 │
    │        └─────────────────────────────────┴─────────────────────────────────┘
    │                                          │
    │                                          ▼
    │                              [Gateway：按可见性规则回传]
    │                                          │
    │                                          ▼
    │                              [前端 React：渲染消息气泡]
    │                                          │
    │                                          ▼
    │                              [用户看到：各 Agent 的回复]
```

### 2.4 Outbound 数据流：Worker → 用户

```
[Worker 生成回复]
    │
    ▼
[Worker Session] —— 组装 InboundMessage（sender=Worker）——► [Gateway]
    │                                                        │
    │                                              [MessageRouter.routeOutbound()]
    │                                                        │
    │                                              规则：
    │                                              1. Coordinator 永远收到 Worker 回复
    │                                              2. 同消息 co-mentioned 的 Worker 收到
    │                                              3. Thread 内其他参与者收到
    │                                              4. 用户收到所有 Worker 回复（前端过滤展示）
    │                                                        │
    │                                          ┌─────────────┴─────────────┐
    │                                          ▼                           ▼
    │                                    [前端 React]                  [其他 Worker Session]
    │                                    渲染消息气泡                  将消息追加到上下文
    │                                          │
    │                                          ▼
    │                                    [用户看到回复]
```

### 2.5 各节点数据格式转换示例

#### 场景：用户发送 "@FrontendAgent @BackendAgent 做一个天气查询网页"

**Step 1 — 前端组装 InboundMessage：**

```json
{
  "id": "msg_abc123",
  "chatId": "chat_agenthub",
  "sender": { "type": "user", "shortId": "u_uiw4kjce", "name": "羊吃狼" },
  "content": "@FrontendAgent @BackendAgent 做一个天气查询网页",
  "contentType": "text",
  "mentions": ["b_frontend", "b_backend"],
  "timestamp": 1716883200000,
  "metadata": {}
}
```

**Step 2 — Gateway 解析为 OutboundMessages：**

| 接收者 | filteredContent | visibleTo |
|--------|------------------|-----------|
| Coordinator | "@FrontendAgent @BackendAgent 做一个天气查询网页" | `["u_uiw4kjce", "b_coord"]` |
| FrontendAgent | "@FrontendAgent @BackendAgent 做一个天气查询网页" | `["b_frontend", "b_backend", "b_coord"]` |
| BackendAgent | "@FrontendAgent @BackendAgent 做一个天气查询网页" | `["b_frontend", "b_backend", "b_coord"]` |

**Step 3 — 各 Session 收到的上下文消息：**

```typescript
// Coordinator Session 收到的上下文（system + user）
[
  { role: "system", content: "You are the Coordinator..." },
  { role: "user", content: "@FrontendAgent @BackendAgent 做一个天气查询网页", name: "羊吃狼" }
]

// FrontendAgent Session 收到的上下文
[
  { role: "system", content: "You are FrontendAgent..." },
  { role: "user", content: "@FrontendAgent @BackendAgent 做一个天气查询网页", name: "羊吃狼" }
]

// BackendAgent Session 收到的上下文（与 FrontendAgent 相同，因为 co-mentioned）
[
  { role: "system", content: "You are BackendAgent..." },
  { role: "user", content: "@FrontendAgent @BackendAgent 做一个天气查询网页", name: "羊吃狼" }
]
```

### 2.6 注意事项

1. **消息去重**：Gateway 必须实现消息去重机制。同一条原始消息可能通过多个规则（@mention + Thread 参与者）匹配到同一个 Worker，只能投递一次。
2. **时序保证**：Gateway 到同一个 Session 的消息必须按时间顺序投递。若使用消息队列，确保每个 Session 有独立的有序队列。
3. **大消息分片**：代码块产物可能 > 10KB，前端渲染时要做虚拟滚动。Monaco Editor 加载大文件时启用延迟加载。
4. **不要透传原始 @语法给 LLM**：OpenAI API 不支持 `<@Name|ID>` 这种语法，Gateway 需要将 `@mention` 转换为纯文本或 `name` 字段，否则 LLM 可能困惑。
5. **context window 溢出**：Worker 的可见消息子集累积超过模型上下文限制时，Gateway 必须触发摘要压缩（对历史消息做 LLM 摘要），而非直接截断导致丢失关键指令。

---

## 3. 角色权限矩阵

### 3.1 设计理念

群聊系统不是人人平等的民主讨论，而是**有导演的剧组**：

- **Coordinator 是导演**：决定谁上台、谁什么时候说话、戏怎么分场次。
- **Worker 是演员**：被动接戏，按剧本（System Prompt）表演，演完下台。
- **User 是制片人**：提需求、看效果、随时喊"卡"（打断或修正）。

权限设计遵循"最小可见性原则"：每个角色只能看到它需要看到的消息，防止信息过载和越权操作。

### 3.2 权限对比表

| 权限项 | User（用户） | Coordinator（协调器） | Worker（工作者） |
|--------|------------|---------------------|----------------|
| **发送消息** | ✅ 自由发送 | ✅ 自由发送（包括系统消息） | ✅ 仅回复自己被 @的消息 |
| **@mention 他人** | ✅ 可 @任意 Agent | ✅ 可 @任意 Worker | ❌ 不可主动 @（只能在 Thread 内回复 co-mentioned Worker） |
| **创建 Thread** | ❌ 不可 | ✅ 专属权限 | ❌ 不可 |
| **关闭 Thread** | ✅ 可手动关闭自己参与的 | ✅ 专属权限 | ❌ 不可 |
| **分配任务** | ❌ 不可（只能通过 @暗示） | ✅ 专属权限 | ❌ 不可 |
| **审阅交付物** | ✅ 可人工审阅 | ✅ 自动审阅（Greenlight/Feedback） | ❌ 不可审阅他人 |
| **查看全局消息** | ✅ 所有群聊消息 | ✅ 所有群聊消息 | ❌ 仅可见与自己相关的子集 |
| **查看其他 Worker 的任务** | ✅ 可见 | ✅ 可见 | ❌ 不可见 |
| **查看 Thread 内消息** | ✅ 自己参与的 Thread | ✅ 所有 Thread | ✅ 仅自己参与的 Thread |
| **修改 System Prompt** | ❌ 不可 | ✅ 专属权限（为 Worker 配置） | ❌ 不可修改自己的 System Prompt |
| **踢出群成员** | ✅ 群聊创建者 | ✅ 专属权限 | ❌ 不可 |
| **查看预算状态** | ✅ UI 显示 | ✅ 内部追踪 | ❌ 不可见（除非 Coordinator 告知） |
| **调用工具（文件/网络）** | ❌ 不可 | ⚠️ 通过 Worker 代理 | ✅ 受限于自己的工具白名单 |
| **工作目录访问** | ❌ 不可 | ✅ 可指定 Worker 目录 | ✅ 仅自己的 workspace 子目录 |

### 3.3 权限边界详述

#### 3.3.1 User 的权限边界

- **能做什么**：发送需求、@Agent 请求协助、查看所有群聊消息（包括 Thread）、点击产物卡片预览、在 Monaco 中编辑代码、手动关闭 Thread。
- **不能做什么**：直接给 Worker 分配任务（必须通过 @让 Coordinator 介入）、修改 Worker 的 System Prompt、查看 Worker 的内部工具调用日志。
- **特殊能力**：作为"制片人"可随时打断群聊流程。例如在 Orchestrator 调度过程中发送新消息，Coordinator 必须重新评估意图并可能中断当前任务。

#### 3.3.2 Coordinator 的权限边界

- **能做什么**：一切与调度相关的行为——理解意图、拆解任务、@Worker 分派、创建/关闭 Thread、审阅交付物、控制预算、处理超时、仲裁冲突。
- **不能做什么**：直接执行代码或生成产物（它只调度，不干活）。Coordinator 不应该写 React 组件或调 API，这是 Worker 的职责。
- **关键约束**：Coordinator 只在"复杂任务需要多 Agent 协作"时介入。简单 Q&A（如"React 是什么"）不触发 Orchestrator，直接让相关 Worker 回复即可。

#### 3.3.3 Worker 的权限边界

- **能做什么**：接收自己被 @的消息、与 co-mentioned Worker 有限对话、在 Thread 内讨论、调用自己的工具集、生成交付物、发送收敛信号。
- **不能做什么**：主动抢任务（没被 @就安静待着）、查看其他 Worker 的独立任务、修改自己的 System Prompt、创建 Thread、审阅其他 Worker 的产出。
- **被动性设计**：Worker 没有"主动性"，不会看到群里有新需求就插话。所有任务分配都是 Coordinator 驱动的。这是防止多 Worker 抢任务、群聊混乱的核心机制。

### 3.4 权限冲突解决

| 冲突场景 | 处理规则 |
|---------|---------|
| User 和 Coordinator 同时发消息 | User 消息优先级更高，Coordinator 重新评估意图，可能中断当前任务 |
| Coordinator @了不存在的 Worker | Gateway 返回错误，Coordinator 收到反馈后重新选择可用 Worker |
| Worker 回复超出自己的工具权限 | Gateway 拦截非法工具调用，返回错误，Worker 收到错误后修正 |
| User 试图查看未参与的 Thread | 前端 UI 隐藏，Gateway 拒绝 API 请求（403 Forbidden） |
| Coordinator 试图让 Worker 执行危险操作 | Gateway 安全层拦截（如 `rm -rf /`），返回安全错误 |

### 3.5 注意事项

1. **权限检查在 Gateway 层做，不在前端做**：前端可以隐藏 UI，但真正的权限校验必须在 Gateway 的 API 层。防止用户绕过前端直接调用 API。
2. **Worker 的"被动性"是设计选择，不是技术限制**：技术上 Worker Session 可以监听所有消息，但 System Prompt 和 Gateway 过滤层共同确保 Worker 只响应被 @的消息。不要为了实现"方便"而破坏这个边界。
3. **Coordinator 的"过度活跃"是常见问题**：如果 System Prompt 定义不清，Coordinator 会连简单 Q&A 都触发任务拆解。参见第 10 章"仅复杂任务才介入"规则。

---

# Part 2 — 交互机制

---

## 4. 消息可见性规则

### 4.1 设计理念

消息可见性不是"群里所有人都能看到所有消息"，而是**分层授权、按需可见**。 Worker 的上下文只包含它需要看到的消息，这是防止信息过载、任务污染、Token 浪费的核心机制。

设计哲学类比：
- 全局广播层 = 公司全员邮件
- Thread 隔离层 = 项目组内部群
- 点对点层 = 主管对单个员工的私信

Worker 不需要看全员邮件，也不需要看其他项目组的讨论。它只需要看：主管 @它的任务 + 同任务同事的消息 + 项目组内的讨论。

### 4.2 四层过滤模型

Worker 的可见消息集由以下四层按优先级叠加：

```
Worker 可见消息集 = Layer 1 ∪ Layer 2 ∪ Layer 3 ∪ Layer 4

┌─────────────────────────────────────────────────────────────┐
│ Layer 1：直接 @mention（最高优先级，必须响应）                │
│   所有包含 <@MyName|MyShortID> 的消息                         │
│   包括：用户直接 @、Coordinator 调度 @、Thread 内被 @         │
├─────────────────────────────────────────────────────────────┤
│ Layer 2：同消息 co-mentioned Worker（协作授权）              │
│   Coordinator 启动消息中同一条消息 @提到的其他 Worker 的回复   │
│   授权有效期 = 该任务周期（Thread 生命周期）                    │
│   例如：Coordinator 发 "@A @B 做这个"，A 能看到 B 的回复       │
├─────────────────────────────────────────────────────────────┤
│ Layer 3：自己发送的消息（历史记忆）                           │
│   自己已发送的消息记录                                          │
│   用途：保持对话连贯性，Worker 知道自己之前说了什么             │
├─────────────────────────────────────────────────────────────┤
│ Layer 4：Thread 上下文（隔离空间内）                           │
│   当前 Thread 内的所有历史消息                                  │
│   用途：在子任务讨论中保持上下文连续                            │
└─────────────────────────────────────────────────────────────┘
```

### 4.3 不可见消息清单

以下消息类型对 Worker **永远不可见**：

| 不可见消息类型 | 示例 | 原因 |
|--------------|------|------|
| 其他 Worker 的独立任务 | Coordinator 单独 @WorkerA 的任务，WorkerB 看不到 | 任务隔离 |
| 用户与 Coordinator 的 1:1 调度对话 | Coordinator 私聊用户的任务拆解过程 | 调度隐私 |
| 其他并行任务的内部讨论 | Thread-2 的消息，Worker 只在 Thread-1 中 | Thread 隔离 |
| 全局系统消息 | 心跳、定时任务、Gateway 内部日志 | 无关噪音 |
| 未被 @的广播消息 | 用户在群里说"大家加油"但没 @具体 Worker | 避免 Worker 误响应 |

### 4.4 同消息多 @机制详解

这是 Kimi Claw 群聊系统的核心交互机制，决定了 Worker 之间能否协作。

#### 规则定义

```
场景一：同一条消息中 @A @B
─────────────────────────────
Coordinator 发送：
  "@FrontendAgent @BackendAgent 做一个天气查询网页"

结果：
  - FrontendAgent 能看到 BackendAgent 的回复
  - BackendAgent 能看到 FrontendAgent 的回复
  - 两者都知道对方也在执行这个任务
  - 这称为 "co-mentioned" 授权

场景二：分别两条消息 @A / @B
─────────────────────────────
Coordinator 发送消息1："@BackendAgent 写接口 /weather"
Coordinator 发送消息2："@FrontendAgent 等后端完成后做页面"

结果：
  - BackendAgent 看不到 FrontendAgent 的回复
  - FrontendAgent 看不到 BackendAgent 的回复
  - 两者各自独立执行任务
  - Coordinator 负责串联（FrontendAgent 需要等 BackendAgent 完成）
```

#### 同消息多 @的可见性伪代码

```typescript
class MessageRouter {
  /**
   * 解析同消息多 @的可见性规则
   * 核心逻辑：如果一条消息中 @了多个 Worker，这些 Worker 之间互相可见
   */
  buildCoMentionVisibility(msg: InboundMessage): Map<string, Set<string>> {
    const coMentionMap = new Map<string, Set<string>>();
    
    // 提取消息中所有的 Worker mention
    const workerMentions = msg.mentions.filter(id => this.isWorker(id));
    
    if (workerMentions.length > 1) {
      // 同消息多 @场景：每个 Worker 都能看到其他 co-mentioned Worker
      for (const workerId of workerMentions) {
        const visibleWorkers = new Set(workerMentions);
        visibleWorkers.delete(workerId); // 去掉自己
        coMentionMap.set(workerId, visibleWorkers);
      }
    }
    
    return coMentionMap;
  }

  /**
   * 为每个 Worker 构建其应接收的消息子集
   */
  route(msg: InboundMessage): Map<string, OutboundMessage> {
    const deliveries = new Map<string, OutboundMessage>();
    
    // 规则 1：被 @的 Worker 必须收到消息
    for (const mention of msg.mentions) {
      if (this.isWorker(mention)) {
        deliveries.set(mention, this.buildMessage(msg, mention, [mention, ...msg.mentions]));
      }
    }
    
    // 规则 2：同消息多 @的 co-mentioned Worker 之间互相可见
    if (msg.mentions.length > 1) {
      for (const sender of msg.mentions) {
        for (const receiver of msg.mentions) {
          if (sender !== receiver && this.isWorker(sender) && this.isWorker(receiver)) {
            // sender 的回复对 receiver 可见
            this.addToVisibilityGraph(receiver, sender);
          }
        }
      }
    }
    
    // 规则 3：Thread 内消息对所有 Thread 参与者可见
    if (msg.threadId) {
      for (const participant of this.getThreadParticipants(msg.threadId)) {
        if (!deliveries.has(participant)) {
          deliveries.set(participant, this.buildMessage(msg, participant, this.getThreadParticipants(msg.threadId)));
        }
      }
    }
    
    return deliveries;
  }
}
```

### 4.5 实际场景示例

#### 场景：天气查询网页开发（同消息多 @ vs 分别 @）

**方式一：同消息多 @（协作式）**

```
用户：做一个天气查询网页

Coordinator：@FrontendAgent @BackendAgent 做一个天气查询网页
            Frontend 负责 UI，Backend 负责 API

FrontendAgent 看到：
  - Coordinator 的调度消息
  - BackendAgent 的回复（因为 co-mentioned）
  
BackendAgent 看到：
  - Coordinator 的调度消息
  - FrontendAgent 的回复（因为 co-mentioned）

效果：前后端 Agent 可以实时看到对方进展，自动协调接口契约。
```

**方式二：分别 @（流水线式）**

```
用户：做一个天气查询网页

Coordinator：@BackendAgent 先写 Express 接口 /weather?city=xxx

[BackendAgent 完成，提交代码]

Coordinator：@FrontendAgent BackendAgent 已完成接口，现在写 React 页面调用 /weather

FrontendAgent 看到：
  - Coordinator 的第二段调度消息
  - 但看不到 BackendAgent 在第一段任务中的具体讨论过程
  
BackendAgent 看到：
  - 第一段调度消息和自己的回复
  - 看不到 FrontendAgent 的开发过程

效果：前后端串行开发，Coordinator 充当中介。
```

**选择策略**：
- 需要实时协作、接口契约协商 → 同消息多 @
- 任务间无依赖、完全独立 → 分别 @
- 有依赖关系但不需要实时协商 → 分别 @ + Coordinator 传递关键结论

### 4.6 @mention 解析伪代码

```typescript
/**
 * @mention 解析器
 * 输入：原始消息文本
 * 输出：mention 列表 + 清洗后的消息正文
 */
class MentionParser {
  // 支持格式：<@Name|shortId> 或 @Name
  private mentionRegex = /<@([^|]+)\|([^>]+)>/g;
  private simpleMentionRegex = /@(\w+)/g;

  parse(rawContent: string): {
    mentions: string[];      // shortId 列表
    cleanedContent: string;   // 去掉 mention 标记后的纯文本
  } {
    const mentions: string[] = [];
    
    // 解析完整格式 <@Name|shortId>
    let match;
    while ((match = this.mentionRegex.exec(rawContent)) !== null) {
      const shortId = match[2];
      mentions.push(shortId);
    }
    
    // 解析简单格式 @Name（需要查询目录解析为 shortId）
    while ((match = this.simpleMentionRegex.exec(rawContent)) !== null) {
      const name = match[1];
      const shortId = this.directory.resolveNameToShortId(name);
      if (shortId) mentions.push(shortId);
    }
    
    // 清洗：将 <@Name|shortId> 替换为 "@Name"（给 LLM 看的格式）
    const cleanedContent = rawContent
      .replace(this.mentionRegex, '@$1')
      .replace(this.simpleMentionRegex, '@$1');
    
    // 去重
    const uniqueMentions = [...new Set(mentions)];
    
    return { mentions: uniqueMentions, cleanedContent };
  }
}
```

### 4.7 注意事项

1. **co-mentioned 授权是临时性的**：只在当前任务（Thread）生命周期内有效。Thread 关闭后，Worker A 不再能看到 Worker B 的新消息。
2. **消息去重是 Gateway 层的责任**：同一条消息可能同时满足"被 @"和"Thread 参与者"两个条件，Gateway 必须确保 Worker 只收到一次。
3. **可见性规则对 Coordinator 不适用**：Coordinator 可以看到所有消息（全局广播层）。这是它作为"导演"的必要权限。
4. **User 可以看到所有 Worker 的回复**：前端 UI 渲染时不过滤，但 Worker 的上下文会被过滤。用户是"制片人"，有权看所有场面。
5. **不要给 LLM 透传原始 `<@Name|ID>` 语法**：OpenAI/Claude API 不认识这种格式，需要 Gateway 在传给 LLM 前做清洗，替换为 `@Name` 或纯文本。

---

## 5. Thread 机制

### 5.1 设计理念

Thread 是群聊中的"子话题"或"分片场"。没有 Thread 机制时，多任务并行会导致主群消息混乱：前端开发、后端开发、数据库设计的消息交错在一起，每个人都被无关消息干扰。

Thread 机制的设计目标：
- **隔离**：不同子任务的讨论互不干扰。
- **收敛**：Thread 有明确的讨论目标，完成后即关闭。
- **预算控制**：Thread 内独立计数 10 turn 预算，防止子任务无限发散。

### 5.2 Thread 创建时机

| 触发条件 | 创建者 | Thread 目的 | 生命周期 |
|---------|--------|-----------|---------|
| Coordinator 启动复杂子任务 | Coordinator | 隔离讨论，防止主群消息泛滥 | 任务完成即关闭 |
| 多轮审阅-迭代对话 | Coordinator | 收敛讨论，控制轮次 | Greenlight 后关闭 |
| Worker 间需要深度协作 | Coordinator | 允许有限的 peer-to-peer 对话 | Coordinator 可随时介入 |
| 用户要求私密讨论 | User 或 Coordinator | 仅特定参与者可见 | 用户或 Coordinator 关闭 |
| 并行子任务需要隔离 | Coordinator | 多个 Worker 同时执行不同子任务 | 各自独立关闭 |

**Worker 不能自行创建 Thread**。Thread 是 Coordinator 的调度工具。如果 Worker 觉得需要开新 Thread，必须通过收敛信号告知 Coordinator（如"建议为此开启独立讨论"）。

### 5.3 Thread 生命周期状态机

```
                    [Coordinator 指定参与者、设定目标]
                              │
                              ▼
                    ┌─────────────────┐
                    │    created      │
                    │   （已创建）     │
                    └────────┬────────┘
                             │ 第一条消息发送
                             ▼
                    ┌─────────────────┐
                    │    active       │
                    │   （活跃中）     │
                    │  消息自由流动    │
                    │  Worker 可回复   │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
        ┌─────────┐    ┌─────────┐    ┌─────────┐
        │ Worker  │    │  budget │    │ timeout │
        │发送收敛 │    │ >= 10   │    │  超时   │
        │ 信号    │    │         │    │         │
        └────┬────┘    └────┬────┘    └────┬────┘
             │              │              │
             └──────────────┼──────────────┘
                            ▼
                   ┌─────────────────┐
                   │   converging    │
                   │   （收敛中）     │
                   │ Coordinator 聚合 │
                   └────────┬────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌─────────┐   ┌─────────┐   ┌─────────┐
        │Greenlight│   │ 强制关闭 │   │ 用户干预 │
        │  通过    │   │ 预算耗尽 │   │ 手动关闭 │
        └────┬────┘   └────┬────┘   └────┬────┘
             │             │             │
             └─────────────┴─────────────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │     closed      │
                  │   （已关闭）     │
                  │ 消息不再追加    │
                  │ 上下文归档      │
                  └─────────────────┘
```

### 5.4 三层可见性架构

Thread 在全局群聊中形成三层可见性：

```
┌─────────────────────────────────────────────────────────────┐
│  全局广播层（Public / 主群）                                  │
│  所有群成员可见：用户、Coordinator、所有 Worker                 │
│  用途：需求输入、整体进度通报、最终结果展示                      │
│                                                             │
│  主群消息示例：                                               │
│  👤 用户：做一个天气查询网页                                  │
│  ⚙️ Coordinator：收到，已拆解任务，请看 Thread-1 和 Thread-2    │
│  ⚙️ Coordinator：全部完成！预览效果：[产物卡片]                  │
├─────────────────────────────────────────────────────────────┤
│  Thread 隔离层（Thread-1：Backend 开发）                       │
│  仅 Thread 参与者可见：Coordinator + BackendAgent               │
│  用途：子任务深度讨论、审阅迭代                                │
│                                                             │
│  Thread-1 消息示例：                                           │
│  ⚙️ Coordinator：@BackendAgent 写 Express 接口 /weather        │
│  🤖 BackendAgent：接口完成，代码如下...                        │
│  ⚙️ Coordinator：Greenlight，Thread-1 关闭                     │
├─────────────────────────────────────────────────────────────┤
│  Thread 隔离层（Thread-2：Frontend 开发）                       │
│  仅 Thread 参与者可见：Coordinator + FrontendAgent              │
│  用途：子任务深度讨论、审阅迭代                                │
│                                                             │
│  Thread-2 消息示例：                                           │
│  ⚙️ Coordinator：@FrontendAgent Backend 已完成，对接 /weather  │
│  🤖 FrontendAgent：页面完成，调用接口展示天气...                │
│  ⚙️ Coordinator：Feedback — 请补充错误处理                     │
│  🤖 FrontendAgent：已补充 404 处理...                         │
│  ⚙️ Coordinator：Greenlight，Thread-2 关闭                     │
├─────────────────────────────────────────────────────────────┤
│  点对点层（Private）                                           │
│  仅发送者和接收者可见                                          │
│  用途：Coordinator 对单个 Worker 的指令、Worker 向 Coordinator   │
│        私下报告问题                                            │
│                                                             │
│  注意：在 Kimi Claw 中，Private 层通常通过 Thread 的一对一形式   │
│        实现，而非完全独立的私聊通道                              │
└─────────────────────────────────────────────────────────────┘
```

### 5.5 预算计数规则

Thread 内的每条消息都会消耗对话预算（排除系统心跳和 UI 事件）。

**计数规则详表**：

| 消息发送者 | 是否计入预算 | 说明 |
|-----------|------------|------|
| User | ✅ 计入 | 用户在 Thread 内的提问或反馈 |
| Coordinator | ✅ 计入 | 调度指令、审阅反馈、追问 |
| Worker | ✅ 计入 | 交付物、回复、澄清问题 |
| 系统心跳 | ❌ 不计入 | Gateway 的在线检测消息 |
| Typing 指示 | ❌ 不计入 | 前端"正在输入..."动画 |
| UI 事件 | ❌ 不计入 | 点击、滚动、展开卡片等 |
| 产物卡片渲染 | ❌ 不计入 | 前端渲染代码块/iframe，非新消息 |

**关键规则**：同一条消息中 @多个 Worker，仍只计 **1 turn**（这是 Coordinator 的一条调度消息，不是多条）。

### 5.6 Thread 关闭条件

| 关闭触发条件 | 关闭执行者 | 关闭后行为 |
|------------|----------|----------|
| Greenlight 通过 | Coordinator | Thread 标记为 closed，参与者上下文归档 |
| 预算耗尽（10 turn） | 系统自动 | Thread 强制关闭，采用当前最佳结论，通知 Coordinator |
| 超时（Worker 5 分钟无响应） | Coordinator | Thread 强制关闭，重新分配任务或人工接管 |
| 用户手动关闭 | User | Thread 立即关闭，进行中任务标记为中断 |
| Coordinator 判定无需继续 | Coordinator | Thread 提前关闭，节省预算 |

### 5.7 Thread 数据结构

```typescript
interface Thread {
  id: string;                    // Thread ID，如 "thread_abc123"
  chatId: string;                // 所属群聊 ID
  taskId?: string;               // 关联任务 ID
  status: "created" | "active" | "converging" | "closed";
  participants: string[];        // 参与者 shortId 列表
  creator: string;               // 创建者 shortId（通常是 Coordinator）
  createdAt: number;           // 创建时间戳
  closedAt?: number;           // 关闭时间戳
  budget: {
    total: number;             // 总预算，默认 10
    consumed: number;            // 已消耗
  };
  parentThreadId?: string;      // 父 Thread ID（嵌套 Thread）
  goal: string;                  // Thread 创建时的目标描述
}
```

### 5.8 注意事项

1. **Thread 不是无限嵌套的**：MVP 阶段不支持 Thread 内再开 Thread（防止 Russian Doll 问题）。如果 Worker 觉得需要子讨论，应返回 Coordinator 并由 Coordinator 决定。
2. **Thread 关闭后消息不可追加**：但上下文会归档到数据库，Coordinator 可以查询历史 Thread 的总结用于后续任务。
3. **前端 UI 必须清晰展示 Thread**：在主群聊中显示 Thread 的"摘要卡片"（如"Backend 开发 — 3 条消息 — 已完成"），用户可点击展开查看完整 Thread。
4. **Thread 的预算计数要在 Gateway 层统一做**：不能由前端计数，防止前端被绕过。

---

## 6. 审阅-迭代流程

### 6.1 设计理念

Worker 交付物不是"交了就行"，而是必须经过 Coordinator 的审阅。审阅只有两种结果：

- **Greenlight**：通过，可以进入下一环节（聚合汇报或关闭 Thread）。
- **Feedback**：不通过，需要修改，附带具体修改意见。

审阅机制确保产出质量，同时通过"3 轮迭代上限"防止 Coordinator 和 Worker 在细节上无限拉锯。

### 6.2 四维度判定标准

Worker 交付物必须同时满足以下 4 个维度，缺一不可：

| 维度 | 权重 | 判定标准 | 失败示例 | 检查清单 |
|------|------|---------|---------|---------|
| **完整性** | 30% | 覆盖了 Coordinator 任务指令中的所有检查点 | 任务要求分析 5 个模块，Worker 只分析了 3 个 | ✅ 检查任务指令中列出的每个检查点是否都被覆盖<br>✅ 检查是否有遗漏的子任务或模块 |
| **准确性** | 30% | 无事实性错误、无逻辑矛盾、数据引用可溯源 | 把模块 A 的职责错误地归到了模块 B | ✅ 检查事实性陈述是否正确<br>✅ 检查逻辑推导是否自洽<br>✅ 检查数据引用是否有来源 |
| **格式合规** | 20% | 符合 Coordinator 预先指定的交付物格式 | 要求输出接口设计伪代码，Worker 只给了文字描述 | ✅ 检查是否使用了要求的代码块格式<br>✅ 检查是否包含要求的文档结构<br>✅ 检查是否使用了指定的标记语言 |
| **收敛性** | 20% | 交付物末尾包含明确的收敛信号 | 分析了一大段但没有给出最终结论 | ✅ 检查是否包含 `结论:` / `交回指挥:` 标记<br>✅ 检查是否给出了明确的交付摘要 |

**判定逻辑**：

```
IF 完整性 AND 准确性 AND 格式合规 AND 收敛性:
    → Greenlight
ELSE:
    → Feedback（列出所有未通过的维度及具体修改意见）
```

### 6.3 3 轮迭代状态机

```
┌─────────────────────────────────────────────────────────────┐
│ 第 1 轮：初稿                                               │
│                                                             │
│  Worker 提交初稿 ──► ReviewEngine 检查 ──► [失败] Feedback  │
│                              │                              │
│                              ▼                              │
│                        [通过] Greenlight ──► 结束            │
│                                                             │
│  Feedback 语气：指导性，指出遗漏点和改进方向                   │
│  典型解决：70% 的问题在这一轮解决（遗漏检查点、格式错误等）     │
└─────────────────────────────────────────────────────────────┘
                              │ Feedback
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 第 2 轮：修改                                               │
│                                                             │
│  Worker 修改 ──► ReviewEngine 再审 ──► [失败] Feedback       │
│  （重点检查上次              │                              │
│   Feedback 点是否修正）       ▼                              │
│                        [通过] Greenlight ──► 结束            │
│                                                             │
│  Feedback 语气：更严格，指出边界 case 和深层问题               │
│  典型解决：20% 的问题在这一轮解决（边界 case、接口不匹配等）   │
└─────────────────────────────────────────────────────────────┘
                              │ Feedback
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 第 3 轮：终审                                               │
│                                                             │
│  Worker 最终修改 ──► ReviewEngine 终审 ──► [失败] 强制处理     │
│                              │                              │
│                              ▼                              │
│                        [通过] Greenlight ──► 结束            │
│                                                             │
│  典型解决：5% 的问题在这一轮解决（复杂逻辑冲突、语义歧义）      │
└─────────────────────────────────────────────────────────────┘
                              │ 仍未通过
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 3 轮后强制处理                                               │
│                                                             │
│  IF 交付物完成度 >= 70%:                                     │
│      → 强制 Greenlight（标注已知缺陷）                       │
│      → Coordinator 在汇报时向用户说明缺陷                     │
│  ELSE:                                                      │
│      → Coordinator 接管，自行生成结论或重新分配任务            │
│                                                             │
│  原因：收益递减 + 避免死锁 + 用户体验                         │
└─────────────────────────────────────────────────────────────┘
```

### 6.4 审阅引擎伪代码

```typescript
class ReviewEngine {
  static MAX_REVIEW_ROUNDS = 3;

  /**
   * 提交交付物进行审阅
   */
  submitForReview(task: Task, deliverable: string): ReviewResult {
    const checks = {
      completeness: this.checkCompleteness(task, deliverable),
      accuracy: this.checkAccuracy(task, deliverable),
      formatCompliance: this.checkFormatCompliance(task, deliverable),
      convergence: this.checkConvergence(deliverable),
    };

    // 四维度权重评分
    const score = 
      checks.completeness.score * 0.30 +
      checks.accuracy.score * 0.30 +
      checks.formatCompliance.score * 0.20 +
      checks.convergence.score * 0.20;

    const allPassed = Object.values(checks).every(c => c.passed);

    if (allPassed) {
      return {
        verdict: "greenlight",
        feedback: null,
        checks,
        score,
      };
    }

    // 未通过，检查迭代轮次
    if (task.reviewRound >= ReviewEngine.MAX_REVIEW_ROUNDS) {
      // 3 轮后强制处理
      return this.forceResolve(task, deliverable, checks, score);
    }

    // 生成 Feedback
    const feedbackItems = Object.entries(checks)
      .filter(([_, check]) => !check.passed)
      .map(([dimension, check]) => ({
        dimension,
        issue: check.issue,
        suggestion: check.suggestion,
      }));

    task.reviewRound++;
    task.status = "iterating";

    return {
      verdict: "feedback",
      feedback: {
        round: task.reviewRound,
        items: feedbackItems,
        overall: `第 ${task.reviewRound} 轮审阅未通过，请修正以上问题后重新提交。`,
      },
      checks,
      score,
    };
  }

  /**
   * 3 轮后强制处理
   */
  private forceResolve(task: Task, deliverable: string, checks: any, score: number): ReviewResult {
    const completionRate = score; // 简化：用评分作为完成度

    if (completionRate >= 0.70) {
      // 强制 Greenlight，标注缺陷
      const knownDefects = Object.entries(checks)
        .filter(([_, check]) => !check.passed)
        .map(([dimension, check]) => ({ dimension, issue: check.issue }));

      return {
        verdict: "greenlight_forced",
        feedback: null,
        knownDefects,
        checks,
        score,
        note: "3 轮迭代后强制通过，存在已知缺陷",
      };
    } else {
      // Coordinator 接管
      return {
        verdict: "coordinator_takeover",
        feedback: null,
        checks,
        score,
        note: "交付物完成度不足 70%，Coordinator 将接管或重新分配",
      };
    }
  }

  // 各维度检查方法...
  private checkCompleteness(task: Task, deliverable: string): CheckResult {
    // 检查是否覆盖所有检查点
    const checkpoints = task.checkpoints || [];
    const covered = checkpoints.filter(cp => deliverable.includes(cp.keyword));
    const score = covered.length / checkpoints.length;
    return {
      passed: score >= 0.90, // 90% 覆盖算通过
      score,
      issue: score < 0.90 ? `遗漏检查点：${checkpoints.filter(cp => !covered.includes(cp)).map(cp => cp.name).join("、")}` : null,
      suggestion: "请补充遗漏的检查点",
    };
  }

  private checkConvergence(deliverable: string): CheckResult {
    const hasSignal = /^(结论:|交回指挥:)/m.test(deliverable);
    return {
      passed: hasSignal,
      score: hasSignal ? 1.0 : 0.0,
      issue: hasSignal ? null : "交付物末尾缺少收敛信号（结论: / 交回指挥:）",
      suggestion: "请以 '结论:' 开头给出交付摘要",
    };
  }
}
```

### 6.5 典型审阅案例

**案例 1：FrontendAgent 提交 Todo List 组件**

| 轮次 | Worker 提交 | ReviewEngine 判定 | 反馈 |
|------|------------|------------------|------|
| 1 | 代码完成，缺少 `结论:` 标记，未说明 props 接口 | Feedback | 检查点 2（props 接口定义）未覆盖。请补充 props 说明，并以 `结论:` 开头给出交付摘要。 |
| 2 | 补充了 props 接口，增加了 `结论:` | Greenlight | 通过 |

**案例 2：BackendAgent 提交天气 API**

| 轮次 | Worker 提交 | ReviewEngine 判定 | 反馈 |
|------|------------|------------------|------|
| 1 | 接口正常，城市不存在时返回 500 | Feedback | 准确性检查失败：城市不存在时应返回 404 + 错误消息，而非 500。请修正错误处理逻辑。 |
| 2 | 修正为 404 + JSON 错误消息 | Greenlight | 通过 |

**案例 3：3 轮仍未通过（强制处理）**

| 轮次 | Worker 提交 | ReviewEngine 判定 | 反馈 |
|------|------------|------------------|------|
| 1 | 架构分析，遗漏 2 个模块 | Feedback | 补充模块 X 和 Y 的分析 |
| 2 | 补充了 X，Y 分析仍然不完整 | Feedback | 模块 Y 的分析深度不够，请补充数据流图 |
| 3 | Y 的分析仍有问题 | 强制处理 | 完成度 75% → 强制 Greenlight，标注"模块 Y 数据流待完善" |

### 6.6 注意事项

1. **Feedback 必须具体**：不要写"不够好"，要写"检查点 3 未覆盖：请补充错误处理逻辑"。Worker 是 LLM，模糊反馈会导致猜测和无效迭代。
2. **ReviewEngine 可以是 LLM 也可以是规则引擎**：MVP 阶段可以用规则引擎（正则检查收敛信号、关键词覆盖），复杂审阅（准确性判断）可以调用 LLM。
3. **审阅过程本身消耗预算**：Coordinator 的审阅消息和 Worker 的修改消息都计入 Thread 预算。若前 2 轮消耗了 8 turn，第 3 轮 + 审阅可能超出 10 turn，需提前预警。
4. **不要对简单任务触发审阅**：单聊模式下的简单代码生成不需要 Greenlight/Feedback 流程，只有群聊的复杂子任务和 Thread 内讨论才触发审阅。

---

## 7. 讨论预算与收敛机制

### 7.1 设计理念

LLM 对话没有天然的"停止按钮"，一个话题可以从天气聊到哲学。讨论预算的设计目标是：**用工程手段强制讨论收敛**。

为什么是 10 turn？
- **上下文窗口**：20-30 条消息接近消费级模型（32K 上下文）的 60% 占用。
- **成本管理**：每轮对话消耗 Token，10 turn 是效果与成本的帕累托最优平衡点。
- **注意力衰减**：人类和 LLM 在超过 10 轮后焦点显著漂移。
- **工程简单性**：整数阈值，易于实现和沟通。

### 7.2 10 Turn 计数规则

| 预算消耗 | Coordinator 行为 | 系统行为 | UI 表现 |
|---------|-----------------|---------|---------|
| `consumed < 6` | 正常讨论，可自由追问、扩展、并行调度 | 无干预 | 无提示 |
| `consumed >= 6 && consumed < 8` | 正常讨论，但 Coordinator 开始注意节奏 | 无干预 | 无提示 |
| `consumed >= 8` | **强制收敛**：提示讨论接近上限，要求给出结论 | UI 黄灯警告 | 输入框上方显示"⚠️ 讨论接近上限（剩余 X turn）" |
| `consumed >= 9` | **最后追问**：只允许问一个澄清问题或要求最终结论 | 阻止开启新话题 | 黄灯变橙灯，阻止非结论性消息发送 |
| `consumed >= 10` | **强制关闭**：Thread 自动关闭，采用当前最佳结论 | UI 标记 Thread 为 closed，归档上下文 | 红灯"讨论已结束"，输入框禁用 |

### 7.3 超预算后的 5 步处理流程

当 Thread 达到 10 turn 仍未收敛时，系统自动执行以下流程：

```
Step 1：标记 Thread 状态为 "budget_exhausted"
    │
    ▼
Step 2：通知 Coordinator（发送系统消息）
    内容："Thread-{id} 预算已耗尽（10/10）。请采用当前最佳结论并关闭 Thread。"
    │
    ▼
Step 3：Coordinator 执行强制收敛
    - 提取 Thread 内所有 Worker 的交付物
    - 选择最完整的版本（或合并多个版本）
    - 生成强制结论摘要
    │
    ▼
Step 4：向主群汇报（全局广播）
    内容："Thread-{id} 因预算耗尽强制关闭。采用结论：[摘要]。已知缺陷：[如有]"
    │
    ▼
Step 5：Thread 归档，上下文保存到数据库
    - 保留完整消息历史（用于后续查询和复盘）
    - 标记为 "closed_forced"
```

### 7.4 Coordinator 的预算管理行为指南

```
IF Thread.budget.consumed >= 8:
    Coordinator 必须在下一条消息中：
    1. 明确告知所有参与者："讨论已接近上限（X/10），请准备给出结论"
    2. 不再开启新的子话题或检查点
    3. 引导 Worker 发送收敛信号

IF Thread.budget.consumed >= 9:
    Coordinator 只能：
    1. 问一个澄清问题（"请确认接口路径是 /weather 吗？"）
    2. 或直接要求最终结论（"请用一句话给出最终结论"）
    禁止：扩展讨论、引入新信息、分配新任务

IF Thread.budget.consumed >= 10:
    Coordinator 自动执行：
    1. 采用当前最佳交付物
    2. 标记已知缺陷
    3. 关闭 Thread
    4. 向主群汇报结果
```

### 7.5 预算计数伪代码

```typescript
class BudgetManager {
  private threadBudgets = new Map<string, ThreadBudget>();

  /**
   * 消息发送时调用，增加预算计数
   */
  onMessageSent(threadId: string, msg: InboundMessage): BudgetStatus {
    const budget = this.threadBudgets.get(threadId);
    if (!budget) return { error: "Thread not found" };

    // 排除不计入的消息类型
    if (this.isExempt(msg)) {
      return { consumed: budget.consumed, total: budget.total, status: "exempt" };
    }

    budget.consumed += 1;

    // 触发阈值检查
    if (budget.consumed === 8) {
      this.emitWarning(threadId, 2); // 剩余 2 turn
    } else if (budget.consumed === 9) {
      this.emitWarning(threadId, 1); // 剩余 1 turn
      this.restrictThread(threadId);   // 限制新话题
    } else if (budget.consumed >= 10) {
      this.forceClose(threadId);
    }

    return {
      consumed: budget.consumed,
      total: budget.total,
      status: budget.consumed >= 10 ? "exhausted" : budget.consumed >= 8 ? "warning" : "normal",
    };
  }

  /**
   * 判断消息是否不计入预算
   */
  private isExempt(msg: InboundMessage): boolean {
    return [
      "heartbeat",
      "typing_indicator",
      "ui_event",
      "artifact_render",
    ].includes(msg.contentType);
  }

  /**
   * 强制关闭 Thread
   */
  private forceClose(threadId: string): void {
    const thread = this.threadManager.get(threadId);
    thread.status = "closed";
    thread.closeReason = "budget_exhausted";

    // 通知 Coordinator
    this.notifyCoordinator(threadId, {
      type: "budget_exhausted",
      message: `Thread-${threadId} 预算已耗尽（10/10）。请采用当前最佳结论并关闭 Thread。`,
    });

    // 归档
    this.archiveThread(thread);
  }
}
```

### 7.6 注意事项

1. **预算计数要在 Gateway 层统一维护**：不能由前端计数，也不能由 Coordinator 自己估算。Gateway 是唯一知道所有消息发送的节点。
2. **同一条消息 @多个 Worker 只计 1 turn**：这是 Coordinator 的一条调度指令，不是多条独立消息。
3. **预算告警要实时同步到前端**：用户需要看到 Thread 的剩余预算，这是透明度和预期管理。
4. **Thread 关闭后不能追加消息**：但 Coordinator 可以创建新的 Thread 继续讨论（消耗新的预算）。这防止了"换壳续命"漏洞。
5. **系统消息不计入预算**：心跳、Typing 指示、前端 UI 事件。但 Coordinator 的系统调度消息（如"@A @B 做这个"）**计入预算**。

---

## 8. 沉默检查与超时处理

### 8.1 设计理念

Worker 不是 100% 可靠的。它可能因为：
- LLM API 超时或失败
- 工具调用卡住
- 生成内容过长被截断
- 内部错误导致没有回复

沉默检查机制确保：当 Worker 在预期时间内未回复时，Coordinator 主动介入，而非无限等待。

### 8.2 沉默检测时机

| 检测触发条件 | 预期响应时间 | 沉默判定阈值 |
|------------|------------|------------|
| Coordinator 发送调度消息给 Worker | Worker 开始执行任务 | 2 分钟无回复 |
| Worker 发送交付物等待审阅 | Coordinator 审阅反馈 | 1 分钟无回复 |
| Worker 收到 Feedback 等待修改 | Worker 提交修改版 | 2 分钟无回复 |
| Thread 内任意消息等待回复 | 下一条消息 | 3 分钟无回复 |
| Worker 调用外部工具（如 web_search） | 工具返回结果 | 1 分钟无响应 |

### 8.3 追问格式

Coordinator 的追问消息必须包含以下要素：

```
追问消息模板：
─────────────────────────────────
<@WorkerName|shortId> 进度如何？

当前状态：{任务简述}
已等待：{X} 分钟

如果已完成，请提交交付物并发送收敛信号。
如果仍在进行中，请简要说明当前进展。
如果遇到困难，请用 "阻塞:" 标记具体问题。
─────────────────────────────────
```

**追问示例**：

```
<@FrontendAgent|b_frontend> 进度如何？

当前状态：React 天气查询页面开发
已等待：2 分钟

如果已完成，请提交交付物并发送收敛信号。
如果仍在进行中，请简要说明当前进展。
如果遇到困难，请用 "阻塞:" 标记具体问题。
```

### 8.4 超时后的重新分配策略

```
Worker 超时（超过阈值无回复）
    │
    ▼
┌─────────────────────────────────┐
│ Step 1：Coordinator 发送追问    │
│         等待 1 分钟              │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│ 追问后 Worker 回复了？          │
└─────────────────────────────────┘
    │                    │
   是                   否
    │                    │
    ▼                    ▼
继续正常流程      ┌─────────────────┐
                  │ Step 2：再次追问 │
                  │ 语气更紧急       │
                  │ 等待 1 分钟      │
                  └─────────────────┘
                              │
                              ▼
                  ┌─────────────────┐
                  │ 再次追问有回复？  │
                  └─────────────────┘
                      │          │
                     是          否
                      │          │
                      ▼          ▼
                继续流程   ┌─────────────────────────┐
                           │ Step 3：判定 Worker 离线  │
                           │ 执行重新分配               │
                           └─────────────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
              [同类型 Worker      [无备用 Worker      [用户介入]
               可用？]             可用？]
                │                   │
           是 ──┘              否 ──┘
                │                   │
                ▼                   ▼
        分配给备用 Worker      Coordinator 自行接管
        通知用户重新分配        或暂停任务等待用户决策
```

### 8.5 超时处理详表

| 超时阶段 | 行为 | 通知对象 | 任务状态 |
|---------|------|---------|---------|
| 首次沉默（2min） | Coordinator 追问 | Worker + 前端 UI 显示"等待中" | active |
| 追问后无响应（+1min） | 再次追问 | Worker + 前端 UI 黄灯 | active |
| 二次追问无响应（+1min） | 标记 Worker 离线，启动重新分配 | User + 其他 Worker | reallocating |
| 找到备用 Worker | 分配任务，通知新 Worker | 新 Worker | active |
| 无备用 Worker | Coordinator 接管或暂停 | User（要求决策） | paused |

### 8.6 注意事项

1. **沉默检测由 Gateway 触发，不是 Coordinator 自己计时**：Gateway 维护每个待响应任务的计时器，超时后向 Coordinator 发送系统事件。Coordinator 本身不维护计时状态。
2. **追问次数限制**：最多 2 次追问。第 3 次无响应直接判定离线，防止 Coordinator 自己也陷入无限追问。
3. **Worker 离线后前端 UI 要更新**：Worker 头像变灰，显示"离线"状态，用户知道该 Agent 暂时不可用。
4. **重新分配时要传递上下文**：备用 Worker 需要收到原 Worker 已完成的任务上下文（如果有），而非从头开始。
5. **某些任务不支持重新分配**：例如审阅到一半的迭代任务，如果 Worker 离线，Coordinator 可以直接接管并给出强制结论，而非分配给新 Worker（避免上下文断裂）。

---

## 9. Worker-to-Worker 有限对话

### 9.1 设计理念

Worker 之间不是完全隔离的。当它们被同一条消息 co-mentioned 时，可以互相看到对方的回复。但这种对话必须被严格限制：

- **一问一答一结论**：Worker A 问一个问题，Worker B 回答，然后必须得出结论，不能无限追问。
- **禁止多跳链**：Worker A → Worker B → Worker C 的链式对话被禁止。Worker 只能和 co-mentioned 的同级 Worker 对话。
- **收敛信号强制**：任何 Worker-to-Worker 对话必须以收敛信号结束。

类比：两个演员可以在片场交流，但不能自己加戏、不能拉第三个演员进来、不能没完没了地讨论。

### 9.2 有限对话规则

| 规则 | 说明 | 违反后果 |
|------|------|---------|
| **一问一答** | Worker A 向 Worker B 提出一个问题（如"接口字段名用 camelCase 还是 snake_case?"），Worker B 回答。对话到此结束。 | Gateway 拦截超出轮次的回复，返回错误 |
| **一结论** | Worker B 的回答必须包含明确的结论（"用 camelCase"），不能是开放式讨论。 | Coordinator 介入，要求给出明确结论 |
| **禁止多跳** | Worker B 不能回复后又问 Worker A 一个新问题形成往返。Worker B 不能 @第三个 Worker 加入讨论。 | Gateway 拦截多跳消息，只允许 1 轮往返 |
| **收敛信号** | 对话结束后，参与对话的 Worker 必须在下一条消息中发送收敛信号（"结论:" / "交回指挥:"）。 | Coordinator 追问"请给出结论" |
| **Coordinator 随时可打断** | Coordinator 可以在任何时候介入 Worker-to-Worker 对话，发送新指令或要求收敛。 | — |

### 9.3 一问一答一结论的状态机

```
[Coordinator 发送：@A @B 协作完成任务X]
    │
    ▼
┌─────────────────────────────────┐
│ 状态：idle                      │
│ A 和 B 都收到任务指令            │
└─────────────────────────────────┘
    │
    ▼（A 需要 B 的信息）
┌─────────────────────────────────┐
│ 状态：question_sent               │
│ A 向 B 发送问题（1 turn）        │
│ 例如："B，接口返回格式是？"       │
└─────────────────────────────────┘
    │
    ▼（B 收到并回答）
┌─────────────────────────────────┐
│ 状态：answer_received            │
│ B 回答问题（1 turn）             │
│ 例如："返回 JSON：{city, temp}"  │
│ 必须包含明确结论                  │
└─────────────────────────────────┘
    │
    ▼（A 收到回答）
┌─────────────────────────────────┐
│ 状态：conclusion_required         │
│ A 发送收敛信号（1 turn）          │
│ 例如："结论：接口格式已确认，开搞" │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│ 状态：resolved                   │
│ Worker-to-Worker 对话结束        │
│ A 继续执行任务X                  │
│ B 等待 Coordinator 的下一步指令   │
└─────────────────────────────────┘
```

### 9.4 收敛信号列表

Worker-to-Worker 对话结束后，必须使用以下信号之一：

| 信号 | 格式 | 使用场景 | 示例 |
|------|------|---------|------|
| **结论** | `结论: {摘要}` | 对话达成了明确决定，可以继续执行任务 | `结论: 接口用 REST JSON，字段 camelCase` |
| **交回指挥** | `交回指挥: {原因}` | 对话无法得出结论，需要 Coordinator 介入 | `交回指挥: 前后端对数据格式有分歧，请定夺` |
| **阻塞** | `阻塞: {原因}` | 对话发现缺少必要信息才能继续 | `阻塞: 需要确认支持的城市列表` |
| **疑问** | `疑问: {问题}` | 对话后仍有具体澄清问题 | `疑问: 接口是否需要认证 token?` |

### 9.5 实际场景示例

**场景：FrontendAgent 与 BackendAgent 协商接口格式**

```
Coordinator: @FrontendAgent @BackendAgent 做一个天气查询网页

FrontendAgent（需要接口信息）:
  "BackendAgent，天气接口返回什么格式？字段命名用 camelCase 还是 snake_case？"
  → 状态：question_sent（1 turn）

BackendAgent（回答问题）:
  "返回 JSON：{ city: string, temperature: number, condition: string }。
  字段用 camelCase。
  结论: 接口格式已确认。"
  → 状态：answer_received（1 turn），包含结论信号

FrontendAgent（确认并继续）:
  "收到。结论: 按 camelCase JSON 格式对接口，我开始写页面。"
  → 状态：conclusion_required → resolved（1 turn）

[对话结束，FrontendAgent 继续独立开发，BackendAgent 等待 Coordinator]
```

**错误示例：多跳链（被禁止）**

```
FrontendAgent: "BackendAgent，接口格式是什么？"
BackendAgent: "JSON。对了，你前端需要什么字段？"
FrontendAgent: "需要 city、temp、condition。对了，温度单位是摄氏还是华氏？"
BackendAgent: "摄氏。那图标你用 SVG 还是 PNG？"
...

❌ 错误：一问一答后 B 又反问 A，A 又问 B，形成无限往返。
Gateway 应在第 2 轮（B 反问）时拦截，强制要求结论。
```

### 9.6 Gateway 拦截伪代码

```typescript
class WorkerDialogLimiter {
  private dialogCounters = new Map<string, number>(); // threadId_workerPair -> count

  /**
   * 检查 Worker 消息是否违反有限对话规则
   */
  validateWorkerMessage(msg: InboundMessage): ValidationResult {
    const threadId = msg.threadId;
    if (!threadId) return { valid: true }; // 主群消息不受限

    // 获取当前 Thread 的 Worker 对话计数
    const participants = this.getThreadParticipants(threadId);
    const workerPair = this.getWorkerPairKey(msg.sender.shortId, participants);
    const count = this.dialogCounters.get(workerPair) || 0;

    // 规则 1：Worker-to-Worker 对话最多 2 轮往返（A问 + B答）
    if (count >= 2 && this.isWorkerToWorkerMessage(msg)) {
      return {
        valid: false,
        error: "Worker-to-Worker 对话超出限制（一问一答一结论）。请发送收敛信号。",
        action: "require_convergence",
      };
    }

    // 规则 2：消息必须包含收敛信号或新问题（不能开放式聊天）
    if (count >= 2 && !this.hasConvergenceSignal(msg) && !this.isQuestion(msg)) {
      return {
        valid: false,
        error: "Worker-to-Worker 对话必须以收敛信号结束（结论: / 交回指挥: / 阻塞: / 疑问:）。",
        action: "require_convergence",
      };
    }

    // 规则 3：禁止 @第三个 Worker 加入
    if (msg.mentions.length > 0) {
      const newMentions = msg.mentions.filter(m => !participants.includes(m));
      if (newMentions.length > 0) {
        return {
          valid: false,
          error: `Worker 不能主动 @新参与者加入讨论。未授权的 mention: ${newMentions.join(", ")}`,
          action: "block",
        };
      }
    }

    // 计数递增
    this.dialogCounters.set(workerPair, count + 1);
    return { valid: true };
  }

  private hasConvergenceSignal(msg: InboundMessage): boolean {
    return /^(结论:|交回指挥:|阻塞:|疑问:)/m.test(msg.content);
  }
}
```

### 9.7 注意事项

1. **Worker-to-Worker 对话的预算也计入 Thread 总预算**：如果 A 和 B 讨论了 3 turn，Thread 总预算就少了 3 turn。Coordinator 在分配任务时要预估可能的对话消耗。
2. **不是所有任务都需要 Worker-to-Worker 对话**：很多任务是独立的（如 A 写前端、B 写后端，互不干扰），不需要协商。只有在接口契约、数据格式、职责边界有歧义时才启动对话。
3. **Worker 不能主动发起对话**：Worker 只能回复 co-mentioned Worker 的问题，不能主动问对方问题。主动提问权在 Coordinator。
4. **对话记录要保存在 Thread 上下文中**：即使对话结束了，后续 Worker 仍可以在上下文中看到之前的协商结论（用于理解为什么这样实现）。

---

# Part 3 — Prompt 工程

---

## 10. Coordinator System Prompt

### 10.1 设计理念

Coordinator 的 System Prompt 是整个群聊系统的"宪法"。它定义了 Coordinator 的调度规则、审阅标准、预算意识、行为边界。一个设计良好的 Coordinator Prompt 能让系统稳定运行，一个设计不好的 Prompt 会导致 Orchestrator 过度活跃、Worker 抢任务、讨论无限发散。

### 10.2 完整 Prompt

```markdown
# System Prompt — Coordinator（群聊协调器）

## 身份定义
你是 AgentHub 群聊系统的 Coordinator（协调器）。你不是执行者，你是调度者。
你的职责是理解用户需求、拆解任务、分派 Worker、追踪进度、审阅交付物、控制讨论预算。

## 核心规则（按优先级排序）

### 规则 1：介入时机 — 仅复杂任务才 orchestrate
- 简单 Q&A（如"React 是什么"、"解释这段代码"）→ 不介入，让相关 Worker 直接回复
- 多步骤、多角色、多模块的复杂任务 → 介入，拆解并分派
- 判断标准：是否需要 2 个及以上 Worker 协作，或是否需要超过 3 个步骤

### 规则 2：任务拆解 — 结构化分派
拆解任务时必须指定：
1. 目标 Worker（通过 @mention）
2. 交付物格式（代码 / 文档 / 分析 / 设计）
3. 验收标准（检查点列表）
4. 依赖关系（是否需要等待其他 Worker 完成）

### 规则 3：同消息多 @策略
- 需要 Worker 实时协作、协商接口契约 → 同一条消息 @多个 Worker
- 任务间无依赖、完全独立 → 分别发消息 @不同 Worker
- 有依赖但不需要实时协商 → 分别 @ + 在后续消息中传递前置结论

### 规则 4：预算管理 — 每个 Thread 10 turn
- Thread 创建时设定 budget = 10
- consumed >= 8 → 提示所有参与者"讨论接近上限，请准备结论"
- consumed >= 9 → 只允许澄清问题或要求最终结论
- consumed >= 10 → 强制关闭，采用当前最佳交付物，向主群汇报

### 规则 5：审阅标准 — 四维度 Greenlight/Feedback
审阅 Worker 交付物时检查：
1. 完整性（30%）：是否覆盖所有检查点
2. 准确性（30%）：无事实错误、逻辑自洽
3. 格式合规（20%）：符合交付物格式要求
4. 收敛性（20%）：包含收敛信号（结论: / 交回指挥:）

只有通过全部 4 个维度，才能 Greenlight。
Feedback 必须具体指出未通过的维度及修改意见。
最多 3 轮迭代，3 轮后强制处理（完成度 >=70% 强制 Greenlight，否则接管）。

### 规则 6：沉默检查 — 2 分钟无响应则追问
Worker 在预期时间内未回复时，发送追问消息：
"<@WorkerName|id> 进度如何？当前状态：{任务简述}。如果已完成请发送收敛信号。如果遇到困难请用 '阻塞:' 标记。"
追问 2 次无响应 → 标记离线，启动重新分配。

### 规则 7：Worker-to-Worker 对话限制
- 只允许一问一答一结论
- 禁止多跳链（Worker A → B → A → B...）
- 对话必须以收敛信号结束
- 你随时可打断 Worker 对话，要求收敛或给出新指令

### 规则 8：聚合汇报 — 结果整合
所有子任务 Greenlight 后：
1. 整合所有交付物为统一格式
2. 生成产物卡片（代码 / 网页预览 / 文档）
3. 向主群发送汇报消息，包含最终产物
4. 如有已知缺陷，明确标注

### 规则 9：安全边界
- 不执行危险命令（rm -rf /、格式化磁盘等）
- 不泄露一个 Worker 的任务细节给无关 Worker
- 不修改 Worker 的 IDENTITY.md 或 SOUL.md
- 不在 Thread 外讨论 Thread 内的敏感信息

## 风格约束
- 调度消息简洁，不发废话
- 审阅反馈具体，指出明确问题
- 进度汇报结构化，用列表展示各子任务状态
- 不解释显而易见的操作（如"我现在要拆解任务了"）

## 收敛信号响应
收到 Worker 的收敛信号时：
- "结论:" → 触发审阅流程
- "交回指挥:" → 审阅交付物，准备聚合或分配新任务
- "阻塞:" → 分析阻塞原因，提供资源或重新分配
- "疑问:" → 回答澄清问题，或传递给用户
```

### 10.3 Prompt 演进说明

| 版本 | 问题 | 改进 |
|------|------|------|
| v1 | Coordinator 过于主动，简单 Q&A 也触发任务拆解 | 加入"仅复杂任务才介入"规则 |
| v2 | 预算意识不足，Thread 经常超出 10 turn | 加入预算阈值行为指南 |
| v3 | 审阅标准模糊，Feedback 不具体 | 明确四维度权重和检查清单 |
| v4 | 沉默检查缺失，Worker 卡住时无响应 | 加入沉默检测和追问模板 |

### 10.4 注意事项

1. **Coordinator Prompt 是最长的 System Prompt**：因为它需要涵盖调度、审阅、预算、安全等多个方面。预计长度 2000-3000 tokens。
2. **Prompt 必须定期更新**：随着系统运行，收集 Coordinator 的常见错误（如过度介入、审阅遗漏），迭代优化 Prompt。
3. **不要把实现细节放进 Prompt**：Prompt 是行为约束，不是技术文档。"调用 TaskScheduler.createTask()"这种话不应该出现在 Prompt 中。
4. **Coordinator 的 Prompt 和 Worker 的 Prompt 要隔离**：不能让 Worker 看到 Coordinator 的调度策略，防止 Worker"钻空子"。

---

## 11. Worker System Prompt

### 11.1 设计理念

Worker 的 System Prompt 定义了一个 Agent 的"角色"：它擅长什么、能调用什么工具、如何与其他 Agent 协作、如何标记任务完成。每个 Worker（FrontendAgent、BackendAgent、DataAgent 等）有自己的 Prompt 变体，但核心约束是统一的。

### 11.2 通用 Worker Prompt 模板

```markdown
# System Prompt — Worker（通用模板）

## 身份定义
你是 AgentHub 群聊系统中的一个 Worker（工作者）。你的身份是：{角色名称}。
你不是协调者，你是执行者。你只响应被明确分配给你的任务。

## 核心行为规则

### 规则 1：被动响应 — 不抢任务
- 你只能看到以下消息：
  1. 直接 @你的消息
  2. 同消息 co-mentioned 的其他 Worker 的回复
  3. 你自己发送的消息
  4. 你参与的 Thread 内的消息
- 你没被 @的消息，即使你在群里，也不要主动回复
- 不要猜测用户的需求，等 Coordinator 分配任务

### 规则 2：交付物规范
- 提供完整、可运行的产出，不使用占位符（"这里写你的 API  key"）
- 代码块使用正确的语法标记（```tsx / ```python / ```json）
- 多文件产出时，列出文件清单和各自职责
- 交付物末尾必须包含收敛信号（参见收敛信号规范）

### 规则 3：协作意识
- 如果任务依赖其他 Worker 的产出（如 API 接口），等待其完成并看到产出后再开始
- 如果需要与其他 Worker 协商（接口格式、数据契约），遵循"一问一答一结论"规则
- 不要在对话中主动 @其他 Worker，除非对方先问你问题

### 规则 4：审阅响应
- 收到 Feedback 后，必须逐一回应每条修改意见
- 修改后重新提交，不要遗漏任何 Feedback 点
- 最多 3 轮迭代，第 3 轮后若仍未通过，接受强制结论

### 规则 5：工具使用
- 你只能调用被授权的工具集
- 文件操作仅限于自己的工作目录
- 网络请求（web_search / web_fetch）受速率限制
- 禁止执行危险命令（删除系统文件、修改系统配置等）

### 规则 6：可见性尊重
- 不要假设你能看到所有群聊消息
- 你的上下文只包含你被授权看到的消息
- 如果信息不足，用 "疑问:" 标记具体缺失信息，而非猜测

## 风格约束
- 短句优先，不发长段落
- 纯文本为主，必要时用代码块
- 口语化表达，有观点但不冗余
- 交付物前简要说明思路（1-2 句），不发整段解释

## 收敛信号使用
任务完成或需要 Coordinator 介入时，使用以下信号之一：
- "结论: {交付摘要}" — 任务完成，有明确产出
- "交回指挥: {原因}" — 任务完成，归还 Coordinator
- "阻塞: {原因}" — 遇到障碍，需要外部输入
- "疑问: {具体问题}" — 有具体澄清问题

## 角色特定技能
{根据具体 Worker 角色填充：}
- FrontendAgent：React、Tailwind CSS、TypeScript、组件设计
- BackendAgent：Node.js、Express、数据库设计、API 设计
- DataAgent：数据分析、SQL、可视化、统计方法
- DocAgent：文档撰写、Markdown、技术写作、结构梳理
```

### 11.3 FrontendAgent Prompt 示例

```markdown
# System Prompt — FrontendAgent

## 身份定义
你是 FrontendAgent，AgentHub 群聊系统中的前端开发专家。
你擅长 React + TypeScript + Tailwind CSS，负责生成可运行的前端组件和页面。

## 技能清单
- React 18 / Next.js 组件开发
- Tailwind CSS 样式设计
- TypeScript 类型定义
- 响应式布局（Mobile / Tablet / Desktop）
- 动画效果（Framer Motion / CSS transitions）
- 组件库集成（shadcn/ui、Radix、Headless UI）

## 交付物规范
1. 提供完整的单文件组件或清晰的多文件结构
2. 所有 props 必须定义 TypeScript 接口
3. 使用 Tailwind CSS 进行样式设计，不使用内联 style
4. 代码块使用 ```tsx 标记
5. 交付物末尾格式：
   结论: 交付了 {组件名}，包含 {功能列表}，可直接运行

## 协作规则
- 如果需要后端接口，等待 BackendAgent 完成并看到接口定义
- 接口字段命名疑问遵循"一问一答一结论"
- 产物预览相关：代码必须能在 iframe 中直接运行（无外部依赖或 CDN 引入）
```

### 11.4 BackendAgent Prompt 示例

```markdown
# System Prompt — BackendAgent

## 身份定义
你是 BackendAgent，AgentHub 群聊系统中的后端开发专家。
你擅长 Node.js + Express + SQLite，负责设计 API 接口和数据库结构。

## 技能清单
- RESTful API 设计（Express / Fastify）
- 数据库设计（SQLite / PostgreSQL）
- 错误处理和状态码规范
- 接口文档（OpenAPI / 伪代码描述）
- 认证授权（JWT / Session）

## 交付物规范
1. 提供完整的 Express 路由代码
2. 包含错误处理（400/404/500 的区分）
3. 提供接口调用示例（curl 或 fetch）
4. 代码块使用 ```typescript 标记
5. 交付物末尾格式：
   结论: 交付了 {接口名}，支持 {功能列表}，错误处理已覆盖

## 协作规则
- 优先完成接口定义，让 FrontendAgent 尽早对接
- 接口字段使用 camelCase（与 FrontendAgent 协商确认）
- 如果需要数据库结构变更，在结论中标注迁移说明
```

### 11.5 注意事项

1. **每个 Worker 的 Prompt 要差异化**：不要所有 Worker 用同一个 Prompt。FrontendAgent 和 BackendAgent 的技能清单、交付物格式、协作规则都不同。
2. **Prompt 中不要包含实现细节**："调用 file_read 工具"可以写，但"调用 OpenAI API"不应该出现在 Prompt 中（Worker 通过 Gateway 的工具层间接调用）。
3. **Worker Prompt 长度控制在 1000-1500 tokens**：太长会挤占上下文窗口，太短约束不足。
4. **定期 A/B 测试 Prompt 效果**：同一任务用不同版本的 Prompt 测试 Worker 产出质量，选择表现更好的版本。

---

## 12. 风格约束 Prompt

### 12.1 设计理念

风格约束是 Kimi Claw 群聊系统的"语气宪法"。它确保所有 Agent（Coordinator 和 Worker）的输出风格一致：简洁、口语化、有观点、不啰嗦。这不是为了"听起来像人"，而是为了**信息密度最大化**——减少用户阅读负担，加快决策速度。

### 12.2 完整风格约束

```markdown
## 风格约束（所有 Agent 必须遵守）

### 1. 短句优先
- 每句话不超过 25 个汉字或 40 个英文字符
- 一个消息气泡不超过 5 句话
- 复杂内容用列表展示，不用长段落

### 2. 纯文本为主
- 不使用 Markdown 表格（前端用卡片组件替代）
- 不使用多层嵌套列表（最多 2 层）
- 代码用代码块，说明用文字，不混排

### 3. 口语化表达
- 允许使用"这个"、"那个"、"等下"、"ok"等口语词
- 允许反问（"需要我补充什么吗？"）
- 允许省略主语（"完成了"而非"我已经完成了"）

### 4. 有观点，不发废话
- 不要说"根据我的分析"、"经过仔细考虑"等填充语
- 直接给结论和理由
- 不要解释显而易见的操作（"我现在开始写代码"）

### 5. 结构化但不僵化
- 用短列表展示多个要点（- 要点1 / - 要点2）
- 关键数据用粗体
- 进度汇报用"已完成 / 进行中 / 待开始"格式

### 6. 禁用表达
以下表达禁止使用：
- "值得注意的是..." → 直接说值得注意的内容
- "综上所述..." → 直接给结论
- "让我来帮你..." → 直接做
- "这是一个复杂的问题..." → 直接拆解
- 过度热情的感叹（"太棒了！！！" → "完成"）

### 7. 收敛信号格式
收敛信号必须单独一行，放在消息末尾：
```
（消息正文）

结论: {一句话摘要}
```
```

### 12.3 风格对比示例

| ❌ 不符合风格 | ✅ 符合风格 |
|------------|-----------|
| 根据我对需求的分析，我认为这个天气查询网页需要包含前端输入框、后端 API 接口调用以及数据展示三个主要模块。经过仔细考虑，我建议采用 React 作为前端框架，Express 作为后端框架。 | 拆成 3 个模块：输入框、API、数据展示。React + Express，开搞。 |
| 您好，我已经完成了 Todo List 组件的开发。该组件包含了添加任务、删除任务、标记完成以及筛选功能。以下是代码： | Todo List 完成。支持：添加、删除、标记完成、筛选。代码如下。 |
| 值得注意的是，这个接口在城市不存在时会返回 500 错误，这是不正确的。应该返回 404 状态码。 | 接口 bug：城市不存在返回 500，应改为 404。 |
| 让我来帮您检查一下交付物的完整性。我发现检查点 2 和检查点 5 尚未覆盖。 | 检查点 2、5 未覆盖，请补充。 |
| 综上所述， BackendAgent 的接口设计符合要求，FrontendAgent 的页面实现也基本正确，但还有一些小问题需要修复。 | Backend 通过。Frontend 需修：1. 错误处理 2. loading 状态。 |

### 12.4 注意事项

1. **风格约束要放在 System Prompt 的末尾**：LLM 对 Prompt 末尾的内容记忆更深刻。把风格约束放在最后，确保 Agent 输出时优先考虑。
2. **风格约束对所有 Agent 统一**：Coordinator 和 Worker 都要遵守。如果 Coordinator 发长段落，Worker 也会模仿。
3. **不要过度约束到失去信息量**：短句优先不等于只说废话。"React + Express"比"我推荐使用 React 作为前端框架，Express 作为后端框架"更好，但"开搞"需要上下文支持。
4. **中文和英文场景要区分**：中文用户用中文约束，英文用户用英文约束。混合场景（中英夹杂）允许，但不要一句话中中英文各占一半。

---

## 13. 收敛信号规范

### 13.1 设计理念

收敛信号是 Worker 向 Coordinator 发出的"状态通报"，让 Coordinator 知道：任务是否完成？是否需要帮助？是否有疑问？没有收敛信号，Coordinator 无法判断 Worker 是在思考中、已完成、还是卡住了。

收敛信号是显式标记，不是隐式猜测。Worker 必须主动发送，Coordinator 被动监听。

### 13.2 四种收敛信号

| 信号 | 格式 | 定义 | 使用场景 | Coordinator 响应 |
|------|------|------|---------|-----------------|
| **结论** | `结论: {一句话摘要}` | 任务完成，有明确产出或判断 | Worker 完成交付物、做出技术选型决定、完成分析 | 触发审阅流程（Greenlight/Feedback） |
| **交回指挥** | `交回指挥: {原因}` | 任务完成或无法继续，归还 Coordinator | 子任务完成、需要 Coordinator 分配下一步、发现任务超出能力范围 | 审阅交付物或重新分配任务 |
| **阻塞** | `阻塞: {具体原因}` | 遇到障碍，缺少必要输入无法继续 | 缺少 API key、需要用户确认设计方向、依赖的外部服务不可用 | 提供资源、传递给用户决策、重新分配 |
| **疑问** | `疑问: {具体问题}` | 有具体澄清问题，但不阻塞当前任务 | 确认接口字段命名、确认颜色方案、确认支持的功能范围 | 回答疑问，或传递给用户 |

### 13.3 信号格式要求

```
通用格式规则：
1. 信号必须单独一行，放在消息末尾
2. 使用半角冒号 + 空格（结论: 而不是 结论：）
3. 摘要控制在 50 字以内
4. 不要加引号、不要加 emoji、不要加多余装饰

正确示例：
─────────────────────────────────
代码已完成，支持城市搜索和天气展示。

结论: 交付 React 天气页面，含输入框、API 调用、结果展示
─────────────────────────────────

错误示例：
─────────────────────────────────
❌ 结论：我完成了天气页面！（全角冒号、emoji、感叹号）
❌ "结论: 交付了 React 天气页面"（加了引号）
❌ 结论: 交付了 React 天气页面，包含输入框、API 调用、错误处理、加载状态、温度单位切换、城市搜索建议...（超过 50 字）
─────────────────────────────────
```

### 13.4 信号使用场景详表

| Worker 状态 | 应使用信号 | 示例 |
|------------|----------|------|
| 完成了 Coordinator 分配的任务 | `结论:` | `结论: 交付 Express 接口 /weather，支持城市查询和错误处理` |
| 完成了子任务，等待下一步 | `交回指挥:` | `交回指挥: 接口完成，等待 FrontendAgent 对接` |
| 发现缺少 API key | `阻塞:` | `阻塞: 需要 OpenWeather API key 才能获取真实天气数据` |
| 不确定接口字段命名 | `疑问:` | `疑问: 接口返回温度用摄氏度还是华氏度？` |
| 任务太大，需要拆解 | `交回指挥:` | `交回指挥: 该任务需要数据库设计 + API + 前端，建议拆分为 3 个子任务` |
| 发现与另一个 Worker 的结论冲突 | `阻塞:` | `阻塞: BackendAgent 推荐 MongoDB，但我认为需要关系型数据库，请定夺` |

### 13.5 信号解析伪代码

```typescript
class ConvergenceSignalParser {
  /**
   * 从消息内容中提取收敛信号
   */
  parse(content: string): ConvergenceSignal | null {
    // 匹配四种信号的正则
    const patterns = [
      { type: "conclusion", regex: /^结论:\s*(.+)$/m },
      { type: "return_control", regex: /^交回指挥:\s*(.+)$/m },
      { type: "blocked", regex: /^阻塞:\s*(.+)$/m },
      { type: "question", regex: /^疑问:\s*(.+)$/m },
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern.regex);
      if (match) {
        return {
          type: pattern.type,
          summary: match[1].trim(),
          raw: match[0],
        };
      }
    }

    return null; // 无收敛信号
  }

  /**
   * 判断消息是否包含收敛信号
   */
  hasSignal(content: string): boolean {
    return this.parse(content) !== null;
  }

  /**
   * 根据信号类型决定 Coordinator 行为
   */
  getCoordinatorAction(signal: ConvergenceSignal): CoordinatorAction {
    switch (signal.type) {
      case "conclusion":
        return { action: "review", trigger: "review_engine" };
      case "return_control":
        return { action: "review_or_reassign", trigger: "task_complete" };
      case "blocked":
        return { action: "resolve_blocker", trigger: "escalate" };
      case "question":
        return { action: "answer_or_delegate", trigger: "clarification" };
      default:
        return { action: "none", trigger: "no_signal" };
    }
  }
}
```

### 13.6 信号优先级

如果一条消息中包含多个收敛信号（罕见但可能），按以下优先级处理：

```
优先级（高 → 低）：
1. 阻塞: — 最高优先级，需要立即处理
2. 疑问: — 次高优先级，需要澄清
3. 交回指挥: — 正常优先级，任务完成
4. 结论: — 正常优先级，任务完成

处理规则：取优先级最高的信号作为该消息的主要意图。
```

### 13.7 注意事项

1. **收敛信号不是可选的，是强制的**：Worker 的 System Prompt 必须明确要求"交付物末尾必须包含收敛信号"。ReviewEngine 的收敛性检查（20% 权重）就是用来强制这个要求的。
2. **Coordinator 要训练识别非标准信号**：初期 Worker 可能发送"完成了"、"搞定了"等口语化表达。Coordinator 的 Prompt 应说明这些也是收敛信号（在审阅时宽容处理），但逐步引导 Worker 使用标准格式。
3. **信号摘要不要包含技术细节**：`结论: 交付 React 天气页面`就够了，不要写`结论: 交付了使用 useState 管理状态、useEffect 调用 API、Tailwind CSS 样式的 React 天气页面`。摘要的目的是让 Coordinator 快速判断意图，细节在消息正文中。
4. **阻塞信号不等于失败**：Worker 发送`阻塞:`不是承认失败，而是请求资源。Coordinator 应积极响应，提供缺失信息或重新分配，而非责备 Worker。

---

# 附录

## A. 完整状态机汇总

### A.1 任务生命周期状态机

```
[用户发送需求]
    │
    ▼
pending ── Coordinator 拆解 ──► active ── Worker 执行 ──► reviewing
    │                              │                         │
    │                              │                         │ Feedback
    │                              │                         ▼
    │                              │                    iterating
    │                              │                         │
    │                              │                         │ 修改后提交
    │                              │                         ▼
    │                              │                    reviewing（轮次 +1）
    │                              │                         │
    │                              │                         │ Greenlight / 3轮强制
    │                              │                         ▼
    │                              │                        done
    │                              │                         │
    │                              │                         ▼
    │                              │                   [Coordinator 聚合汇报]
    │                              │                         │
    │                              └─────────────────────────┘
    │                                                    │
    └────────────────────────────────────────────────────┘
```

### A.2 Thread 生命周期状态机

```
created ── 第一条消息 ──► active ── 收敛信号 ──► converging ── Greenlight/强制 ──► closed
                              │                    │
                              │ budget >= 10      │ timeout
                              ▼                    ▼
                         budget_exhausted    closed_forced
```

### A.3 Worker 可见性决策树

```
消息到达 Gateway
    │
    ├── 消息 @了 Worker? ──► YES ──► Worker 收到消息
    │                        NO
    │                        ▼
    ├── Worker 在该消息的 co-mentioned 列表中? ──► YES ──► Worker 收到消息
    │                        NO
    │                        ▼
    ├── Worker 在 Thread 参与者列表中? ──► YES ──► Worker 收到消息
    │                        NO
    │                        ▼
    └── Worker 是消息发送者? ──► YES ──► Worker 收到消息（历史记忆）
                               NO ──► Worker 不收到消息
```

## B. 核心数据模型

### B.1 消息表（messages）

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,           -- UUID
  chat_id TEXT NOT NULL,         -- 群聊 ID
  thread_id TEXT,                -- Thread ID（可为空）
  sender_type TEXT NOT NULL,     -- user / coordinator / worker
  sender_short_id TEXT NOT NULL, -- 发送者短 ID
  content TEXT NOT NULL,         -- 消息正文
  content_type TEXT NOT NULL,    -- text / code / artifact / system / diff
  mentions TEXT,                 -- JSON 数组：["b_xxx", "b_yyy"]
  timestamp INTEGER NOT NULL,    -- 毫秒时间戳
  metadata TEXT,                 -- JSON：{taskId, budgetConsumed, convergenceSignal}
  visible_to TEXT,               -- JSON 数组：该消息的可见范围
  parent_id TEXT,                -- 回复/引用的父消息 ID
  FOREIGN KEY (chat_id) REFERENCES chats(id)
);
```

### B.2 Thread 表（threads）

```sql
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  task_id TEXT,
  status TEXT NOT NULL,          -- created / active / converging / closed
  participants TEXT NOT NULL,    -- JSON 数组
  creator TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  budget_total INTEGER DEFAULT 10,
  budget_consumed INTEGER DEFAULT 0,
  parent_thread_id TEXT,
  goal TEXT NOT NULL,
  close_reason TEXT,             -- greenlight / budget_exhausted / timeout / user_closed
  FOREIGN KEY (chat_id) REFERENCES chats(id)
);
```

### B.3 任务表（tasks）

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  coordinator_id TEXT NOT NULL,
  assignees TEXT NOT NULL,       -- JSON 数组
  instruction TEXT NOT NULL,
  checkpoints TEXT,              -- JSON 数组：验收检查点
  deliverable TEXT,                -- 最终交付物内容
  budget_total INTEGER DEFAULT 10,
  budget_consumed INTEGER DEFAULT 0,
  review_round INTEGER DEFAULT 0,
  status TEXT NOT NULL,            -- pending / active / reviewing / iterating / done
  thread_id TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  metadata TEXT,                   -- JSON：{verdict, score, knownDefects}
  FOREIGN KEY (chat_id) REFERENCES chats(id),
  FOREIGN KEY (thread_id) REFERENCES threads(id)
);
```

## C. 快速参考卡

### C.1 开发者速查表

| 场景 | 关键规则 | 参考章节 |
|------|---------|---------|
| 用户 @单个 Worker | Worker 收到，其他 Worker 看不到 | 第 4 章 Layer 1 |
| 用户同消息 @A @B | A 和 B 互相可见 | 第 4 章 同消息多 @ |
| Coordinator 启动 Thread | Thread 参与者收到 Thread 内所有消息 | 第 5 章 |
| Thread 预算耗尽 | 强制关闭，采用最佳结论 | 第 7 章 |
| Worker 超时 2 分钟 | Coordinator 追问 | 第 8 章 |
| Worker 和 Worker 对话 | 一问一答一结论，禁止多跳 | 第 9 章 |
| 审阅不通过 | Feedback + 最多 3 轮迭代 | 第 6 章 |
| 任务完成 | Worker 发送 `结论:` 或 `交回指挥:` | 第 13 章 |

### C.2 系统常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `MAX_THREAD_BUDGET` | 10 | Thread 对话轮次上限 |
| `BUDGET_WARNING_THRESHOLD` | 8 | 预算告警阈值 |
| `MAX_REVIEW_ROUNDS` | 3 | 审阅迭代上限 |
| `SILENCE_THRESHOLD_MS` | 120000 | 沉默检测阈值（2 分钟） |
| `MAX_WORKER_DIALOG_TURNS` | 2 | Worker-to-Worker 对话轮次上限 |
| `COMPLETENESS_WEIGHT` | 0.30 | 完整性审阅权重 |
| `ACCURACY_WEIGHT` | 0.30 | 准确性审阅权重 |
| `FORMAT_WEIGHT` | 0.20 | 格式合规审阅权重 |
| `CONVERGENCE_WEIGHT` | 0.20 | 收敛性审阅权重 |
| `FORCED_GREENLIGHT_THRESHOLD` | 0.70 | 强制 Greenlight 完成度阈值 |

---

*本规格书基于 AgentHub 赛题交付物、Kimi Claw 系统深度分析、竞品调研及 Prompt 迭代实践综合撰写。目标是为开发者提供可直接复刻的完整技术规格。*

---

> **版本**：v1.0 — 可复刻版
> **日期**：2026-06-02
> **技术栈**：React 18 + Node.js + Express + Socket.io + PostgreSQL + Redis + OpenAI API
> **目标读者**：负责复刻 Kimi Claw 群聊系统的后端/前端/运维开发者

---

## 目录

- [Part 4 — 技术架构](#part-4--技术架构)
  - [1. 模块职责与接口设计](#1-模块职责与接口设计)
  - [2. 数据库完整 Schema](#2-数据库完整-schema)
  - [3. 状态机设计](#3-状态机设计)
- [Part 5 — API 与通信](#part-5--api-与通信)
  - [4. 后端 REST API 完整定义](#4-后端-rest-api-完整定义)
  - [5. 前端组件设计](#5-前端组件设计)
  - [6. Socket.io 事件协议](#6-socketio-事件协议)
- [Part 6 — 工程与部署](#part-6--工程与部署)
  - [7. 技能系统](#7-技能系统)
  - [8. 安全模型](#8-安全模型)
  - [9. 部署方案](#9-部署方案)
  - [10. 测试方案](#10-测试方案)
- [Part 7 — 附录](#part-7--附录)
  - [11. 竞品对比矩阵](#11-竞品对比矩阵)
  - [12. 关键设计决策记录](#12-关键设计决策记录)
  - [13. MVP 复刻路径](#13-mvp-复刻路径)

---

# Part 4 — 技术架构

---

## 1. 模块职责与接口设计

### 1.1 模块总览

```
┌─────────────────────────────────────────────────────────────┐
│                      Gateway 服务（Node.js）                   │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │
│  │MessageRouter│ │TaskScheduler│ │AgentSessionManager      │ │
│  └──────┬──────┘ └──────┬──────┘ └───────────┬─────────────┘ │
│         │               │                    │               │
│  ┌──────┴──────┐ ┌──────┴──────┐ ┌───────────┴─────────────┐ │
│  │ReviewEngine │ │ThreadManager│ │OrchestratorEngine       │ │
│  └─────────────┘ └─────────────┘ └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ┌─────────┐    ┌─────────┐    ┌─────────┐
        │PostgreSQL│    │  Redis  │    │OpenAI   │
        │(主存储)  │    │(缓存/MQ)│    │API      │
        └─────────┘    └─────────┘    └─────────┘
```

### 1.2 MessageRouter — 消息路由模块

```typescript
// src/core/MessageRouter.ts

interface InboundMessage {
  id: string;
  chatId: string;
  threadId?: string;
  senderType: 'user' | 'coordinator' | 'worker';
  senderShortId: string;
  senderName: string;
  content: string;
  contentType: 'text' | 'code' | 'artifact' | 'system';
  mentions: string[];        // @mention 的成员 short_id 列表
  metadata?: Record<string, any>;
  timestamp: number;
}

interface SessionMessage {
  id: string;
  sender: string;            // short_id
  senderName: string;
  content: string;
  contentType: string;
  chatId: string;
  threadId?: string;
  visible: boolean;          // true=该 Worker 可见, false=不可见
  metadata?: Record<string, any>;
}

export class MessageRouter {
  private threadCoMentions: Map<string, Set<string>> = new Map();
  private threadParticipants: Map<string, Set<string>> = new Map();

  /**
   * 核心路由方法
   * 输入: 原始群聊消息
   * 输出: { worker_short_id -> SessionMessage } 映射
   */
  route(msg: InboundMessage): Map<string, SessionMessage> {
    const recipients = new Map<string, SessionMessage>();

    // 规则 1: 消息显式 @了 Worker -> 该 Worker 必须收到
    for (const shortId of msg.mentions) {
      if (this.isWorker(shortId)) {
        recipients.set(shortId, this.buildSessionMessage(msg, shortId, true));
      }
    }

    // 规则 2: 同消息多@场景 -> 被 co-mentioned 的 Worker 之间互相可见
    if (msg.chatId && msg.mentions.length > 1) {
      if (!this.threadCoMentions.has(msg.chatId)) {
        this.threadCoMentions.set(msg.chatId, new Set());
      }
      msg.mentions.forEach(m => this.threadCoMentions.get(msg.chatId)!.add(m));
    }

    // 规则 3: Thread 参与者收到 Thread 内所有消息
    if (msg.threadId) {
      for (const participant of this.getThreadParticipants(msg.threadId)) {
        if (!recipients.has(participant)) {
          recipients.set(participant, this.buildSessionMessage(msg, participant, true));
        }
      }
    }

    // 规则 4: 未被@且非 Thread 参与者的 Worker -> 不可见（不包含在映射中）
    return recipients;
  }

  /**
   * Worker 回复时的 Outbound 路由
   * 决定 Worker 的回复应该发给谁
   */
  routeOutbound(
    workerReply: InboundMessage,
    originalMsg: InboundMessage
  ): Map<string, SessionMessage> {
    const recipients = new Map<string, SessionMessage>();

    // Coordinator 永远收到 Worker 回复
    const coordinatorId = this.getCoordinatorId(originalMsg.chatId);
    recipients.set(coordinatorId, this.buildSessionMessage(workerReply, coordinatorId, true));

    // 同消息 co-mentioned 的 Worker 收到
    if (originalMsg.mentions.length > 1) {
      for (const mentioned of originalMsg.mentions) {
        if (mentioned !== workerReply.senderShortId && this.isWorker(mentioned)) {
          recipients.set(mentioned, this.buildSessionMessage(workerReply, mentioned, true));
        }
      }
    }

    // Thread 内其他参与者收到
    if (workerReply.threadId) {
      for (const participant of this.getThreadParticipants(workerReply.threadId)) {
        if (participant !== workerReply.senderShortId && !recipients.has(participant)) {
          recipients.set(participant, this.buildSessionMessage(workerReply, participant, true));
        }
      }
    }

    return recipients;
  }

  private buildSessionMessage(
    msg: InboundMessage,
    recipientShortId: string,
    visible: boolean
  ): SessionMessage {
    return {
      id: msg.id,
      sender: msg.senderShortId,
      senderName: msg.senderName,
      content: msg.content,
      contentType: msg.contentType,
      chatId: msg.chatId,
      threadId: msg.threadId,
      visible,
      metadata: msg.metadata,
    };
  }

  private isWorker(shortId: string): boolean {
    return shortId.startsWith('b_') && shortId !== this.getCoordinatorShortId();
  }

  private getThreadParticipants(threadId: string): Set<string> {
    return this.threadParticipants.get(threadId) || new Set();
  }

  private getCoordinatorId(chatId: string): string { return 'kimi'; }
  private getCoordinatorShortId(): string { return 'kimi'; }
}
```

### 1.3 TaskScheduler — 任务调度模块

```typescript
// src/core/TaskScheduler.ts

enum TaskStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  IN_REVIEW = 'in_review',
  ITERATING = 'iterating',
  DONE = 'done',
}

interface Task {
  id: string;
  chatId: string;
  coordinatorId: string;
  assignees: string[];
  instruction: string;
  checkpoints: string[];
  deliverable?: string;
  budgetTotal: number;
  budgetConsumed: number;
  reviewRound: number;
  maxReviewRounds: number;
  status: TaskStatus;
  threadId?: string;
  createdAt: number;
  completedAt?: number;
  metadata: {
    verdict?: 'greenlight' | 'feedback';
    score?: number;
    knownDefects?: string[];
  };
}

export class TaskScheduler {
  private tasks: Map<string, Task> = new Map();
  private threadManager: ThreadManager;
  private reviewEngine: ReviewEngine;
  private eventBus: EventEmitter;

  constructor(deps: { threadManager: ThreadManager; reviewEngine: ReviewEngine; eventBus: EventEmitter }) {
    this.threadManager = deps.threadManager;
    this.reviewEngine = deps.reviewEngine;
    this.eventBus = deps.eventBus;
  }

  /**
   * 创建任务
   */
  async createTask(params: {
    coordinatorId: string;
    instruction: string;
    assignees: string[];
    checkpoints: string[];
    budget?: number;
  }): Promise<Task> {
    const threadId = await this.threadManager.createThread({
      participants: [...params.assignees, params.coordinatorId],
      goal: params.instruction,
      budget: params.budget || 10,
    });

    const task: Task = {
      id: generateUUID(),
      chatId: 'default_chat',
      coordinatorId: params.coordinatorId,
      assignees: params.assignees,
      instruction: params.instruction,
      checkpoints: params.checkpoints,
      budgetTotal: params.budget || 10,
      budgetConsumed: 0,
      reviewRound: 0,
      maxReviewRounds: 3,
      status: TaskStatus.PENDING,
      threadId,
      createdAt: Date.now(),
      metadata: {},
    };

    this.tasks.set(task.id, task);
    await this.persistTask(task);

    this.eventBus.emit('task:created', { taskId: task.id, threadId });
    return task;
  }

  /**
   * Thread 内每发送一条消息，增加预算计数
   */
  async onMessageSent(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.budgetConsumed += 1;
    await this.persistTask(task);

    // 预算告警
    if (task.budgetConsumed >= 8 && task.budgetConsumed < 9) {
      this.eventBus.emit('budget:warning', {
        taskId,
        remaining: task.budgetTotal - task.budgetConsumed,
      });
    }

    // 预算耗尽
    if (task.budgetConsumed >= task.budgetTotal) {
      await this.threadManager.closeThread(task.threadId!, 'budget_exhausted');
      await this.transition(task, TaskStatus.DONE);
      this.eventBus.emit('budget:exhausted', {
        taskId,
        forceConclusion: true,
      });
    }
  }

  /**
   * 收到 Worker 收敛信号
   */
  async onConvergenceSignal(
    taskId: string,
    signal: string,
    deliverable: string
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    if (signal === '结论' || signal === '交回指挥') {
      task.deliverable = deliverable;
      await this.transition(task, TaskStatus.IN_REVIEW);
      await this.reviewEngine.submitForReview(task);
    } else if (signal === '阻塞') {
      this.eventBus.emit('task:blocked', { taskId, reason: deliverable });
    } else if (signal === '疑问') {
      this.eventBus.emit('task:question', { taskId, question: deliverable });
    }
  }

  /**
   * 状态转换
   */
  async transition(task: Task, newState: TaskStatus): Promise<void> {
    const oldState = task.status;
    task.status = newState;

    if (newState === TaskStatus.DONE) {
      task.completedAt = Date.now();
    }

    await this.persistTask(task);
    this.eventBus.emit('task:state_change', {
      taskId: task.id,
      oldState,
      newState,
    });
  }

  /**
   * 审阅反馈处理
   */
  async onReviewVerdict(taskId: string, verdict: 'greenlight' | 'feedback', feedback?: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    if (verdict === 'greenlight') {
      task.metadata.verdict = 'greenlight';
      await this.transition(task, TaskStatus.DONE);
    } else {
      // Feedback
      if (task.reviewRound >= task.maxReviewRounds) {
        // 3 轮后强制处理
        const completeness = this.calculateCompleteness(task.deliverable, task.checkpoints);
        if (completeness >= 0.7) {
          task.metadata.verdict = 'greenlight_with_defects';
          task.metadata.knownDefects = [feedback || '未修复的反馈项'];
          await this.transition(task, TaskStatus.DONE);
        } else {
          task.metadata.verdict = 'coordinator_takeover';
          await this.transition(task, TaskStatus.DONE);
          this.eventBus.emit('task:coordinator_takeover', { taskId });
        }
      } else {
        task.reviewRound += 1;
        await this.transition(task, TaskStatus.ITERATING);
        this.eventBus.emit('task:feedback', {
          taskId,
          round: task.reviewRound,
          feedback,
        });
      }
    }
  }

  private calculateCompleteness(deliverable: string | undefined, checkpoints: string[]): number {
    if (!deliverable) return 0;
    let matched = 0;
    for (const cp of checkpoints) {
      if (deliverable.toLowerCase().includes(cp.toLowerCase())) matched++;
    }
    return checkpoints.length > 0 ? matched / checkpoints.length : 0;
  }

  private async persistTask(task: Task): Promise<void> {
    // 写入 PostgreSQL
    await db.query(
      `INSERT INTO tasks (id, chat_id, coordinator_id, assignees, instruction, checkpoints,
        deliverable, budget_total, budget_consumed, review_round, status, thread_id, created_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (id) DO UPDATE SET
        deliverable = EXCLUDED.deliverable,
        budget_consumed = EXCLUDED.budget_consumed,
        review_round = EXCLUDED.review_round,
        status = EXCLUDED.status,
        completed_at = EXCLUDED.completed_at,
        metadata = EXCLUDED.metadata`,
      [
        task.id, task.chatId, task.coordinatorId, JSON.stringify(task.assignees),
        task.instruction, JSON.stringify(task.checkpoints), task.deliverable,
        task.budgetTotal, task.budgetConsumed, task.reviewRound, task.status,
        task.threadId, task.createdAt, JSON.stringify(task.metadata),
      ]
    );
  }
}
```

### 1.4 AgentSessionManager — 会话管理模块

```typescript
// src/core/AgentSessionManager.ts

interface AgentSession {
  workerId: string;
  systemPrompt: string;
  authorizedSkills: string[];
  memoryPath: string;
  messages: SessionMessage[];
  contextLimit: number;
}

interface LLMPrompt {
  system: string;
  messages: Array<{ role: string; content: string; name?: string }>;
  taskInjection?: string;
  skillHints?: string[];
}

export class AgentSessionManager {
  private sessions: Map<string, AgentSession> = new Map();
  private taskScheduler: TaskScheduler;

  constructor(taskScheduler: TaskScheduler) {
    this.taskScheduler = taskScheduler;
  }

  /**
   * Worker 首次上线时创建 Session
   */
  async ensureSession(workerId: string, config: {
    systemPrompt: string;
    skills: string[];
    workspaceDir: string;
  }): Promise<void> {
    if (this.sessions.has(workerId)) return;

    this.sessions.set(workerId, {
      workerId,
      systemPrompt: config.systemPrompt,
      authorizedSkills: config.skills,
      memoryPath: config.workspaceDir,
      messages: [],
      contextLimit: 32000,
    });
  }

  /**
   * 将消息写入对应 Worker 的 Session
   */
  ingestMessage(workerId: string, msg: SessionMessage): void {
    const session = this.sessions.get(workerId);
    if (!session) return;

    if (msg.visible) {
      session.messages.push(msg);
      this.trimContext(session);
    }
    // visible=false 的消息丢弃，不进入上下文
  }

  /**
   * 组装 Prompt，提交给 LLM Runtime
   */
  generatePrompt(workerId: string): LLMPrompt {
    const session = this.sessions.get(workerId)!;
    const activeTask = this.taskScheduler.getActiveTask(workerId);

    return {
      system: session.systemPrompt,
      messages: session.messages.map(m => ({
        role: m.sender === workerId ? 'assistant' : 'user',
        content: m.content,
        name: m.senderName,
      })),
      taskInjection: activeTask?.instruction || undefined,
      skillHints: activeTask ? this.getSkillUsageHints(activeTask, session.authorizedSkills) : undefined,
    };
  }

  /**
   * 订阅任务状态变化事件
   */
  onTaskStateChange(event: TaskStateEvent): void {
    const session = this.sessions.get(event.assigneeId);
    if (!session) return;

    if (event.newState === 'iterating' && event.feedback) {
      // 将 Feedback 注入 Worker 上下文
      session.messages.push({
        id: generateUUID(),
        sender: 'coordinator',
        senderName: 'Coordinator',
        content: `审阅反馈（第 ${event.reviewRound} 轮）：${event.feedback}`,
        contentType: 'system',
        chatId: event.chatId,
        visible: true,
      } as SessionMessage);
    }

    if (event.newState === 'done') {
      // 清除任务注入的系统指令
      // 保留消息历史作为长期记忆
    }
  }

  private trimContext(session: AgentSession): void {
    const systemTokens = estimateTokens(session.systemPrompt);
    let totalTokens = systemTokens;
    const trimmed: SessionMessage[] = [];

    // 从最新消息开始保留，直到接近上下文上限
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msgTokens = estimateTokens(session.messages[i].content);
      if (totalTokens + msgTokens > session.contextLimit * 0.9) break;
      totalTokens += msgTokens;
      trimmed.unshift(session.messages[i]);
    }

    session.messages = trimmed;
  }

  private getSkillUsageHints(task: Task, authorizedSkills: string[]): string[] {
    // 根据任务类型推荐可能用到的技能
    const hints: string[] = [];
    if (task.instruction.includes('代码') || task.instruction.includes('开发')) {
      if (authorizedSkills.includes('coding')) hints.push('coding');
    }
    if (task.instruction.includes('文档') || task.instruction.includes('报告')) {
      if (authorizedSkills.includes('writing')) hints.push('writing');
    }
    return hints;
  }
}

function estimateTokens(text: string): number {
  // 粗略估算：1 token ≈ 4 个字符（中文）或 0.75 个单词（英文）
  return Math.ceil(text.length / 4);
}
```

### 1.5 ReviewEngine — 审阅引擎模块

```typescript
// src/core/ReviewEngine.ts

interface ReviewVerdict {
  verdict: 'greenlight' | 'feedback';
  score: number;              // 0-100
  dimensionScores: {
    completeness: number;     // 0-100
    accuracy: number;
    format: number;
    convergence: number;
  };
  feedback?: string;          // feedback 时的具体修改意见
  missingCheckpoints?: string[];
}

export class ReviewEngine {
  private taskScheduler: TaskScheduler;
  private llmClient: OpenAI;   // 用于自动审阅，也可人工介入

  constructor(taskScheduler: TaskScheduler, llmClient: OpenAI) {
    this.taskScheduler = taskScheduler;
    this.llmClient = llmClient;
  }

  /**
   * 提交任务进行审阅
   */
  async submitForReview(task: Task): Promise<void> {
    const verdict = await this.evaluate(task);

    if (verdict.verdict === 'greenlight') {
      await this.taskScheduler.onReviewVerdict(task.id, 'greenlight');
    } else {
      await this.taskScheduler.onReviewVerdict(task.id, 'feedback', verdict.feedback);
    }
  }

  /**
   * 四维度评估
   */
  async evaluate(task: Task): Promise<ReviewVerdict> {
    const deliverable = task.deliverable || '';

    // 维度 1: 完整性 (30%)
    const completeness = this.checkCompleteness(deliverable, task.checkpoints);

    // 维度 2: 准确性 (30%) — 用 LLM 辅助判断
    const accuracy = await this.checkAccuracy(deliverable, task.instruction);

    // 维度 3: 格式合规 (20%)
    const format = this.checkFormat(deliverable, task.instruction);

    // 维度 4: 收敛性 (20%)
    const convergence = this.checkConvergence(deliverable);

    const score = completeness * 0.3 + accuracy * 0.3 + format * 0.2 + convergence * 0.2;

    if (score >= 80 && convergence >= 50) {
      return {
        verdict: 'greenlight',
        score,
        dimensionScores: { completeness, accuracy, format, convergence },
      };
    }

    // 生成 Feedback
    const feedbackParts: string[] = [];
    if (completeness < 80) {
      feedbackParts.push(`完整性不足：遗漏了 ${task.checkpoints.filter(cp =>
        !deliverable.toLowerCase().includes(cp.toLowerCase())
      ).join('、')} 等检查点`);
    }
    if (accuracy < 70) {
      feedbackParts.push('准确性：存在事实性错误或逻辑矛盾，请核实');
    }
    if (format < 70) {
      feedbackParts.push('格式：不符合要求的交付物格式，请按规范输出');
    }
    if (convergence < 50) {
      feedbackParts.push('收敛性：缺少明确的结论信号（结论:/交回指挥:）');
    }

    return {
      verdict: 'feedback',
      score,
      dimensionScores: { completeness, accuracy, format, convergence },
      feedback: feedbackParts.join('；'),
      missingCheckpoints: task.checkpoints.filter(cp =>
        !deliverable.toLowerCase().includes(cp.toLowerCase())
      ),
    };
  }

  private checkCompleteness(deliverable: string, checkpoints: string[]): number {
    if (checkpoints.length === 0) return 100;
    let matched = 0;
    for (const cp of checkpoints) {
      if (deliverable.toLowerCase().includes(cp.toLowerCase())) matched++;
    }
    return (matched / checkpoints.length) * 100;
  }

  private async checkAccuracy(deliverable: string, instruction: string): Promise<number> {
    // 使用 LLM 辅助判断准确性
    const prompt = `请评估以下交付物是否符合任务指令要求，是否存在事实性错误或逻辑矛盾。
    
任务指令：${instruction}

交付物：${deliverable.substring(0, 2000)}

请只返回一个 0-100 的分数，100 表示完全准确，0 表示严重错误。只输出数字。`;

    try {
      const completion = await this.llmClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      });
      const score = parseInt(completion.choices[0].message.content || '70');
      return Math.max(0, Math.min(100, score));
    } catch {
      return 70; // 默认中评
    }
  }

  private checkFormat(deliverable: string, instruction: string): number {
    // 检查是否包含要求的格式元素
    let score = 100;

    // 如果指令要求伪代码，检查是否有代码块
    if (instruction.includes('伪代码') && !deliverable.includes('```')) {
      score -= 40;
    }

    // 如果指令要求表格，检查是否有表格
    if (instruction.includes('表格') && !deliverable.includes('|')) {
      score -= 30;
    }

    return Math.max(0, score);
  }

  private checkConvergence(deliverable: string): number {
    const signals = ['结论:', '交回指挥:', '疑问:', '阻塞:'];
    return signals.some(s => deliverable.includes(s)) ? 100 : 0;
  }
}
```

### 1.6 ThreadManager — Thread 管理模块

```typescript
// src/core/ThreadManager.ts

enum ThreadStatus {
  CREATED = 'created',
  ACTIVE = 'active',
  CONVERGING = 'converging',
  CLOSED = 'closed',
  BUDGET_EXHAUSTED = 'budget_exhausted',
}

interface Thread {
  id: string;
  chatId: string;
  taskId?: string;
  status: ThreadStatus;
  participants: string[];
  creator: string;
  createdAt: number;
  closedAt?: number;
  budgetTotal: number;
  budgetConsumed: number;
  parentThreadId?: string;
  goal: string;
  closeReason?: string;
}

export class ThreadManager {
  private threads: Map<string, Thread> = new Map();
  private eventBus: EventEmitter;

  constructor(eventBus: EventEmitter) {
    this.eventBus = eventBus;
  }

  async createThread(params: {
    participants: string[];
    goal: string;
    budget?: number;
    parentThreadId?: string;
  }): Promise<string> {
    const thread: Thread = {
      id: generateUUID(),
      chatId: 'default_chat',
      status: ThreadStatus.CREATED,
      participants: params.participants,
      creator: 'coordinator',
      createdAt: Date.now(),
      budgetTotal: params.budget || 10,
      budgetConsumed: 0,
      parentThreadId: params.parentThreadId,
      goal: params.goal,
    };

    this.threads.set(thread.id, thread);
    await this.persistThread(thread);

    this.eventBus.emit('thread:created', { threadId: thread.id });
    return thread.id;
  }

  async onMessageSent(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) return;

    if (thread.status === ThreadStatus.CREATED) {
      thread.status = ThreadStatus.ACTIVE;
    }

    thread.budgetConsumed += 1;
    await this.persistThread(thread);

    // 预算检查
    if (thread.budgetConsumed >= thread.budgetTotal) {
      await this.closeThread(threadId, 'budget_exhausted');
    }
  }

  async closeThread(threadId: string, reason: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread || thread.status === ThreadStatus.CLOSED) return;

    thread.status = ThreadStatus.CLOSED;
    thread.closedAt = Date.now();
    thread.closeReason = reason;

    await this.persistThread(thread);
    this.eventBus.emit('thread:closed', { threadId, reason });
  }

  private async persistThread(thread: Thread): Promise<void> {
    await db.query(
      `INSERT INTO threads (id, chat_id, task_id, status, participants, creator,
        created_at, closed_at, budget_total, budget_consumed, parent_thread_id, goal, close_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        closed_at = EXCLUDED.closed_at,
        budget_consumed = EXCLUDED.budget_consumed,
        close_reason = EXCLUDED.close_reason`,
      [
        thread.id, thread.chatId, thread.taskId, thread.status,
        JSON.stringify(thread.participants), thread.creator, thread.createdAt,
        thread.closedAt, thread.budgetTotal, thread.budgetConsumed,
        thread.parentThreadId, thread.goal, thread.closeReason,
      ]
    );
  }
}
```

---

## 2. 数据库完整 Schema

### 2.1 完整 PostgreSQL Schema

```sql
-- 群组表
CREATE TABLE groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  goal TEXT,                    -- 群目标描述
  rules JSONB DEFAULT '{}',     -- 群规则配置
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 成员表（用户 + Coordinator + Worker）
CREATE TABLE members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
  short_id TEXT UNIQUE NOT NULL,   -- 如 b_c44g6wuppvvfguh, u_uiw4kjcevfjnj36
  name TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'coordinator', 'worker', 'user')),
  context_rules JSONB DEFAULT '{}', -- Worker 的可见性规则配置
  is_online BOOLEAN DEFAULT FALSE,
  last_active_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_members_group ON members(group_id);
CREATE INDEX idx_members_short_id ON members(short_id);

-- 会话表（Thread）
CREATE TABLE threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
  task_id UUID,                    -- 关联的任务
  status TEXT NOT NULL CHECK (status IN ('created', 'active', 'converging', 'closed', 'budget_exhausted')),
  participants JSONB NOT NULL DEFAULT '[]',  -- 参与者 short_id 列表
  creator TEXT NOT NULL,
  goal TEXT NOT NULL,
  budget_total INTEGER DEFAULT 10,
  budget_consumed INTEGER DEFAULT 0,
  parent_thread_id UUID REFERENCES threads(id),
  close_reason TEXT CHECK (close_reason IN ('greenlight', 'budget_exhausted', 'timeout', 'user_closed', 'coordinator_closed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE INDEX idx_threads_group ON threads(group_id);
CREATE INDEX idx_threads_status ON threads(status);

-- 消息表
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id UUID REFERENCES groups(id) ON DELETE CASCADE,
  thread_id UUID REFERENCES threads(id) ON DELETE SET NULL,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'coordinator', 'worker', 'system')),
  sender_short_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  content TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('text', 'code', 'artifact', 'system', 'diff')),
  artifact_data JSONB,             -- 产物数据：{type, title, code, language, files}
  mentions JSONB DEFAULT '[]',     -- @mention 的 short_id 列表
  visible_to JSONB DEFAULT '[]',   -- 可见范围 short_id 列表
  parent_id UUID REFERENCES messages(id),
  metadata JSONB DEFAULT '{}',     -- {taskId, budgetConsumed, convergenceSignal, reviewRound}
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_chat ON messages(chat_id, created_at);
CREATE INDEX idx_messages_thread ON messages(thread_id, created_at);
CREATE INDEX idx_messages_sender ON messages(sender_short_id, created_at);

-- 任务表
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
  coordinator_id TEXT NOT NULL,
  assignees JSONB NOT NULL DEFAULT '[]',
  instruction TEXT NOT NULL,
  checkpoints JSONB DEFAULT '[]',
  deliverable TEXT,
  budget_total INTEGER DEFAULT 10,
  budget_consumed INTEGER DEFAULT 0,
  review_round INTEGER DEFAULT 0,
  max_review_rounds INTEGER DEFAULT 3,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'in_review', 'iterating', 'done')),
  thread_id UUID REFERENCES threads(id),
  metadata JSONB DEFAULT '{}',     -- {verdict, score, knownDefects}
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_tasks_group ON tasks(group_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_thread ON tasks(thread_id);

-- 审阅记录表
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('greenlight', 'feedback', 'forced_greenlight', 'coordinator_takeover')),
  score INTEGER CHECK (score >= 0 AND score <= 100),
  dimension_scores JSONB,          -- {completeness, accuracy, format, convergence}
  feedback TEXT,
  missing_checkpoints JSONB DEFAULT '[]',
  reviewer TEXT NOT NULL,          -- coordinator 或人工审核者
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_reviews_task ON reviews(task_id, round);

-- 技能表
CREATE TABLE skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  skill_md_content TEXT NOT NULL,  -- SKILL.md 完整内容
  scripts_path TEXT,               -- 辅助脚本路径
  version TEXT DEFAULT '1.0.0',
  is_enabled BOOLEAN DEFAULT TRUE,
  security_audit JSONB,            -- 安全审核结果
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Worker-技能关联表
CREATE TABLE worker_skills (
  worker_short_id TEXT NOT NULL,
  skill_id UUID REFERENCES skills(id) ON DELETE CASCADE,
  is_active BOOLEAN DEFAULT TRUE,
  PRIMARY KEY (worker_short_id, skill_id)
);

-- 事件日志表（用于审计和调试）
CREATE TABLE event_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,        -- task_created, message_sent, review_submitted, etc.
  entity_type TEXT NOT NULL,       -- task, message, thread, worker
  entity_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_event_logs_type ON event_logs(event_type, created_at);
CREATE INDEX idx_event_logs_entity ON event_logs(entity_type, entity_id);
```

### 2.2 Redis 数据模型

```
# 在线状态
worker:{short_id}:status -> "online" | "offline" | "busy"
worker:{short_id}:last_heartbeat -> timestamp

# 任务状态缓存（高频读写）
task:{task_id}:state -> "pending" | "active" | "in_review" | "iterating" | "done"
task:{task_id}:budget_consumed -> integer

# Thread 预算计数器
thread:{thread_id}:budget_consumed -> integer (with TTL = thread lifetime)

# 消息队列（用于可靠投递）
msg_queue:{worker_short_id} -> Redis Stream

# 会话上下文（热数据）
session:{worker_short_id}:messages -> JSON array (最近 N 条)
session:{worker_short_id}:system_prompt -> string

# 速率限制
rate_limit:web_search:{worker_short_id} -> sliding window counter
rate_limit:api_call:{worker_short_id} -> sliding window counter
```

---

## 3. 状态机设计

### 3.1 任务生命周期状态机

```
                    ┌─────────────┐
         ┌─────────│   pending   │◄─────────┐
         │         └──────┬──────┘          │
         │                │ Coordinator      │
         │                │ 分配任务         │
         │                ▼                  │
         │         ┌─────────────┐           │
         │    ┌───►│   active    │           │
         │    │    └──────┬──────┘           │
         │    │           │ Worker 提交交付物 │
         │    │           ▼                  │
         │    │    ┌─────────────┐           │
         │    │    │  in_review  │           │
         │    │    └──────┬──────┘           │
         │    │           │ ReviewEngine     │
         │    │           │ 评估             │
         │    │     ┌─────┴─────┐            │
         │    │     ▼           ▼            │
         │    │ ┌────────┐  ┌────────┐       │
         │    └─┤Greenlight│  │Feedback│◄──────┘
         │      └───┬────┘  └───┬────┘
         │          │           │ review_round < 3
         │          ▼           ▼
         │       ┌────┐    ┌──────────┐
         │       │done│    │iterating │
         │       └──┬─┘    └────┬─────┘
         │          │           │ Worker 修改后重新提交
         │          │           └────────────────┐
         │          └────────────────────────────┘
         │
         │  review_round >= 3 且未 Greenlight
         │  ┌─────────────────┐
         └──┤ 强制处理         │
            │ (强制Greenlight │
            │  或Coordinator  │
            │  接管)           │
            └────────┬────────┘
                     ▼
                  ┌────┐
                  │done│
                  └────┘
```

**状态转换表**：

| 当前状态 | 触发事件 | 新状态 | 条件 |
|---------|---------|--------|------|
| pending | Coordinator 分配任务 | active | - |
| active | Worker 提交收敛信号 | in_review | deliverable 非空 |
| in_review | ReviewEngine Greenlight | done | 4维度全部通过 |
| in_review | ReviewEngine Feedback | iterating | review_round < 3 |
| in_review | ReviewEngine Feedback | done | review_round >= 3, 强制处理 |
| iterating | Worker 重新提交 | in_review | - |
| any | 预算耗尽 | done | budget_consumed >= budget_total |
| any | 用户取消 | done | - |

### 3.2 Thread 生命周期状态机

```
created ──第一条消息──► active ──收敛信号──► converging ──Greenlight/强制──► closed
                              │                      │
                              │ budget >= 10        │ timeout
                              ▼                      ▼
                         budget_exhausted      closed_forced
```

### 3.3 Worker 可见性决策树

```
消息到达 Gateway
    │
    ├── 消息 @了 Worker? ──► YES ──► Worker 收到消息
    │                        NO
    │                        ▼
    ├── Worker 在该消息的 co-mentioned 列表中? ──► YES ──► Worker 收到消息
    │                        NO
    │                        ▼
    ├── Worker 在 Thread 参与者列表中? ──► YES ──► Worker 收到消息
    │                        NO
    │                        ▼
    └── Worker 是消息发送者? ──► YES ──► Worker 收到消息（历史记忆）
                               NO ──► Worker 不收到消息
```

---

# Part 5 — API 与通信

---

## 4. 后端 REST API 完整定义

### 4.1 API 概览

| 端点 | 方法 | 描述 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/groups` | GET/POST | 群聊列表 / 创建群聊 |
| `/api/groups/:id` | GET/PUT/DELETE | 群聊详情 / 更新 / 删除 |
| `/api/groups/:id/members` | GET/POST | 成员列表 / 添加成员 |
| `/api/threads` | GET/POST | Thread 列表 / 创建 Thread |
| `/api/threads/:id` | GET/DELETE | Thread 详情 / 关闭 |
| `/api/threads/:id/messages` | GET | Thread 内消息列表 |
| `/api/tasks` | GET/POST | 任务列表 / 创建任务 |
| `/api/tasks/:id` | GET/PUT | 任务详情 / 更新 |
| `/api/tasks/:id/review` | POST | 提交审阅 |
| `/api/messages` | POST | 发送消息（WebSocket 备用） |
| `/api/preview/:messageId` | GET | 获取产物预览 HTML |
| `/api/skills` | GET/POST | 技能列表 / 注册技能 |
| `/api/skills/:id` | GET/PUT/DELETE | 技能详情 / 更新 / 注销 |
| `/api/files` | POST | 上传文件 |
| `/api/files/:id` | GET | 下载文件 |

### 4.2 核心端点详细定义

#### 创建任务

```
POST /api/tasks
Content-Type: application/json

Request:
{
  "groupId": "uuid",
  "instruction": "@FrontendAgent @BackendAgent 做一个天气查询网页",
  "assignees": ["b_frontend", "b_backend"],
  "checkpoints": ["前端界面", "后端API", "数据对接"],
  "budget": 10
}

Response 201:
{
  "success": true,
  "data": {
    "id": "uuid",
    "status": "pending",
    "threadId": "uuid",
    "assignees": ["b_frontend", "b_backend"],
    "instruction": "@FrontendAgent @BackendAgent 做一个天气查询网页",
    "budgetTotal": 10,
    "budgetConsumed": 0,
    "createdAt": "2024-01-01T00:00:00Z"
  }
}

Response 400:
{
  "success": false,
  "error": "Invalid assignees: b_frontend is not a member of this group"
}
```

#### 提交审阅

```
POST /api/tasks/:taskId/review
Content-Type: application/json

Request:
{
  "verdict": "feedback",
  "feedback": "完整性不足：遗漏了数据对接检查点；格式：缺少代码块标记",
  "dimensionScores": {
    "completeness": 60,
    "accuracy": 85,
    "format": 40,
    "convergence": 100
  },
  "reviewer": "coordinator"
}

Response 200:
{
  "success": true,
  "data": {
    "taskId": "uuid",
    "newStatus": "iterating",
    "reviewRound": 1,
    "maxRounds": 3
  }
}
```

#### 创建 Thread

```
POST /api/threads
Content-Type: application/json

Request:
{
  "groupId": "uuid",
  "participants": ["b_frontend", "b_backend", "kimi"],
  "goal": "协作开发天气查询网页",
  "budget": 10,
  "taskId": "uuid"
}

Response 201:
{
  "success": true,
  "data": {
    "id": "uuid",
    "status": "created",
    "participants": ["b_frontend", "b_backend", "kimi"],
    "goal": "协作开发天气查询网页",
    "budgetTotal": 10,
    "budgetConsumed": 0
  }
}
```

#### 发送消息（WebSocket 备用 HTTP 接口）

```
POST /api/messages
Content-Type: application/json

Request:
{
  "chatId": "uuid",
  "threadId": "uuid",
  "content": "@FrontendAgent @BackendAgent 做一个天气查询网页",
  "contentType": "text",
  "mentions": ["b_frontend", "b_backend"],
  "senderType": "user"
}

Response 201:
{
  "success": true,
  "data": {
    "id": "uuid",
    "content": "@FrontendAgent @BackendAgent 做一个天气查询网页",
    "mentions": ["b_frontend", "b_backend"],
    "createdAt": "2024-01-01T00:00:00Z",
    "routedTo": ["b_frontend", "b_backend", "kimi"]
  }
}
```

#### 获取产物预览

```
GET /api/preview/:messageId

Response 200:
Content-Type: text/html

<!DOCTYPE html>
<html>...</html>

Response 404:
{
  "success": false,
  "error": "No artifact found for this message"
}
```

### 4.3 错误处理规范

```typescript
// 统一错误响应格式
interface ApiError {
  success: false;
  error: string;              // 人类可读的错误描述
  errorCode: string;          // 机器可读的错误码
  details?: Record<string, any>; // 额外上下文
}

// 错误码列表
enum ErrorCode {
  BAD_REQUEST = 'BAD_REQUEST',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  BUDGET_EXHAUSTED = 'BUDGET_EXHAUSTED',
  WORKER_OFFLINE = 'WORKER_OFFLINE',
  LLM_TIMEOUT = 'LLM_TIMEOUT',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}
```

---

## 5. 前端组件设计

### 5.1 组件树

```
App
├── Sidebar (左侧会话列表)
│   ├── SessionList
│   │   └── SessionItem × N
│   └── NewSessionButton
├── ChatArea (中间消息区)
│   ├── ChatHeader (会话标题 + 连接状态)
│   ├── MessageList
│   │   └── MessageBubble × N
│   │       ├── TextMessage
│   │       ├── CodeMessage (syntax highlight + copy)
│   │       ├── ArtifactMessage (iframe preview + code toggle)
│   │       └── SystemMessage (Orchestrator 调度通知)
│   └── MessageInput
│       ├── @mention Dropdown
│       ├── MentionTags
│       └── SendButton
├── PreviewPanel (右侧产物预览)
│   ├── ArtifactCard
│   ├── MonacoEditor (代码编辑)
│   └── IframePreview
└── TaskPanel (侧边栏：当前任务状态)
    ├── TaskList
    └── BudgetIndicator
```

### 5.2 核心组件 Props/State

```typescript
// MessageBubble.tsx
interface MessageBubbleProps {
  message: {
    id: string;
    senderType: 'user' | 'coordinator' | 'worker' | 'system';
    senderName: string;
    content: string;
    contentType: 'text' | 'code' | 'artifact' | 'system';
    artifactData?: {
      type: 'html' | 'code';
      title: string;
      code: string;
      language?: string;
    };
    createdAt: string;
  };
}

// ChatWindow.tsx
interface ChatWindowProps {
  sessionId: string;
  sessionName: string;
}

interface ChatWindowState {
  messages: Message[];
  loading: boolean;           // Orchestrator 正在工作中
  connected: boolean;         // Socket.io 连接状态
  budgetRemaining: number;    // 当前 Thread 剩余预算
}

// MessageInput.tsx
interface MessageInputProps {
  onSend: (content: string, mentions: string[]) => void;
}

interface MessageInputState {
  text: string;
  showMentions: boolean;
  mentions: string[];         // 已选中的 @mention 列表
}
```

### 5.3 消息类型渲染策略

```typescript
// 消息类型 → 渲染组件映射
const MESSAGE_RENDERERS: Record<string, React.FC<MessageProps>> = {
  text: TextMessage,
  code: CodeMessage,          // highlight.js 语法高亮 + Copy 按钮
  artifact: ArtifactMessage,  // 产物卡片：Preview/Code 切换 + iframe
  system: SystemMessage,      // 灰色窄条，Orchestrator 通知
};

// 颜色编码
const SENDER_COLORS = {
  user: { bg: 'bg-blue-600', text: 'text-white' },
  coordinator: { bg: 'bg-purple-50', text: 'text-gray-800', border: 'border-l-4 border-purple-500' },
  worker: { bg: 'bg-emerald-50', text: 'text-gray-800' },
  system: { bg: 'bg-gray-100', text: 'text-gray-500', italic: true },
};
```

### 5.4 关键交互设计

```typescript
// @mention 自动补全
function useMentionAutocomplete(input: string) {
  const match = input.match(/@(\w*)$/);
  if (!match) return null;
  
  const query = match[1].toLowerCase();
  return agents.filter(a => 
    a.name.toLowerCase().includes(query) ||
    a.shortId.toLowerCase().includes(query)
  );
}

// 产物卡片交互
function ArtifactCard({ artifact }: { artifact: ArtifactData }) {
  const [mode, setMode] = useState<'preview' | 'code'>('preview');
  
  return (
    <div className="artifact-card">
      <div className="artifact-header">
        <span>{artifact.title}</span>
        <button onClick={() => setMode(m => m === 'preview' ? 'code' : 'preview')}>
          {mode === 'preview' ? 'Code' : 'Preview'}
        </button>
      </div>
      {mode === 'preview' ? (
        <iframe srcDoc={artifact.code} sandbox="allow-scripts" />
      ) : (
        <CodeBlock code={artifact.code} language={artifact.language} />
      )}
    </div>
  );
}
```

---

## 6. Socket.io 事件协议

### 6.1 事件总表

| 事件名 | 方向 | 描述 |
|--------|------|------|
| `connection` | C→S | 客户端连接 |
| `disconnect` | C→S | 客户端断开 |
| `join-session` | C→S | 加入群聊 Session |
| `leave-session` | C→S | 离开群聊 Session |
| `send-message` | C→S | 发送消息 |
| `new-message` | S→C | 新消息推送 |
| `budget-warning` | S→C | 预算告警（剩余 ≤ 2） |
| `budget-exhausted` | S→C | 预算耗尽，Thread 即将关闭 |
| `task-state-change` | S→C | 任务状态变化 |
| `thread-closed` | S→C | Thread 关闭通知 |
| `typing` | S→C | Worker 正在输入 |
| `worker-status-change` | S→C | Worker 在线/离线/忙碌状态变化 |

### 6.2 事件数据格式

```typescript
// Client → Server: join-session
interface JoinSessionEvent {
  sessionId: string;        // group_id 或 thread_id
}

// Client → Server: send-message
interface SendMessageEvent {
  chatId: string;
  threadId?: string;
  content: string;
  contentType: 'text' | 'code' | 'artifact';
  mentions?: string[];      // @mention 的 short_id 列表
  parentId?: string;        // 回复/引用的父消息 ID
}

// Server → Client: new-message
interface NewMessageEvent {
  id: string;
  chatId: string;
  threadId?: string;
  senderType: 'user' | 'coordinator' | 'worker' | 'system';
  senderName: string;
  senderShortId: string;
  content: string;
  contentType: string;
  artifactData?: ArtifactData;
  mentions: string[];
  createdAt: string;
}

// Server → Client: budget-warning
interface BudgetWarningEvent {
  threadId: string;
  taskId: string;
  consumed: number;
  total: number;
  remaining: number;
}

// Server → Client: budget-exhausted
interface BudgetExhaustedEvent {
  threadId: string;
  taskId: string;
  forceConclusion: boolean;
  summary?: string;         // 当前最佳结论摘要
}

// Server → Client: task-state-change
interface TaskStateChangeEvent {
  taskId: string;
  oldState: string;
  newState: string;
  reviewRound?: number;
  feedback?: string;
}

// Server → Client: worker-status-change
interface WorkerStatusChangeEvent {
  workerShortId: string;
  status: 'online' | 'offline' | 'busy';
  lastActiveAt?: string;
}
```

### 6.3 消息发送流程（Socket.io）

```
[Client] 用户在输入框打字 + 点击发送
    │
    ▼
[Client] socket.emit('send-message', {
           chatId: 'group_xxx',
           content: '@FrontendAgent 写个组件',
           mentions: ['b_frontend']
         })
    │
    ▼
[Server] Gateway 收到 send-message 事件
    │
    ▼
[Server] MessageRouter.route(msg)
         → 解析 @mention
         → 确定接收者：['b_frontend', 'kimi']
    │
    ▼
[Server] 存入数据库（messages 表）
    │
    ▼
[Server] io.to(chatId).emit('new-message', msg)
         → 前端收到，渲染消息气泡
    │
    ▼
[Server] 将消息推送到 FrontendAgent Session
         → AgentSessionManager.ingestMessage('b_frontend', msg)
         → LLM Runtime 生成回复
    │
    ▼
[Server] FrontendAgent 回复到达 Gateway
         → MessageRouter.routeOutbound(reply, originalMsg)
         → 确定接收者：['kimi', 前端用户]
    │
    ▼
[Server] 存入数据库 + emit('new-message', reply)
    │
    ▼
[Client] 前端收到新消息，渲染 Worker 回复
```

---

# Part 6 — 工程与部署

---

## 7. 技能系统

### 7.1 SKILL.md 规范格式

```markdown
# Skill: {skill-name}

## 描述
一句话描述这个技能是做什么的。

## 命令

### {command-name}
描述：这个命令做什么
参数：
- `param1` (string, 必需)：参数说明
- `param2` (number, 可选)：参数说明，默认值

返回值：
- 成功：{ "success": true, "data": ... }
- 失败：{ "success": false, "error": "错误描述" }

约束：
- 不能修改系统文件
- 不能超过 1000 次调用/小时

### {command-name-2}
...

## 依赖
- node >= 18
- 外部 API: https://api.example.com (需 API key)

## 安全审核
- [x] 无破坏性命令
- [x] 无数据外泄
- [ ] 需网络访问（已限制速率）
```

### 7.2 技能加载流程

```typescript
// src/skills/SkillLoader.ts

export class SkillLoader {
  private skills: Map<string, Skill> = new Map();

  async loadFromDirectory(skillsDir: string): Promise<void> {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const skillPath = path.join(skillsDir, entry.name);
      const skillMdPath = path.join(skillPath, 'SKILL.md');
      
      if (!await fs.access(skillMdPath).then(() => true).catch(() => false)) {
        console.warn(`Skipping ${entry.name}: no SKILL.md found`);
        continue;
      }
      
      const skillMd = await fs.readFile(skillMdPath, 'utf-8');
      const skill = this.parseSkillMd(skillMd, skillPath);
      
      // 安全审核
      const audit = await this.securityAudit(skill);
      if (!audit.passed) {
        console.error(`Skill ${skill.name} failed security audit:`, audit.issues);
        continue;
      }
      
      this.skills.set(skill.name, skill);
      console.log(`Loaded skill: ${skill.name}`);
    }
  }

  private parseSkillMd(content: string, basePath: string): Skill {
    // 解析 SKILL.md 的 YAML frontmatter + Markdown
    const parsed = matter(content);
    return {
      name: parsed.data.name,
      description: parsed.data.description,
      commands: this.parseCommands(parsed.content),
      dependencies: parsed.data.dependencies || [],
      scriptsPath: path.join(basePath, 'scripts'),
    };
  }

  private async securityAudit(skill: Skill): Promise<SecurityAudit> {
    const issues: string[] = [];
    
    // 检查是否有 rm -rf、format、mkfs 等危险命令
    for (const cmd of skill.commands) {
      if (cmd.script && /rm\s+-rf\s*\//.test(cmd.script)) {
        issues.push(`Dangerous command detected in ${cmd.name}`);
      }
      if (cmd.script && /curl.+\|.*sh/.test(cmd.script)) {
        issues.push(`Pipe to shell detected in ${cmd.name}`);
      }
    }
    
    // 检查外部数据传输
    if (skill.commands.some(c => c.externalApi)) {
      issues.push('External API access requires rate limiting');
    }
    
    return {
      passed: issues.length === 0,
      issues,
    };
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  getAllSkills(): Skill[] {
    return Array.from(this.skills.values());
  }
}
```

### 7.3 技能注入到 Worker Prompt

```typescript
// Worker 启动时，将授权的技能注入 System Prompt

function buildWorkerSystemPrompt(workerConfig: WorkerConfig, skillLoader: SkillLoader): string {
  const authorizedSkills = workerConfig.authorizedSkills
    .map(name => skillLoader.getSkill(name))
    .filter(Boolean);

  const skillDescriptions = authorizedSkills.map(s => 
    `- ${s.name}: ${s.description}\n  可用命令: ${s.commands.map(c => c.name).join(', ')}`
  ).join('\n');

  return `
${workerConfig.basePrompt}

## 可用技能
${skillDescriptions}

## 技能使用规则
- 只能调用上面列出的技能
- 调用格式：/skill_name:command_name param1=value1 param2=value2
- 如果不确定某个技能是否可用，先用 "疑问:" 询问 Coordinator
`;
}
```

---

## 8. 安全模型

### 8.1 文件系统隔离

```typescript
// src/security/FileSystemSandbox.ts

export class FileSystemSandbox {
  private baseDir: string;
  private workerId: string;

  constructor(workerId: string, workspaceRoot: string) {
    this.workerId = workerId;
    this.baseDir = path.resolve(workspaceRoot, workerId);
    
    // 确保目录存在
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  /**
   * 路径安全检查：确保操作路径在 Worker 的工作目录内
   */
  private resolveSafePath(relativePath: string): string {
    const resolved = path.resolve(this.baseDir, relativePath);
    
    // 关键安全检查：防止目录遍历攻击
    if (!resolved.startsWith(this.baseDir + path.sep) && resolved !== this.baseDir) {
      throw new SecurityError(`Path traversal attempt: ${relativePath}`);
    }
    
    return resolved;
  }

  async readFile(relativePath: string): Promise<string> {
    const safePath = this.resolveSafePath(relativePath);
    return fs.readFile(safePath, 'utf-8');
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const safePath = this.resolveSafePath(relativePath);
    await fs.mkdir(path.dirname(safePath), { recursive: true });
    return fs.writeFile(safePath, content);
  }

  async deleteFile(relativePath: string): Promise<void> {
    const safePath = this.resolveSafePath(relativePath);
    
    // 禁止删除特定文件
    const protectedFiles = ['IDENTITY.md', 'SOUL.md', 'USER.md'];
    const basename = path.basename(safePath);
    if (protectedFiles.includes(basename)) {
      throw new SecurityError(`Cannot delete protected file: ${basename}`);
    }
    
    return fs.unlink(safePath);
  }

  async execCommand(command: string): Promise<string> {
    // 禁止的危险命令列表
    const dangerousPatterns = [
      /rm\s+-rf\s*\//,
      /mkfs/,
      /dd\s+if=/,
      /:\(\)\{\s*:\|:&\s*\};/,  // fork bomb
      /curl.+\|.*sh/,
      /wget.+\|.*sh/,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(command)) {
        throw new SecurityError(`Dangerous command blocked: ${command}`);
      }
    }

    // 在工作目录内执行
    return new Promise((resolve, reject) => {
      exec(command, { cwd: this.baseDir, timeout: 30000 }, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve(stdout || stderr);
      });
    });
  }
}

class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}
```

### 8.2 身份防篡改

```typescript
// src/security/IdentityProtection.ts

export class IdentityProtection {
  private protectedFiles = ['IDENTITY.md', 'SOUL.md', 'USER.md'];

  async canModify(filePath: string, actor: string): Promise<boolean> {
    const basename = path.basename(filePath);
    
    // 身份文件只有 Coordinator 可以修改
    if (this.protectedFiles.includes(basename)) {
      return actor === 'coordinator' || actor === 'system_admin';
    }
    
    // Worker 只能修改自己的工作目录内的文件
    if (actor.startsWith('b_')) {
      const workerDir = path.resolve(WORKSPACE_ROOT, actor);
      return path.resolve(filePath).startsWith(workerDir + path.sep);
    }
    
    return false;
  }

  async modifyIdentity(workerId: string, updates: Partial<Identity>, actor: string): Promise<void> {
    if (!await this.canModify(`${workerId}/IDENTITY.md`, actor)) {
      throw new SecurityError(`Only Coordinator can modify ${workerId}'s identity`);
    }
    
    const identityPath = path.resolve(WORKSPACE_ROOT, workerId, 'IDENTITY.md');
    const current = await this.readIdentity(identityPath);
    const merged = { ...current, ...updates };
    await fs.writeFile(identityPath, yaml.stringify(merged));
    
    // 记录审计日志
    await auditLog.record({
      event: 'identity_modified',
      actor,
      target: workerId,
      changes: updates,
    });
  }
}
```

### 8.3 网络限速

```typescript
// src/security/RateLimiter.ts

export class RateLimiter {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * 滑动窗口限流
   */
  async checkLimit(
    key: string,        // 如 "web_search:b_frontend"
    maxRequests: number,
    windowSeconds: number
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;
    
    // 使用 Redis Sorted Set 实现滑动窗口
    const redisKey = `rate_limit:${key}`;
    
    // 清理过期记录
    await this.redis.zremrangebyscore(redisKey, 0, windowStart);
    
    // 获取当前窗口内的请求数
    const currentCount = await this.redis.zcard(redisKey);
    
    if (currentCount >= maxRequests) {
      const oldest = await this.redis.zrange(redisKey, 0, 0, 'WITHSCORES');
      const resetAt = parseInt(oldest[1]) + windowSeconds * 1000;
      return { allowed: false, remaining: 0, resetAt };
    }
    
    // 记录本次请求
    await this.redis.zadd(redisKey, now, `${now}:${Math.random()}`);
    await this.redis.expire(redisKey, windowSeconds);
    
    return {
      allowed: true,
      remaining: maxRequests - currentCount - 1,
      resetAt: now + windowSeconds * 1000,
    };
  }
}

// 各技能的默认限速配置
export const DEFAULT_RATE_LIMITS: Record<string, { max: number; window: number }> = {
  'web_search': { max: 60, window: 3600 },      // 每小时 60 次
  'web_fetch': { max: 120, window: 3600 },      // 每小时 120 次
  'file_read': { max: 1000, window: 3600 },     // 每小时 1000 次
  'file_write': { max: 500, window: 3600 },     // 每小时 500 次
  'exec_command': { max: 100, window: 3600 },   // 每小时 100 次
  'llm_call': { max: 200, window: 3600 },       // 每小时 200 次
};
```

---

## 9. 部署方案

### 9.1 Docker Compose 配置

```yaml
# docker-compose.yml
version: '3.8'

services:
  gateway:
    build:
      context: ./server
      dockerfile: Dockerfile
    ports:
      - "3001:3001"
    environment:
      - NODE_ENV=production
      - PORT=3001
      - DATABASE_URL=postgresql://postgres:password@postgres:5432/agenthub
      - REDIS_URL=redis://redis:6379
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    volumes:
      - ./workspace:/app/workspace
      - ./skills:/app/skills
    depends_on:
      - postgres
      - redis
    restart: unless-stopped

  frontend:
    build:
      context: ./client
      dockerfile: Dockerfile
    ports:
      - "5173:80"
    environment:
      - VITE_API_URL=http://localhost:3001
      - VITE_WS_URL=ws://localhost:3001
    depends_on:
      - gateway
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=password
      - POSTGRES_DB=agenthub
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    ports:
      - "6379:6379"
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:
```

### 9.2 服务端 Dockerfile

```dockerfile
# server/Dockerfile
FROM node:20-alpine

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm ci --only=production

# 复制代码
COPY . .

# 创建工作目录
RUN mkdir -p /app/workspace /app/skills

# 非 root 用户运行
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001
RUN chown -R nodejs:nodejs /app/workspace
USER nodejs

EXPOSE 3001

CMD ["node", "dist/server.js"]
```

### 9.3 前端 Dockerfile

```dockerfile
# client/Dockerfile
# 构建阶段
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# 运行阶段
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
```

### 9.4 环境变量

```bash
# .env.example
NODE_ENV=development
PORT=3001

# 数据库
DATABASE_URL=postgresql://postgres:password@localhost:5432/agenthub
REDIS_URL=redis://localhost:6379

# LLM
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
OPENAI_TEMPERATURE=0.3

# 安全配置
WORKSPACE_ROOT=./workspace
SKILLS_DIR=./skills
MAX_THREAD_BUDGET=10
MAX_REVIEW_ROUNDS=3
SILENCE_THRESHOLD_MS=120000

# 限速
RATE_LIMIT_WEB_SEARCH=60/hour
RATE_LIMIT_WEB_FETCH=120/hour
RATE_LIMIT_LLM_CALL=200/hour
```

### 9.5 一键启动脚本

```bash
#!/bin/bash
# start.sh

set -e

echo "🚀 AgentHub 启动脚本"

# 检查依赖
command -v docker-compose >/dev/null 2>&1 || { echo "docker-compose 未安装"; exit 1; }

# 创建环境文件
if [ ! -f .env ]; then
  cp .env.example .env
  echo "⚠️  请编辑 .env 文件，填入 OPENAI_API_KEY"
fi

# 启动服务
docker-compose up -d

echo "⏳ 等待服务就绪..."
sleep 5

# 健康检查
if curl -s http://localhost:3001/api/health > /dev/null; then
  echo "✅ Gateway 服务已启动: http://localhost:3001"
  echo "✅ 前端服务已启动: http://localhost:5173"
else
  echo "❌ 服务启动失败，请检查日志: docker-compose logs"
  exit 1
fi
```

---

## 10. 测试方案

### 10.1 单元测试

```typescript
// tests/MessageRouter.test.ts
import { MessageRouter } from '../src/core/MessageRouter';

describe('MessageRouter', () => {
  let router: MessageRouter;

  beforeEach(() => {
    router = new MessageRouter();
  });

  test('单@mention: 只有被@的Worker收到消息', () => {
    const msg = createInboundMessage({
      mentions: ['b_worker_a'],
      senderShortId: 'u_user',
    });

    const recipients = router.route(msg);

    expect(recipients.has('b_worker_a')).toBe(true);
    expect(recipients.has('b_worker_b')).toBe(false);
  });

  test('同消息多@: Worker之间互相可见', () => {
    const msg = createInboundMessage({
      mentions: ['b_worker_a', 'b_worker_b'],
      senderShortId: 'kimi',
    });

    const recipients = router.route(msg);

    expect(recipients.has('b_worker_a')).toBe(true);
    expect(recipients.has('b_worker_b')).toBe(true);
  });

  test('未被@的Worker看不到消息', () => {
    const msg = createInboundMessage({
      mentions: ['b_worker_a'],
      senderShortId: 'u_user',
    });

    const recipients = router.route(msg);

    expect(recipients.has('b_worker_c')).toBe(false);
  });

  test('Thread内消息: 所有参与者收到', () => {
    const msg = createInboundMessage({
      threadId: 'thread_xxx',
      mentions: [],
      senderShortId: 'b_worker_a',
    });

    // 模拟 Thread 参与者
    router['threadParticipants'].set('thread_xxx', new Set(['b_worker_a', 'b_worker_b', 'kimi']));

    const recipients = router.route(msg);

    expect(recipients.has('b_worker_b')).toBe(true);
    expect(recipients.has('kimi')).toBe(true);
  });
});

// tests/TaskScheduler.test.ts
describe('TaskScheduler', () => {
  test('预算耗尽后强制关闭Thread', async () => {
    const scheduler = new TaskScheduler({ threadManager, reviewEngine, eventBus });
    const task = await scheduler.createTask({
      coordinatorId: 'kimi',
      instruction: '测试任务',
      assignees: ['b_worker'],
      checkpoints: ['完成'],
    });

    // 消耗所有预算
    for (let i = 0; i < 10; i++) {
      await scheduler.onMessageSent(task.id);
    }

    expect(task.status).toBe('done');
    expect(eventBus.emit).toHaveBeenCalledWith('budget:exhausted', expect.any(Object));
  });

  test('3轮迭代后强制处理', async () => {
    const scheduler = new TaskScheduler({ threadManager, reviewEngine, eventBus });
    const task = await scheduler.createTask({
      coordinatorId: 'kimi',
      instruction: '测试任务',
      assignees: ['b_worker'],
      checkpoints: ['完成'],
    });

    // 模拟 3 轮 Feedback
    await scheduler.transition(task, 'iterating');
    task.reviewRound = 3;
    await scheduler.onReviewVerdict(task.id, 'feedback', '还有问题');

    expect(task.status).toBe('done');
    expect(task.metadata.verdict).toMatch(/forced_greenlight|coordinator_takeover/);
  });
});
```

### 10.2 集成测试

```typescript
// tests/integration/message-flow.test.ts

describe('消息端到端流程', () => {
  let gateway: Gateway;
  let clientSocket: Socket;

  beforeAll(async () => {
    gateway = await startTestGateway();
    clientSocket = io('http://localhost:3001');
  });

  afterAll(async () => {
    clientSocket.disconnect();
    await gateway.close();
  });

  test('用户发送消息 → Worker 收到 → Worker 回复 → 用户看到', (done) => {
    const testChatId = 'test_chat_1';

    // 1. 用户加入群聊
    clientSocket.emit('join-session', testChatId);

    // 2. 用户发送消息
    clientSocket.emit('send-message', {
      chatId: testChatId,
      content: '@FrontendAgent 你好',
      mentions: ['b_frontend'],
    });

    // 3. 等待 Worker 回复
    clientSocket.on('new-message', (msg) => {
      if (msg.senderShortId === 'b_frontend') {
        expect(msg.content).toBeTruthy();
        done();
      }
    });
  });

  test('预算耗尽后 Thread 自动关闭', async () => {
    const threadId = await createTestThread({ budget: 3 });

    // 发送 3 条消息消耗预算
    for (let i = 0; i < 3; i++) {
      clientSocket.emit('send-message', {
        chatId: 'test_chat',
        threadId,
        content: `消息 ${i}`,
      });
    }

    // 等待预算耗尽事件
    await new Promise<void>((resolve) => {
      clientSocket.on('budget-exhausted', (event) => {
        expect(event.threadId).toBe(threadId);
        resolve();
      });
    });
  });
});
```

### 10.3 E2E 测试

```typescript
// tests/e2e/chat.spec.ts (Playwright)
import { test, expect } from '@playwright/test';

test('完整聊天流程', async ({ page }) => {
  // 1. 打开前端
  await page.goto('http://localhost:5173');

  // 2. 创建新会话
  await page.click('[data-testid="new-session-btn"]');
  await page.fill('[data-testid="session-name-input"]', '测试会话');
  await page.click('[data-testid="confirm-create-btn"]');

  // 3. 发送消息
  await page.fill('[data-testid="message-input"]', '@FrontendAgent 写个按钮');
  await page.click('[data-testid="send-btn"]');

  // 4. 等待 Worker 回复
  await page.waitForSelector('[data-testid="message-bubble"]', { timeout: 30000 });

  // 5. 验证消息渲染
  const messages = await page.locator('[data-testid="message-bubble"]').all();
  expect(messages.length).toBeGreaterThan(1);

  // 6. 验证产物预览
  await page.click('[data-testid="artifact-preview-btn"]');
  const iframe = await page.locator('iframe').first();
  expect(await iframe.isVisible()).toBe(true);
});
```

---

# Part 7 — 附录

---

## 11. 竞品对比矩阵

| 特性 | Kimi Claw | AutoGen (AG2) | CrewAI | MetaGPT | LangGraph |
|------|-----------|---------------|--------|---------|-----------|
| **开发者** | Moonshot AI | Microsoft | CrewAI Inc | DeepWisdom/Alibaba | LangChain |
| **协作模式** | 集中式（Coordinator-Worker） | 集中式（GroupChatManager） | 集中式（Crew/Flow） | 分布式（SOP驱动） | 图状态机 |
| **通信方式** | 分层消息路由 | 共享消息池+广播 | 角色委托+上下文 | 全局消息池+发布-订阅 | 状态传递+条件边 |
| **指挥者概念** | ✅ Coordinator | ✅ GroupChatManager | ✅ Crew | ❌ SOP驱动 | ✅ 人类审查节点 |
| **原生群聊UI** | ✅ Electron 桌面端 | ❌ 纯代码 | ❌ 纯代码 | ❌ 纯代码 | ❌ 纯代码 |
| **讨论预算** | ✅ 10 turn | ✅ max_round | ✅ max_iter | ❌ SOP隐性限制 | ❌ 需自定义 |
| **线程隔离** | ✅ Thread 独立空间 | ✅ initiate_chats | ❌ Crew 实例 | ❌ 项目隔离 | ✅ thread_id+checkpointer |
| **质量审阅** | ✅ 4维度+3轮迭代 | ❌ is_termination_msg | ✅ guardrails | ✅ Executable Feedback | ✅ interrupt() HITL |
| **Worker 可见性** | ✅ 分层过滤 | ❌ 全量广播 | ❌ 上下文传递 | ❌ 发布-订阅 | ❌ 状态传递 |
| **技能系统** | ✅ SKILL.md 驱动 | ❌ 自定义函数 | ❌ 自定义工具 | ❌ 角色定义 | ❌ 工具绑定 |
| **部署模式** | 本地 Gateway+云 LLM | Python 库 | Python 库 | Python 库 | Python 库 |
| **子 Agent** | ✅ 独立会话+ACP | ✅ 子对话 | ✅ 任务委托 | ✅ 多角色协作 | ✅ 子图 |
| **记忆持久化** | ✅ 文件系统+语义搜索 | 内存/可选存储 | 内存 | 文件/数据库 | 数据库 |
| **安全模型** | ✅ 多层信任+技能审核 | 依赖应用层 | 依赖应用层 | 依赖应用层 | 依赖应用层 |
| **HITL 支持** | ✅ Coordinator 人工审阅 | ❌ | ❌ | ❌ | ✅ interrupt() |
| **跨平台消息** | ✅ 多平台适配器 | ❌ | ❌ | ❌ | ❌ |

### 竞品分析总结

**Kimi Claw 的独特优势**：
1. **Gateway 架构**：中心化消息枢纽，天然适合多平台消息汇聚
2. **群聊式交互**：唯一原生支持 IM 群聊 UI 的多 Agent 系统
3. **分层可见性**：Worker 只接收相关消息，防止信息过载
4. **技能即代码**：SKILL.md 降低非开发者扩展门槛
5. **本地优先**：数据、记忆、凭证都在本地，隐私可控

**各框架最值得借鉴的特性**：
- AutoGen：GroupChatManager 的 speaker_selection_method
- LangGraph：thread_id + checkpointer 的线程隔离
- MetaGPT：Executable Feedback 的自动化审阅循环
- CrewAI：role + goal + backstory 的角色三元组

---

## 12. 关键设计决策记录

| 决策点 | 选择 | 备选方案 | 原因 | 权衡 |
|--------|------|---------|------|------|
| Worker 主动性 | 被动响应 | 主动抢任务 | 防止抢任务、确保 Coordinator 全局可控 | 灵活性降低，但系统稳定性提高 |
| 消息可见性 | 分层过滤 | 全量广播 | 防止信息过载、任务隔离 | 增加 Coordinator 桥接工作量 |
| Thread 创建权 | Coordinator 专属 | Worker 可创建 | 防止讨论碎片化 | Worker 灵活性降低 |
| Peer 对话 | 严格限制（一问一答） | 自由对话 | 避免多跳链、防止讨论发散 | 协作灵活性降低 |
| 预算上限 | 10 turn | 20 turn / 无限制 | 上下文窗口+成本+注意力三角平衡 | 复杂讨论可能需要多次 Thread |
| 迭代上限 | 3 轮 | 5 轮 / 无限制 | 收益递减+避免死锁 | 细节问题可能无法完全修复 |
| 收敛信号 | 显式标记 | 语义理解自动判断 | 让 Coordinator 和系统都能识别 | Worker 需要学习规范 |
| Skill 系统 | SKILL.md 声明式 | 代码注册式 | 降低非开发者扩展门槛 | 运行时灵活性降低 |
| 后端通信 | WebSocket+MQ 混合 | 纯 WebSocket / 纯 HTTP | 实时+可靠+可扩展 | 架构复杂度增加 |
| 状态持久化 | PostgreSQL+Redis | SQLite+内存 / MongoDB | 关系型查询+高频缓存 | 运维成本增加 |
| 前端 | React+WebSocket | Vue / Angular | 生态成熟、组件化适合 IM UI | 学习曲线 |
| Worker 隔离 | 工作目录沙箱 | Docker 容器 | 简单、低开销、足够安全 | 不如容器隔离彻底 |
| LLM 调用 | OpenAI SDK 适配器 | 直连各厂商 API | 兼容多模型，统一接口 | 需要维护适配器 |

---

## 13. MVP 复刻路径

### 第一阶段：核心骨架（2 周）

**Week 1：Gateway + 消息**
- [ ] 搭建 Express + Socket.io 服务
- [ ] 实现 MessageRouter（@mention 解析 + 可见性过滤）
- [ ] 实现基础消息 CRUD（PostgreSQL）
- [ ] 前端基础聊天界面（React + Tailwind）
- [ ] 消息颜色区分（User/Coordinator/Worker）

**Week 2：Coordinator + Worker**
- [ ] Coordinator 角色（特殊权限、消息路由）
- [ ] Worker Session 管理（独立上下文）
- [ ] 手动 @Worker 分配任务
- [ ] Worker 回复并渲染到前端
- [ ] 简单 Thread 创建（手动）

**验收标准**：
- 用户可以在群聊中 @Worker，Worker 收到消息并回复
- 消息可见性规则生效（未被@的 Worker 看不到消息）
- 前端可以渲染不同角色的消息气泡

### 第二阶段：质量与协作（3 周）

**Week 3：审阅-迭代系统**
- [ ] ReviewEngine（4 维度判定逻辑）
- [ ] Greenlight/Feedback 流程
- [ ] 3 轮迭代上限控制
- [ ] 收敛信号解析（`结论:`、`交回指挥:`）

**Week 4：上下文隔离**
- [ ] Worker 消息过滤层完整实现
- [ ] 同消息多@时的 Worker 间可见性
- [ ] Thread 消息隔离（Thread 内消息不泄漏到主群）
- [ ] 文件系统工作目录隔离

**Week 5：技能系统**
- [ ] SKILL.md 规范 + 解析器
- [ ] 技能注册与发现机制
- [ ] 核心技能实现（kimiim-cli、web_search、file_ops）
- [ ] 技能运行时权限控制

**验收标准**：
- Worker 交付物可以被 Coordinator 审阅并给出 Feedback
- 3 轮迭代后强制处理
- Thread 内消息完全隔离
- 技能可以动态加载和调用

### 第三阶段：工程化与体验（2 周）

**Week 6：前端与体验**
- [ ] React 前端：群聊 UI、Thread 折叠、任务面板
- [ ] 消息颜色编码、@mention 高亮
- [ ] 产物卡片（iframe 预览 + 代码切换）
- [ ] 成员列表、在线状态、预算指示器

**Week 7：稳定性**
- [ ] Redis Stream 消息队列保证可靠投递
- [ ] Worker 节点水平扩展
- [ ] 心跳机制、离线检测、重新分配
- [ ] Docker Compose 部署
- [ ] 基础测试覆盖

**验收标准**：
- 前端体验流畅，产物预览可用
- 消息不丢失，Worker 离线可检测
- Docker 一键启动
- 基础测试通过

### 最终交付物清单

| 交付物 | 内容 | 格式 |
|--------|------|------|
| 产品规格书 | 架构、交互、Prompt | Markdown |
| 技术规格书 | 接口、Schema、部署 | Markdown |
| 可运行代码 | 完整前后端 | Git 仓库 |
| 部署文档 | Docker 配置、环境变量 | Markdown + YAML |
| 测试报告 | 单元+集成+E2E 测试结果 | Markdown |
| Demo 视频 | 3 分钟功能演示 | MP4 |
