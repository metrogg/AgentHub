# AgentHub-飞书多Agent协作插件集成可行性调研报告

> 调研日期：2026-05-27
> 调研范围：飞书开放平台 API、多Agent协作在IM平台的落地案例、AgentHub现有架构适配性
> 结论：**技术完全可行，且对比赛有显著加分价值**

---

## 一、执行摘要

**核心结论**：将 AgentHub 的多Agent协作能力以"飞书插件/机器人"形态落地，**技术上完全可行**，已有大量开源先例（OpenClaw、Claude Code Bridge、Coze 飞书集成等）。

**推荐方案**：采用"**单 Bot 网关 + 后端多Agent编排**"的轻量桥接模式，而非在飞书侧部署多个机器人。原因：
1. 飞书原生**不支持 Bot@Bot**，多机器人同群协作需借助后端编排
2. 单 Bot 模式开发成本低、API 调用量可控（免费版 10,000 次/月）
3. 与 AgentHub 现有 orchestrator 架构天然契合

**比赛价值**：极高。IM 平台集成是多Agent协作的"杀手级展示场景"——评委可以直接在飞书群里 @机器人体验多Agent协作，远比 Web 页面更有说服力。

---

## 二、调研背景与目标

### 2.1 背景

AgentHub 当前形态是一个独立 Web 应用（React + Hono + WebSocket）。用户需要打开浏览器访问网页才能使用多Agent协作能力。

考虑增加一个**基于现有 IM 平台（飞书）的产品形态**，让用户能在日常工作的群聊中直接触发多Agent协作任务，降低使用门槛，增强产品真实感。

### 2.2 调研目标

1. **可行性**：飞书开放平台是否支持多Agent协作所需的全部能力？
2. **架构设计**：AgentHub 如何与飞书集成？数据流、会话管理、权限控制怎么做？
3. **工作量**：实现一个 MVP 需要多少人天？
4. **比赛价值**：这个形态对字节AI全栈挑战赛的 Demo 展示是否有帮助？

---

## 三、飞书开放平台能力评估

### 3.1 机器人类型与事件订阅

| 能力 | 自定义机器人（Webhook） | 企业自建应用机器人 | 是否满足需求 |
|------|------------------------|-------------------|-------------|
| 接收用户消息 | ❌ 不支持 | ✅ 支持（事件订阅） | ✅ |
| 群聊 @触发 | ❌ 不支持 | ✅ 支持 | ✅ |
| 卡片消息交互 | ❌ 仅推送 | ✅ 支持回调 | ✅ |
| 文件上传/下载 | ❌ 不支持 | ✅ 支持 | ✅ |
| 事件订阅方式 | 无 | HTTP回调 / WebSocket长连接 | ✅ |

**结论**：必须使用**企业自建应用 + 机器人能力**，不能依赖简单的 Webhook 自定义机器人。

### 3.2 消息类型与多Agent展示

| 消息类型 | 能力描述 | AgentHub 适用场景 |
|---------|---------|------------------|
| `text` | 纯文本，支持 @用户 | 简单通知、Agent 回复 |
| `post` | 富文本（结构化 JSON） | 任务列表、格式化报告 |
| `interactive` | **卡片消息**，支持按钮、输入框、Markdown | **任务确认、进度展示、用户审批** |
| `image` | 图片（需先上传获取 image_key） | 生成图表、架构图展示 |
| `file` | 文件（需先上传获取 file_key） | 代码 diff、生成文件交付 |

**关键发现**：
- 飞书卡片消息（`interactive`）支持**按钮点击回调**，这是多Agent协作中"用户确认任务计划"的核心交互方式
- 代码块在飞书消息中没有原生支持，**建议将代码保存为文件上传**，或使用卡片 Markdown 组件做简单展示
- 卡片消息支持**状态更新**（如从"待确认"变为"已执行"），非常适合展示 Agent 任务进度

### 3.3 API 限制与多Agent性能

| 限制项 | 数值 | 对多Agent场景的影响 |
|-------|------|-------------------|
| 免费版月调用量 | 10,000 次/月 | MVP 阶段够用，商用需认证企业或购买商业版 |
| 自定义机器人频率 | 5 QPS / 100 QPM | 流式输出需注意频率控制 |
| 应用消息频率 | 依等级 5-100 QPS | 单 Bot 网关模式不会触发上限 |
| 单群机器人上限 | **99 个** | 理论支持多 Bot，但不推荐 |
| 单次拉群机器人 | 最多 5 个 | API 限制 |
| 文件上传大小 | 最大 300MB | 足够交付代码项目 |

**关键风险**：
- 免费版 10,000 次/月的调用量，如果做流式输出（每段文字都调用一次更新接口），很容易耗尽
- **解决方案**：采用"攒批更新"策略，每 1-2 秒聚合一次输出，批量更新卡片，而非逐字流式

### 3.4 原生多Agent支持现状

**重要限制**：飞书**原生不支持 Bot@Bot**（机器人之间无法互相 @提及触发对话）。

这意味着：
- ❌ 不能在飞书群里直接实现 "Agent A @Agent B 说：'你去写接口'"
- ✅ 必须通过**后端编排层**实现多Agent协作，前端只暴露一个 Bot 入口

这与 AgentHub 现有的 orchestrator 架构**完全吻合**——飞书 Bot 只是"触发器 + 展示层"，真正的多Agent调度由 AgentHub 后端完成。

---

## 四、可行性分析

### 4.1 技术可行性：✅ 完全可行

| 需求 | 飞书支持情况 | AgentHub 适配难度 |
|------|------------|------------------|
| 用户 @Bot 触发任务 | ✅ 原生支持 | 低，增加事件接收端点 |
| Bot 回复消息 | ✅ 原生支持 | 低，复用现有 LLM 输出 |
| 发送任务计划卡片（用户确认） | ✅ 卡片消息+回调 | 中，需设计卡片模板 |
| 展示多Agent执行进度 | ✅ 卡片状态更新 | 中，需对接 orchestrator 事件 |
| 发送代码/文件结果 | ✅ 文件上传接口 | 低，复用现有 artifact 输出 |
| 多Agent间通信 | ⚠️ 需后端编排 | 低，复用现有 Blackboard |
| 流式输出 | ⚠️ 需攒批更新 | 中，避免触发频率限制 |

### 4.2 产品可行性：✅ 可行

已有成熟先例：
- **OpenClaw + 飞书**：业界最完善的多Agent飞书集成方案，支持单 Bot 多 Agent 路由
- **Coze（扣子）+ 飞书**：字节的官方 Agent 平台，已支持发布到飞书群聊
- **Claude Code Bridge + 飞书**：开源项目，实现了飞书群聊中的代码助手
- **Hermes Agent + 飞书**：支持 WebSocket 长连接模式

这些案例证明：用户确实愿意在 IM 群聊中使用 AI Agent，且技术路径已跑通。

### 4.3 比赛价值：⭐⭐⭐⭐⭐ 极高

字节AI全栈挑战赛的评委看重的几个维度：

| 评分维度 | 纯 Web 形态 | Web + 飞书插件 |
|---------|-----------|---------------|
| 产品完整度 | 较好 | **极佳**（多形态覆盖） |
| 真实应用场景 | 一般（需要打开网页） | **强**（在工作流中直接使用） |
| 技术深度 | 中等 | **高**（涉及 IM 协议、事件驱动、异步编排） |
| Demo 展示效果 | 需要演示者操作 | **极佳**（评委可以直接 @机器人体验） |
| 与字节生态结合 | 无 | **强**（飞书是字节核心产品） |

**特别加分点**：
1. **飞书是字节跳动自己的产品**，在字节举办的比赛中展示飞书集成，有极强的生态契合度
2. 可以让评委**亲自进群 @机器人体验**，互动性远超静态演示
3. 体现了"**从工具到工作流**"的产品思维升级

---

## 五、技术架构设计

### 5.1 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         用户层（飞书客户端）                       │
│   群聊中 @AgentHubBot "帮我写一个植物大战僵尸游戏"                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │ ① 消息事件
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      接入层（飞书网关）                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ 事件接收服务  │  │ 消息格式化   │  │ 卡片模板引擎  │          │
│  │ (WebSocket)  │  │ (Markdown→   │  │ (任务进度/    │          │
│  │              │  │  飞书Post)   │  │  确认/结果)   │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└──────────────────────────────┬──────────────────────────────────┘
                               │ ② 标准化事件
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      核心层（AgentHub 现有架构）                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Session管理   │  │ Orchestrator │  │ AgentRuntime │          │
│  │ (复用现有)   │  │ (复用现有)   │  │ (复用现有)   │          │
│  │              │  │              │  │              │          │
│  │  - 用户映射   │  │  - Planner   │  │  - LLM       │          │
│  │  - 群聊会话   │  │  - Scheduler │  │  - CodeAgent │          │
│  │  - 上下文    │  │  - Conflict  │  │  - NativeTool│          │
│  │              │  │  - Synthesizer│  │              │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│  ┌──────────────┐  ┌──────────────┐                            │
│  │ Blackboard   │  │ Git Branch   │                            │
│  │ (复用现有)   │  │ Manager      │                            │
│  └──────────────┘  └──────────────┘                            │
└──────────────────────────────┬──────────────────────────────────┘
                               │ ③ 执行结果
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      回调层（飞书网关）                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ 卡片更新     │  │ 文件上传     │  │ 消息聚合     │          │
│  │ (状态/进度)  │  │ (代码交付)   │  │ (攒批输出)   │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└──────────────────────────────┬──────────────────────────────────┘
                               │ ④ 飞书消息
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                         用户层（飞书客户端）                       │
│   收到卡片消息：                                                   │
│   ┌─────────────────────────────────────────┐                   │
│   │ [AgentHub] 任务计划                      │                   │
│   │ 1. Architect: 设计游戏架构 ✅            │                   │
│   │ 2. Coder: 编写核心逻辑 ⏳               │                   │
│   │ 3. Reviewer: 代码审查 ⏸️                │                   │
│   │ [查看详情] [取消任务]                    │                   │
│   └─────────────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 两种集成模式对比

#### 模式 A：单 Bot 网关模式（⭐ 推荐）

**架构**：一个飞书机器人 + AgentHub 后端编排

**工作流程**：
1. 用户进群，添加 "AgentHub" 机器人
2. 用户在群里 @AgentHub "帮我写一个植物大战僵尸游戏"
3. 飞书推送 `im.message.receive_v1` 事件到 AgentHub 网关
4. AgentHub 创建 session，启动 orchestrator
5. Orchestrator 调度多个 Agent（Architect、Coder、Reviewer）
6. 每个 Agent 的执行进度通过卡片消息实时更新到群里
7. 最终代码通过文件消息发送到群里

**优点**：
- ✅ 开发成本低（只需维护一个飞书应用）
- ✅ API 调用量可控（单 Bot 不会超限）
- ✅ 与现有 orchestrator 架构完美契合
- ✅ 用户认知简单（"@AgentHub 就能用"）

**缺点**：
- ⚠️ 群聊里看不到多个 Agent "互相讨论" 的效果（因为飞书不支持 Bot@Bot）
- ⚠️ 所有 Agent 输出都通过一个 Bot 发送，需要良好的格式区分

#### 模式 B：多 Bot 协作模式

**架构**：为每个 Agent 角色创建一个飞书机器人（ArchitectBot、CoderBot、ReviewerBot）

**工作流程**：
1. 创建一个"指挥群"，把所有 Agent Bot 拉进去
2. 用户在另一个"用户群"@ManagerBot
3. ManagerBot 在自己的"指挥群"里发消息调度其他 Bot（通过后端的内部通信，而非飞书 @）
4. 各 Agent Bot 的执行结果汇总后由 ManagerBot 回复用户

**优点**：
- ✅ 每个 Agent 有独立身份，更像"团队"
- ✅ 可以在飞书通讯录里看到"Agent 团队成员"

**缺点**：
- ❌ 开发和维护成本高（N 个应用，N 套凭证）
- ❌ API 调用量翻倍（每个 Bot 都在发消息）
- ❌ 飞书免费版限制更紧张
- ❌ 需要维护"指挥群"的生命周期
- ❌ 用户需要理解多个 Bot 的分工

**结论**：比赛场景下**强烈推荐模式 A**。模式 B 的复杂度与收益不成正比，且多 Bot 的"协作感"可以通过单 Bot 发送不同样式的卡片来模拟。

### 5.3 关键模块设计

#### 5.3.1 飞书网关服务（FeishuGateway）

新增模块：`apps/server/src/services/feishu-gateway.ts`

**职责**：
- 接收飞书事件（WebSocket 长连接或 HTTP 回调）
- 解析消息内容，提取用户指令
- 将飞书用户映射到 AgentHub 的 `default-user`（或创建映射表）
- 调用 AgentHub 的 orchestrator 接口
- 将 orchestrator 的输出格式化为飞书消息

**WebSocket 长连接（推荐）**：
```typescript
// 使用飞书 SDK 建立长连接，无需公网回调地址
import * as lark from '@larksuiteoapi/node-sdk';

const client = new lark.ws.Client(APP_ID, APP_SECRET, {
  eventHandler: {
    'im.message.receive_v1': async (data) => {
      const userId = data.event.sender.sender_id.open_id;
      const content = JSON.parse(data.event.message.content);
      const text = content.text;
      
      // 转发到 AgentHub 调度器
      await dispatchToAgentHub(userId, text);
    },
    'card.action.trigger': async (data) => {
      // 处理卡片按钮点击（如"确认任务"、"取消"）
      await handleCardAction(data);
    }
  }
});
```

#### 5.3.2 会话映射管理

**问题**：飞书的 `open_id` 与 AgentHub 的 `user.sub` 不同。

**方案**：
```typescript
// 新增表：feishu_bindings
interface FeishuBinding {
  id: string;
  feishuOpenId: string;      // 飞书用户唯一标识
  agenthubUserId: string;    // AgentHub 用户标识（default-user）
  feishuChatId: string;      // 群聊ID
  sessionId: string;         // 当前活跃 session
  createdAt: Date;
}
```

**绑定策略**：
- 首次 @机器人时，自动创建 binding，绑定到 `default-user`
- 单租户场景下，所有飞书用户共用同一个 AgentHub 用户身份
- 如果未来做多租户，再扩展为按企业域隔离

#### 5.3.3 消息格式转换

**输入转换（飞书 → AgentHub）**：
```typescript
function feishuMessageToAgentHub(data: FeishuMessage): AgentHubInput {
  return {
    userId: resolveAgentHubUserId(data.sender.open_id),
    content: extractText(data.message.content),
    chatId: data.message.chat_id,
    messageId: data.message.message_id,
    // 群聊 or 单聊
    chatType: data.message.chat_type, // 'group' | 'p2p'
  };
}
```

**输出转换（AgentHub → 飞书）**：

| AgentHub 输出类型 | 飞书消息类型 | 实现方式 |
|------------------|------------|---------|
| 文本回复 | `text` | 直接发送 |
| 格式化报告 | `post` | 构建富文本 JSON |
| 任务计划（需确认） | `interactive` 卡片 | 构建卡片 JSON + 按钮回调 |
| 任务进度更新 | `interactive` 卡片更新 | 调用更新消息接口 |
| 代码/文件 | `file` | 上传文件后发送 file_key |
| 图片/图表 | `image` | 上传图片后发送 image_key |

#### 5.3.4 卡片模板设计

**任务计划确认卡片**：
```json
{
  "config": { "wide_screen_mode": true },
  "header": {
    "title": { "tag": "plain_text", "content": "AgentHub - 任务计划" },
    "template": "blue"
  },
  "elements": [
    { "tag": "div", "text": { "tag": "lark_md", "content": "**需求**：写一个植物大战僵尸游戏" } },
    { "tag": "div", "text": { "tag": "lark_md", "content": "**预估任务**：\n1. Architect - 设计架构\n2. Coder - 编写核心逻辑\n3. Reviewer - 代码审查" } },
    {
      "tag": "action",
      "actions": [
        { "tag": "button", "text": { "tag": "plain_text", "content": "确认执行" }, "type": "primary", "value": { "action": "confirm", "planId": "xxx" } },
        { "tag": "button", "text": { "tag": "plain_text", "content": "取消" }, "type": "default", "value": { "action": "cancel", "planId": "xxx" } }
      ]
    }
  ]
}
```

**任务进度卡片**：
```json
{
  "config": { "wide_screen_mode": true },
  "header": {
    "title": { "tag": "plain_text", "content": "执行中 - 植物大战僵尸" },
    "template": "indigo"
  },
  "elements": [
    { "tag": "div", "text": { "tag": "lark_md", "content": "**Architect** ✅ 已完成\n**Coder** ⏳ 编写中...\n**Reviewer** ⏸️ 等待中" } },
    { "tag": "div", "text": { "tag": "lark_md", "content": "_最后更新：14:32:05_" } }
  ]
}
```

#### 5.3.5 流式输出策略

**问题**：飞书 API 有 5 QPS / 100 QPM 限制，不能做逐 token 流式更新。

**解决方案——攒批更新（Batch Update）**：

```typescript
class BatchedMessageUpdater {
  private buffer: string = '';
  private lastUpdate: number = 0;
  private updateInterval: number = 2000; // 每 2 秒更新一次
  private messageId: string;

  append(text: string) {
    this.buffer += text;
    const now = Date.now();
    if (now - this.lastUpdate > this.updateInterval) {
      this.flush();
    }
  }

  private async flush() {
    if (!this.buffer) return;
    await updateFeishuCard(this.messageId, this.buffer);
    this.buffer = '';
    this.lastUpdate = Date.now();
  }

  async finalize() {
    await this.flush();
  }
}
```

**效果**：
- 用户视角：卡片每 2 秒刷新一次，看到内容在逐渐增多（类似"打字机效果"）
- API 消耗：一个长回复最多调用 30 次更新接口（60 秒 / 2 秒），完全在 100 QPM 限制内

### 5.4 数据流设计

```
用户 @AgentHub "写个游戏"
  │
  ▼
飞书推送 im.message.receive_v1
  │
  ▼
FeishuGateway 解析消息
  │
  ▼
创建/复用 Session（根据 chat_id）
  │
  ▼
调用 orchestrator.createPlan(content)
  │
  ▼
发送"任务计划卡片"到群里（等待用户确认）
  │
  ▼
用户点击"确认执行"
  │
  ▼
飞书推送 card.action.trigger
  │
  ▼
FeishuGateway 调用 orchestrator.dispatch(planId)
  │
  ▼
Orchestrator 调度多个 Agent 执行
  │
  ▼
每个 Agent 的进度/结果写入 Blackboard
  │
  ▼
FeishuGateway 监听 Blackboard 变更
  │
  ▼
批量更新飞书卡片（进度/结果）
  │
  ▼
最终代码打包上传，以文件消息发送到群里
```

---

## 六、实现路径与工作量评估

### 6.1 最小可行产品（MVP）功能范围

**MVP 必须实现**：
1. 飞书机器人接收 @消息
2. 创建任务计划卡片，用户点击确认
3. 调度单 Agent（或简化版多 Agent）执行任务
4. 执行结果以文本/文件形式回复

**比赛 Demo 增强（建议实现）**：
5. 多Agent进度实时展示（卡片状态更新）
6. 代码文件上传交付
7. 任务取消/重新调度交互

### 6.2 模块拆分与工作量

| 模块 | 具体工作 | 预估工时 | 依赖 |
|------|---------|---------|------|
| **飞书应用注册** | 创建应用、配置权限、发布测试版本 | 2h | 无 |
| **事件接收网关** | WebSocket 长连接、消息解析、签名验证 | 4h | 无 |
| **用户/会话映射** | feishu_bindings 表、用户映射逻辑 | 3h | DB 迁移 |
| **消息格式化引擎** | Markdown→飞书 Post、卡片模板 | 6h | 无 |
| **Orchestrator 适配** | 将 WebSocket 输出桥接到飞书卡片更新 | 4h | 现有 orchestrator |
| **攒批输出策略** | BatchedMessageUpdater、频率控制 | 3h | 消息引擎 |
| **文件上传** | 代码文件→飞书文件消息 | 2h | 无 |
| **前端展示（可选）** | 飞书侧无需前端，但 Web 端可展示"飞书集成状态" | 3h | 无 |
| **测试与联调** | 端到端测试、频率限制测试 | 4h | 全部 |
| **文档** | 部署指南、使用说明 | 2h | 全部 |

**总计**：约 **33 工时**（约 4-5 人天，1 个后端开发）。

### 6.3 技术栈选择

| 组件 | 推荐方案 | 理由 |
|------|---------|------|
| 飞书 SDK | `@larksuiteoapi/node-sdk` | 官方 Node.js SDK，支持 WebSocket 长连接 |
| 事件接收 | WebSocket 长连接 | 无需公网域名和内网穿透，开发测试更方便 |
| 卡片构建 | 手写 JSON 模板 | 飞书卡片结构不复杂，不需要额外库 |
| 图片/文件上传 | 官方 SDK 封装 | SDK 已提供 multipart 上传 |
| 部署 | 复用现有 AgentHub 服务器 | 与现有 Hono 服务同进程部署，新增路由即可 |

---

## 七、风险与限制

### 7.1 已知限制

| 限制 | 影响 | 缓解方案 |
|------|------|---------|
| 飞书免费版 10,000 次/月 | Demo 期间可能够用，但重度使用会超限 | 攒批更新、控制调试频率；比赛前可申请企业认证 |
| 不支持 Bot@Bot | 无法展示多 Agent "互相讨论" 的视觉效果 | 通过单 Bot 的多卡片/多段落格式模拟 |
| 流式输出受限（5 QPS） | 无法做到逐 token 打字机效果 | 攒批更新，每 1-2 秒刷新一次 |
| 代码块无原生支持 | 代码展示效果不佳 | 将代码保存为文件上传，或简化代码展示 |
| 卡片消息字数限制 | 长回复可能截断 | 超过限制时转为文件消息或分页 |
| 需要飞书企业账号 | 个人开发者无法创建企业自建应用 | 使用字节提供的企业测试环境，或借用企业账号 |

### 7.2 比赛特定风险

| 风险 | 可能性 | 应对方案 |
|------|--------|---------|
| 现场网络问题导致飞书连接断开 | 中 | 准备离线 Demo 视频作为备份 |
| 评委没有飞书账号 | 低 | 提前创建演示群，邀请评委入群 |
| API 频率超限导致消息发不出 | 中 | 攒批策略 + 本地限流队列 + 降级为纯文本 |
| 飞书开放平台审核延迟 | 低 | 提前申请应用，使用测试环境 |

---

## 八、与现有 AgentHub 架构的兼容性

### 8.1 复用模块

| AgentHub 现有模块 | 复用程度 | 说明 |
|------------------|---------|------|
| `orchestrator-engine.ts` | ✅ 100% 复用 | 飞书只是新的触发入口 |
| `planner.ts` | ✅ 100% 复用 | 任务计划生成逻辑不变 |
| `task-scheduler.ts` | ✅ 100% 复用 | 调度逻辑不变 |
| `agent-runner.ts` | ✅ 100% 复用 | 运行时不变 |
| `blackboard.ts` | ✅ 100% 复用 | Agent 间通信不变 |
| `execution-tracer.ts` | ✅ 100% 复用 | 执行日志不变 |
| `runtime-registry.ts` | ✅ 100% 复用 | LLM/CodeAgent/NativeTool 运行时不变 |
| `llm-client.ts` | ✅ 100% 复用 | LLM 调用不变 |
| `git/branch-manager.ts` | ✅ 100% 复用 | Git 隔离不变 |
| Database Schema | ⚠️ 新增 1 张表 | `feishu_bindings` 表 |
| `auth.ts` | ⚠️ 适配 | 飞书用户映射到 default-user |
| WebSocket Room | ❌ 不直接复用 | 飞书替代了 WebSocket 推送，但 Room 逻辑可以抽象复用 |

### 8.2 新增模块

| 新增模块 | 文件路径建议 | 职责 |
|---------|------------|------|
| 飞书网关服务 | `apps/server/src/services/feishu-gateway.ts` | 事件接收、消息转换 |
| 飞书消息格式化器 | `apps/server/src/services/feishu-formatter.ts` | 构建卡片/富文本 JSON |
| 飞书文件上传器 | `apps/server/src/services/feishu-uploader.ts` | 代码文件上传到飞书 |
| 飞书配置 | `apps/server/src/env.ts` | 新增 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` |
| 飞书路由 | `apps/server/src/routes/feishu.ts` | HTTP 回调端点（备选） |
| 飞书 Binding 表 | `packages/db/src/schema.ts` | `feishu_bindings` |
| Web 端集成状态 | `apps/web/src/pages/SettingsPage.tsx` | 展示飞书机器人连接状态 |

---

## 九、竞品与参考案例

### 9.1 OpenClaw + 飞书（最成熟参考）

- **GitHub**: `m1heng/clawdbot-feishu`
- **特点**：支持单 Bot 多 Agent 路由、Subagent 调度、飞书卡片交互
- **可借鉴**：路由绑定机制、卡片模板、Subagent 调用协议

### 9.2 Coze（扣子）+ 飞书

- **特点**：字节官方 Agent 平台，一键发布到飞书
- **可借鉴**：发布流程、卡片样式、用户交互范式
- **差异**：Coze 是单 Agent 模式，没有多Agent协作编排

### 9.3 Claude Code Bridge + 飞书

- **GitHub**: `joewongjc/feishu-claude-code`
- **特点**：WebSocket 长连接、实时对话、代码执行结果回传
- **可借鉴**：长连接实现、消息攒批策略、代码文件交付

### 9.4 Hermes Agent + 飞书

- **特点**：WebSocket + 群聊会话隔离、线程映射
- **可借鉴**：Session 管理、群聊上下文隔离

---

## 十、结论与建议

### 10.1 总体结论

| 维度 | 结论 |
|------|------|
| **技术可行性** | ✅ **完全可行**。飞书开放平台提供的事件订阅、卡片消息、文件上传等能力足以支撑多Agent协作的完整链路。 |
| **产品可行性** | ✅ **可行**。OpenClaw、Coze 等已有成熟先例，用户接受度高。 |
| **比赛价值** | ✅ **极高**。飞书是字节核心产品，集成飞书体现生态契合度；IM 场景 Demo 效果远胜 Web 页面。 |
| **工作量** | ⚠️ **适中**。MVP 约 4-5 人天，建议由 1 名后端开发在 1 周内完成。 |
| **风险可控性** | ✅ **可控**。主要限制（API 频率、免费版额度）都有成熟的缓解方案。 |

### 10.2 行动建议

#### 短期（比赛前优先）

1. **立即注册飞书开放平台应用**（2小时）
   - 访问 https://open.feishu.cn/app
   - 创建企业自建应用，添加机器人能力
   - 申请权限：`im:message`、`im:message.group_at_msg`、`im:chat:readonly`、`im:resource`
   - 记录 `AppID` 和 `AppSecret`

2. **开发 MVP**（1 周）
   - 实现 WebSocket 事件接收
   - 实现任务计划卡片 + 用户确认
   - 实现单 Agent 执行结果回传
   - **暂不实现**：多Agent进度实时卡片更新（可作为增强点）

3. **准备比赛 Demo 话术**
   - "大家可以直接在这个群里 @AgentHub 来体验多Agent协作"
   - 提前把评委拉进演示群

#### 中期（比赛后完善）

4. **增强多Agent进度展示**
   - 每个 Agent 的执行进度以卡片元素形式实时更新
   - 不同 Agent 使用不同颜色的进度指示器

5. **支持飞书文档集成**
   - 将 Agent 生成的文档写入飞书云文档
   - 读取飞书多维表格作为数据源

6. **支持更丰富的交互**
   - 任务中途干预（暂停、修改需求、重新调度）
   - 用户通过卡片按钮选择 Agent 角色

### 10.3 关于"插件"形态的澄清

用户提到"类似一个插件的形式"。需要明确：

- **飞书没有"浏览器插件"或"IDE 插件"形态**的 Bot 扩展机制
- 飞书 Bot 的**标准形态是"企业自建应用 + 机器人能力"**
- 这个形态虽然不叫"插件"，但本质上是**集成到飞书工作流中的扩展能力**
- 对用户来说，**"添加机器人到群聊"就是最简单直观的"插件"体验**

如果用户期望的是类似 Coze 那种"一键发布到飞书"的轻量级集成，**AgentHub 也可以做到**——只需完成上述飞书网关开发，用户在自己的飞书后台把 AgentHub 的机器人拉进群即可。

---

## 附录：参考链接

- [飞书开放平台 - 创建应用](https://open.feishu.cn/document/home/app-types-introduction/self-built-apps-and-store-apps)
- [飞书开放平台 - 配置事件订阅](https://open.feishu.cn/document/historical-version/develop-a-bot-in-5-minutes/step-5-configure-event-subscription)
- [飞书开放平台 - 消息 API](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/introduction)
- [飞书开放平台 - 发送富文本消息](https://open.larksuite.com/document/ukTMukTMukTM/uMDMxEjLzATMx4yMwETM)
- [飞书开放平台 - 频控策略](https://feishu.apifox.cn/doc-1939846)
- [OpenClaw 飞书多Agent实战](https://www.xmsumi.com/detail/2535)
- [OpenClaw + 飞书：从零搭建企业级 AI Agent 自动化工作流](https://juejin.cn/post/7611966480842260532)
- [飞书卡片回调(官方推荐的长连接方式)](https://blog.csdn.net/kingwin28/article/details/147922845)
- [Coze + 飞书组建数字员工军团](https://developer.volcengine.com/articles/7538284646853771315)
- [Claude Code 飞书桥接](https://github.com/joewongjc/feishu-claude-code)
- [飞书多Agent协作方案](https://github.com/hyperlist/feishu-multi-agent)
