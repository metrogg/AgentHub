# Orchestrator Plan 异步化改造方案

## 一、现状诊断

### 1.1 问题清单

| 编号 | 问题 | 严重程度 | 影响 |
|------|------|---------|------|
| P0 | `POST /orchestrator-plan` 同步阻塞 5~40 秒 | 致命 | 前端白屏/超时/ECONNRESET |
| P0 | 前端默认 30s HTTP 超时，LLM 规划可能超时 | 致命 | 用户看到"请求超时"，但后端仍在跑 |
| P1 | Plan 生成期间零反馈，只有静态"思考中" | 严重 | 用户不知道系统在干嘛 |
| P1 | Bun `--watch` 重启会中断正在生成的 Plan | 严重 | 开发环境频繁出问题 |
| P2 | "停止生成"按钮对 Plan 流程无效 | 中等 | 前端取消但后端继续跑，状态不一致 |
| P2 | Plan 是"从无到有"跳跃渲染，无渐进感 | 中等 | UX 断层 |

### 1.2 根因

```
用户发送 @orchestrator xxx
    │
    ▼
前端: api.createOrchestratorPlan() ────────► 后端 messages.ts
    (同步, 30s 超时)                           │
    │                                          ▼
    │                              buildDynamicOrchestratorPlan()
    │                              ├─ generateSpec() → LLM (10s)
    │                              └─ generateWithLlm() → LLM (20s)
    │                                          │
    │                              写入 messages 表
    │                                          │
    └──────────────────────────────◄ HTTP 200 + 完整 Plan JSON

问题：前端在这 30-40 秒内只有"思考中"三个字，HTTP 连接长时间挂起。
```

### 1.3 已有基础设施（可以复用的）

- **WebSocket 广播**：`broadcastSessionEvent(sessionId, event)` 已成熟
- **前端事件处理**：`chatStore.handleWSEvent` 已支持 `run:event` / `task:update` / `blackboard:update`
- **前端实时渲染**：`OrchestratorPlanCard` 通过 `useChatStore` 读取 `livePlan`，天然支持实时更新
- **后台异步执行**：`OrchestratorEngine.startRun()` 已经是 fire-and-forget 模式
- **数据库状态持久化**：`messages.metadata` 可以存储 `planStatus`

---

## 二、方案对比

### 方案 A：轻量级异步化（推荐）

**核心思路**：Plan 生成改为"立即响应 + 后台异步 + WebSocket 推送结果"。

```
用户发送 @orchestrator xxx
    │
    ▼
前端: api.createOrchestratorPlan() ────────► 后端 messages.ts
    (立即返回, <100ms)                         │
    │                                          ▼
    │                              1. 写入 placeholder message
    │                                 (planStatus: 'generating')
    │                              2. 返回 msg 给前端
    │                              3. 后台启动 LLM 规划
    │                                          │
    │                              LLM 生成中... (5~40s)
    │                                          │
    │                              4. 生成完成 → 更新 DB
    │                              5. WS 推送 plan:completed
    │                                          │
    ▼                                          ▼
前端收到 msg 立即渲染 placeholder          前端收到 WS 事件
(骨架屏 + "Orchestrator 正在规划...")       自动刷新为完整 Plan
```

**后端改动点**：
- `messages.ts` 的 `orchestrator-plan` handler：
  - 不再 `await buildDynamicOrchestratorPlan()`
  - 先 `insert(messages)` 返回 placeholder
  - 用 `void (async () => { ... })()` 后台执行 LLM
  - LLM 完成后 `update(messages)` + `broadcastSessionEvent('plan:completed')`
- 增加 `plan:completed` 事件类型到 `WsEvent` 常量

**前端改动点**：
- `chatStore.handleWSEvent`：增加 `plan:completed` 处理，更新对应 message 的 metadata
- `OrchestratorPlanCard`：根据 `planStatus` 渲染不同 UI
  - `generating`：骨架屏 + 动态提示文字
  - `generated`：完整 plan 卡片
- 取消 `createOrchestratorPlan` 的超时焦虑（API 立即返回）

**优点**：
- 改动量最小（后端 ~30 行，前端 ~50 行）
- 复用已有 WebSocket 基础设施
- 立即可解决超时和 ECONNRESET 问题
- Plan 生成期间有明确反馈

**缺点**：
- Plan 生成过程仍不可见（不能像聊天一样逐字显示）
- 如果后端重启，后台任务丢失（但这是开发环境问题，生产环境不会 `--watch`）

---

### 方案 B：流式 Plan（体验升级）

**核心思路**：让 LLM 流式输出 Plan，后端实时解析并推送增量更新。

**后端改动点**：
- 修改 `planner.ts` 的 prompt，让 LLM 先输出一个 skeleton（任务列表），再逐步填充每个 task 的 detail
- 或者使用 `streamReply` 的 AsyncGenerator，每收到一个 JSON 片段就尝试解析
- 每解析出一个完整的 task，就 `broadcastSessionEvent('plan:task_added', { task })`
- 前端实时看到 task 一个个"长出来"

**前端改动点**：
- 增加 `plan:task_added` 事件处理
- `OrchestratorPlanCard` 支持增量添加 task
- 骨架屏 + 动态填充效果

**优点**：
- UX 最佳，用户能看到 Plan"实时生长"
- 对标 ChatGPT/Claude 的流式体验

**缺点**：
- `planner.ts` 要求 strict JSON schema，流式解析 JSON 非常困难（JSON 是结构化的，不能边生成边 parse）
- 改动量大（后端 prompt + 解析器 + 前端增量渲染）
- 比赛 deadline 紧张，风险高

---

### 方案 C：完整 Job Queue（过度设计）

**核心思路**：引入 Redis/BullMQ，Plan 生成作为 Job 入队，Worker 异步消费。

**优点**：任务持久化、可重试、可追踪、可水平扩展
**缺点**：
- 引入 Redis 依赖，与当前 SQLite 单节点架构冲突
- 改动量巨大（Job 定义、Worker、状态机、前端轮询/WS 混合）
- 比赛项目不需要这个复杂度

**结论**：不适合当前阶段。

---

## 三、推荐方案：方案 A + 方案 B 的渐进提示

### 3.1 架构图

```
┌─────────────┐     POST /orchestrator-plan      ┌──────────────┐
│   前端       │ ────────────────────────────────► │  messages.ts │
│  (React)     │  <100ms 返回 placeholder msg     │  (Hono)      │
└──────────────┘                                   └──────┬───────┘
       ▲                                                  │
       │ WS: plan:completed                               │
       │                                                  │
┌──────┴───────┐                                   ┌──────▼───────┐
│ chatStore.ts │                                   │  后台 Microtask │
│ handleWSEvent│                                   │  buildDynamic  │
└──────────────┘                                   │  OrchestratorPlan
                                                   │  (LLM 5~40s)
                                                   └──────────────┘
```

### 3.2 时序图

```
用户          前端              后端 messages.ts         后台 LLM        DB          WebSocket
 │             │                    │                     │             │              │
 │──发送消息──►│                    │                     │             │              │
 │             │──POST /orchestrator-plan───────────────►│             │              │
 │             │                    │──insert placeholder msg──────────►│              │
 │             │◄──返回 msg (planStatus=generating)──────│             │              │
 │             │                    │──void (async () => { ... })─────►│              │
 │             │                    │                     │──call LLM──►│              │
 │             │◄──WS: message:completed (placeholder)──────────────────────────────│
 │             │                    │                     │             │              │
 │             │  渲染骨架屏"正在规划..."                │             │              │
 │             │                    │                     │             │              │
 │             │                    │◄──LLM 返回完整 Plan─│             │              │
 │             │                    │──update messages────►│             │              │
 │             │◄──WS: plan:completed────────────────────────────────────────────────│
 │             │                    │                     │             │              │
 │             │  自动刷新为完整 Plan 卡片                │             │              │
 │             │                    │                     │             │              │
```

### 3.3 实施步骤

#### Step 1: 后端 — 改造 `POST /orchestrator-plan`

**目标**：立即返回 placeholder，后台异步生成 Plan。

**修改文件**：`apps/server/src/routes/messages.ts`

当前代码（约 405-436 行）：
```typescript
const plan = await buildDynamicOrchestratorPlan(content, agentList, session.workspaceId)
// ... 写入 messages 表，返回
```

改造后：
```typescript
// 1. 立即返回 placeholder
const placeholderPlan: OrchestratorPlan = {
  title: `正在规划：${normalizeOrchestratorGoal(content)}`,
  summary: 'Orchestrator 正在分析需求并生成任务计划...',
  phases: [],
  tasks: [],
  outputContracts: [],
  validations: [],
  agentSelections: [],
  runStatus: 'planning',
}

const [msg] = await db.insert(messages).values({
  sessionId,
  senderId: 'orchestrator',
  senderType: 'agent',
  type: 'task_card',
  content: placeholderPlan.title,
  metadata: {
    plan: placeholderPlan,
    planStatus: 'generating',
    goal: normalizeOrchestratorGoal(content),
  },
}).returning()

// 2. 后台异步生成真实 Plan
void (async () => {
  try {
    const plan = await buildDynamicOrchestratorPlan(content, agentList, session.workspaceId)
    const planWithId = { ...plan, tasks: plan.tasks.map((t) => ({ ...t, id: crypto.randomUUID() })) }
    
    await db.update(messages)
      .set({
        metadata: {
          plan: planWithId,
          planStatus: 'generated',
          dispatchResult: msg.metadata?.dispatchResult,
        },
      })
      .where(eq(messages.id, msg.id))
    
    broadcastSessionEvent(sessionId, {
      type: 'plan:completed',
      payload: { messageId: msg.id, plan: planWithId },
    })
  } catch (err) {
    logger.error({ err: (err as Error).message, sessionId }, 'Async plan generation failed')
    // Fallback: 静态模板
    const fallbackPlan = buildOrchestratorPlan(content, agentList)
    await db.update(messages)
      .set({ metadata: { plan: fallbackPlan, planStatus: 'generated' } })
      .where(eq(messages.id, msg.id))
    broadcastSessionEvent(sessionId, {
      type: 'plan:completed',
      payload: { messageId: msg.id, plan: fallbackPlan },
    })
  }
})()

return c.json(msg)
```

#### Step 2: 后端 — 新增 `plan:completed` 事件类型

**修改文件**：`packages/shared/src/constants.ts`

在 `WsEvent` 或相关常量定义中增加 `plan:completed`。

#### Step 3: 前端 — 处理 `plan:completed` WebSocket 事件

**修改文件**：`apps/web/src/stores/chatStore.ts`

在 `handleWSEvent` 中增加：
```typescript
case 'plan:completed': {
  const { messageId, plan } = event.payload as { messageId: string; plan: OrchestratorPlan }
  set((state) => {
    const idx = state.messages.findIndex((m) => m.id === messageId)
    if (idx === -1) return state
    const next = [...state.messages]
    next[idx] = {
      ...next[idx],
      metadata: {
        ...(next[idx].metadata ?? {}),
        plan,
        planStatus: 'generated',
      },
    }
    return { messages: next }
  })
  break
}
```

#### Step 4: 前端 — Plan 卡片骨架屏

**修改文件**：`apps/web/src/components/assistant-ui/Thread.tsx`

在 `OrchestratorPlanCard` 中：
```typescript
const planStatus = liveMessage?.metadata?.planStatus ?? 'generated'

if (planStatus === 'generating') {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-neutral-700">
        <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
        Orchestrator 正在规划任务...
      </div>
      <div className="mt-3 space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  )
}
```

#### Step 5: 前端 — 移除 Plan API 的超时焦虑

`api.createOrchestratorPlan` 现在立即返回，无需特殊超时。但如果想保险，可以保留现有逻辑。

---

## 四、风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| 后台任务执行时后端重启（开发环境） | 高 | Plan 永远停留在 generating | 开发时避免保存代码；生产环境无 `--watch` |
| Plan 生成失败，fallback 静态模板质量低 | 低 | 用户体验下降 | 已有 fallback 机制 |
| 前端收到 `plan:completed` 但 message 还没渲染 | 低 | 事件被忽略 | chatStore 的 message 列表在 API 返回时已插入 |
| 并发请求导致多个 Plan 同时生成 | 低 | 数据混乱 | 前端按钮 loading 状态已防止重复点击 |

---

## 五、工作量估算

| 任务 | 文件 | 预估行数 | 难度 |
|------|------|---------|------|
| 后端 handler 改造 | `messages.ts` | ~40 行 | 低 |
| 新增 WS 事件常量 | `constants.ts` | ~2 行 | 低 |
| 前端 WS 事件处理 | `chatStore.ts` | ~20 行 | 低 |
| 前端骨架屏 UI | `Thread.tsx` | ~30 行 | 低 |
| 测试验证 | - | - | 中 |
| **总计** | | **~100 行** | **低** |

---

## 六、备选：如果要更好的体验（方案 A+）

可以在方案 A 的基础上，给骨架屏增加**动态步骤提示**：

```
Orchestrator 正在规划任务...
  [✓] 分析需求...
  [⟳] 选择 Agent...        ← 动态变化
  [ ] 构建任务 DAG...
  [ ] 生成输出契约...
```

实现方式：后台 LLM 生成过程中，在关键节点发送 `plan:progress` WS 事件。

但这对比赛不是必须的，方案 A 已经足够解决问题。
