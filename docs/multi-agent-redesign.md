# 多 Agent 协作架构重设计

> 核心理念：双模协作 —— @mention 直接对话 + Orchestrator 自动分派

---

## 一、问题诊断

### 旧架构的问题

```
旧：用户 → Orchestrator → Planner(LLM×2) → Task DAG → Agent执行 → Synthesizer(LLM) → 结果
     ↑                                                                            ↑
     |                                                                            |
  Agent 没有自主性                                                          用户只能等最终结果
  不能提问、不能拒绝、不能 @别人                                             不能中途介入
```

**核心问题**：Agent 只是被 Orchestrator 调用的 LLM 端点，没有自主性。Orchestrator 和 Agent 之间是"调用"关系，不是"协作"关系。

### 赛题要求

> 群聊模式：通过 @ 指定**或由 Orchestrator 自动分派**，Agent 依次回复
> 主 Agent 协调器：自动理解用户意图，将复杂任务**拆解并分派**给子 Agent，**聚合产出**汇报结果
> 支持**并行调度、失败降级、代码冲突处理**

**结论**：赛题要求 Orchestrator + 对话式两种模式并存，不能只有其中一种。

---

## 二、新架构总览

### 双模协作

```
用户在群聊发消息
      ↓
┌──────────────────────────────────────────────────────┐
│                 GroupChatManager                      │
│                                                      │
│  ┌─────────────────────────────────────────────────┐ │
│  │ 路由判断：用户 @了 Agent 吗？                   │ │
│  │                                                 │ │
│  │  是 → 模式 A：@mention 直接路由                 │ │
│  │  否 → 模式 B：Orchestrator 自动分派             │ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  ┌──────────────────────┐  ┌──────────────────────┐ │
│  │ 模式 A：@mention     │  │ 模式 B：Orchestrator │ │
│  │                      │  │                      │ │
│  │ 用户 @Coder          │  │ Orchestrator 接管：  │ │
│  │ → 直接路由到 Coder   │  │ → 理解用户意图      │ │
│  │                      │  │ → 拆解为子任务      │ │
│  │ Agent 回复中 @别人？ │  │ → 分派给 Agent      │ │
│  │ → 自动路由到被@的    │  │ → 支持并行执行      │ │
│  │                      │  │ → 聚合产出汇报      │ │
│  │ 用户可以随时介入     │  │ → 失败降级重试      │ │
│  └──────────────────────┘  └──────────────────────┘ │
│                                                      │
│  两种模式可以随时切换：                              │
│  用户中途 @Agent → 从 Orchestrator 模式切到直接对话  │
│  Orchestrator 执行中用户插话 → 暂停并响应用户        │
└──────────────────────────────────────────────────────┘
```

### 与旧架构的对比

| 维度 | 旧架构 | 新架构 |
|------|--------|--------|
| Agent 角色 | 被调用的 LLM 端点 | 有自主性的参与者 |
| 任务分配 | 只有 Orchestrator 预定义 DAG | @mention 直接路由 + Orchestrator 自动分派 |
| Agent 间通信 | 无，通过 Orchestrator 中转 | 群聊中直接 @对方 + Orchestrator 协调 |
| 用户参与 | 只在开始和结束 | 任何时候可以介入 |
| 上下文 | 截断到 3 条消息 | 完整对话历史 + 工具输出 |
| 终止 | 全部任务跑完 | 随时可以停止 |
| Orchestrator | 唯一模式，Agent 无自主性 | 两种模式之一，Agent 有自主性 |

---

## 三、核心流程

### 模式 A：@mention 直接路由

用户明确指定谁来回，最简单直接。

```
用户: "@Coder 帮我做一个贪吃蛇游戏"
      ↓
GroupChatManager → 解析 @Coder → 路由到 Coder
      ↓
Coder（Claude Code / OpenCode）直接执行任务
      ↓
Coder 回复: "已创建 index.html。@Reviewer 帮忙审查一下"
      ↓
GroupChatManager → 解析 @Reviewer → 路由到 Reviewer
      ↓
Reviewer 审查代码，回复建议
      ↓
用户: "@Coder 按建议修改"
      ↓
...用户驱动的协作循环...
```

**适用场景**：用户清楚谁该干什么，想直接控制节奏。

### 模式 B：Orchestrator 自动分派

用户不指定 Agent，Orchestrator 自动理解意图、拆解任务、分派执行。

```
用户: "帮我做一个介绍深圳技术大学的网站"
      ↓
GroupChatManager → 没有 @mention → 进入 Orchestrator 模式
      ↓
Orchestrator（LLM）分析意图：
  → 任务类型：Web 开发
  → 需要：前端实现 + 内容设计
  → 拆解为子任务：
    1. Architect：规划网站结构和页面
    2. Coder：实现网页代码
    3. Reviewer：审查代码质量
  → 依赖关系：1 → 2 → 3（串行）
      ↓
用户看到任务计划卡片，点击"执行"
      ↓
Orchestrator 按 DAG 调度：
  → Architect 执行 → 产出架构方案
  → Coder 执行 → 产出网页代码（可并行的子任务同时执行）
  → Reviewer 执行 → 产出审查意见
      ↓
Orchestrator 聚合产出，在群聊中汇报汇总结果
```

**适用场景**：复杂任务，用户不想手动协调，让 Orchestrator 自动拆解和调度。

### 两种模式的切换

```
场景 1：Orchestrator 执行中用户想介入
  用户: "@Coder 等一下，先改一下首页布局"
  → Orchestrator 暂停 → Coder 响应用户 → 用户确认后 Orchestrator 恢复

场景 2：@mention 对话中任务变复杂
  用户: "这个需求变复杂了，让 Orchestrator 来协调吧"
  → 进入 Orchestrator 模式 → 自动生成计划 → 分派执行
```

---

## 四、Orchestrator 设计（核心能力）

### 4.1 任务拆解

Orchestrator 接收用户意图，调用 LLM 生成 Task DAG：

```typescript
interface ExecutionPlan {
  title: string
  goal: string
  agents: ExecutionAgent[]     // 参与的 Agent
  tasks: ExecutionTask[]       // 子任务列表
  phases?: OrchestratorPhase[] // 阶段划分
}

interface ExecutionTask {
  id: string
  title: string
  description: string
  agentId: string              // 分配给谁
  taskType: 'code' | 'review' | 'research' | 'design' | 'test'
  dependencies: string[]       // 依赖哪些任务先完成
  parallelGroup?: string       // 同组可并行
  maxRetries: number
}
```

### 4.2 并行调度

```
Task DAG:
  Task1 (Architect) ──→ Task2 (Coder-A) ──→ Task4 (Reviewer)
                    └──→ Task3 (Coder-B) ──┘

执行顺序：
  第 1 层：Task1（串行）
  第 2 层：Task2 + Task3（并行，Semaphore 控制并发）
  第 3 层：Task4（等 Task2、Task3 都完成）
```

### 4.3 失败降级

```typescript
// 任务失败时的策略
type ReplanStrategy =
  | 'retry_with_backoff'      // 重试（指数退避）
  | 'agent_substitution'      // 换一个 Agent
  | 'local_replan'            // 重新规划当前任务
  | 'task_split'              // 拆分为更小的子任务
  | 'global_replan'           // 重新生成整个计划
  | 'escalate_to_user'        // 上报用户决策
```

### 4.4 聚合汇报

所有子任务完成后，Synthesizer 生成汇总报告：

```
## 执行摘要
本次共 3 个子任务，全部成功完成。

## 各 Agent 产出
### Architect — 网站结构规划
- 确定 5 个页面：首页、学校概况、院系设置、招生信息、校园生活
- 技术方案：React + Tailwind CSS

### Coder — 网页实现
- 创建 8 个组件文件
- 响应式布局适配移动端

### Reviewer — 代码审查
- 代码质量良好
- 建议：添加 SEO meta 标签

## 下一步行动
1. 根据 Reviewer 建议优化
2. 添加真实内容数据
3. 部署预览
```

---

## 五、SpeakerSelector 设计（对话模式辅助）

当用户没有 @任何人，且不需要 Orchestrator 全流程接管时，SpeakerSelector 决定谁来回。

### 选择优先级

1. **用户 @mention** → 直接路由，100% 确定
2. **Agent @mention** → Agent 请求了某个 Agent，高优先级
3. **LLM 选择** → 根据上下文选择，中等优先级
4. **轮询兜底** → 如果 LLM 选择失败，按顺序轮流

### 适用场景

- 用户 @了 Agent 但 Agent 回复中 @了别人 → SpeakerSelector 路由
- Orchestrator 模式结束后的后续对话 → SpeakerSelector 选择
- 简单任务不需要 Orchestrator → SpeakerSelector 选择

---

## 六、Agent 自主性增强

在 Orchestrator 基础上，增加 Agent 的自主性：

### 6.1 Agent 可以提问

```
Coder: "我需要确认：1. 用 Canvas 还是 DOM？ 2. 要支持移动端吗？@User"
```

### 6.2 Agent 可以 @其他 Agent 请求帮助

```
Coder: "碰撞检测算法不太对，@Architect 能帮我看看吗？"
```

### 6.3 Agent 可以拒绝并建议转派

```
Reviewer: "这个任务需要从零写代码，更适合 @Coder。我的专长是审查已有代码。"
```

### 6.4 Agent 可以报告进度

```
Coder: "进度：✅首页 ✅概况页 🔄院系页 ⏳招生页"
```

**这些能力让 Orchestrator 的执行更灵活**——Agent 不是被动执行，而是可以主动协调。

---

## 七、Human-in-the-Loop

### Orchestrator 模式下的检查点

```
Orchestrator 生成计划 → 用户看到计划卡片
  ✅ 确认 → 开始执行
  ✏️ 修改 → 用户调整任务分配
  ❌ 拒绝 → 重新规划

子任务完成 → 用户看到中间结果
  → 可以暂停、调整后续任务

全部完成 → 用户看到汇总报告
  → 可以要求修改、追加任务
```

### @mention 模式下的介入

```
用户随时可以在群聊中发消息
  → @Agent 直接指定
  → 修改需求
  → 要求 Orchestrator 接管
```

---

## 八、实现路径

### Phase 1：双模群聊基础（已完成）

**目标**：群聊支持 @mention 直接路由 + SpeakerSelector 动态选择

- ✅ GroupChatManager 替代旧的 runGroupReplies
- ✅ SpeakerSelector（@mention → LLM → 轮询）
- ✅ Agent @Agent 自动路由
- ✅ Code Agent / LLM Agent 分别处理 prompt
- ✅ 失败重试 + 强制切换
- ✅ 轮次控制

### Phase 2：Orchestrator 集成到群聊（当前）

**目标**：Orchestrator 作为"没 @人时的默认行为"集成到群聊

- [ ] GroupChatManager 中集成 Orchestrator 触发逻辑
- [ ] 用户没 @任何人 → Orchestrator 自动生成计划
- [ ] 计划卡片展示在群聊中，用户可确认/修改
- [ ] 执行过程中 Agent 可以 @其他人补充协作
- [ ] Orchestrator 完成后聚合汇报

### Phase 3：Agent 工具能力（1-2 周）

**目标**：Agent 能"做事"而不只是"说话"

- [ ] Code Agent 实际读写文件、运行命令
- [ ] 工具调用结果在群聊中可见
- [ ] Agent 能力声明，SpeakerSelector 根据能力选择

### Phase 4：高级协作（2-3 周）

**目标**：更完善的 Orchestrator + Agent 自主性

- [ ] Orchestrator 支持并行调度（DAG 分层执行）
- [ ] 失败降级（重试、换 Agent、重新规划）
- [ ] 代码冲突检测与解决
- [ ] Human-in-the-Loop 检查点

---

## 九、技术架构

### 核心文件

```
apps/server/src/services/group-chat/
├── group-chat-manager.ts      # 群聊总控（双模路由）
├── speaker-selector.ts        # 发言者选择（对话模式辅助）
└── types.ts                   # 类型定义

apps/server/src/services/orchestrator/    # Orchestrator（保留）
├── orchestrator-engine.ts     # 编排引擎
├── planner.ts                 # 任务拆解
├── task-scheduler.ts          # 并发调度
├── synthesizer.ts             # 聚合汇报
├── conflict-resolver.ts       # 冲突解决
└── fallback-engine.ts         # 失败降级
```

### 数据流

```
用户消息
  ↓
GroupChatManager.handleMessage()
  ↓
┌─ @mention? → 直接路由到 Agent → runAgentReply()
│
└─ 无 @mention → Orchestrator 模式
     ↓
   buildDynamicOrchestratorPlan()  ← LLM 拆解任务
     ↓
   插入计划卡片到群聊
     ↓
   用户确认 → OrchestratorEngine.startRun()
     ↓
   TaskScheduler.executePlan()  ← DAG 调度，并行/串行
     ↓
   每个子任务 → runAgentReply()
     ↓
   Synthesizer.synthesize()  ← LLM 聚合汇报
     ↓
   汇总消息插入群聊
```

---

## 十、设计原则

1. **双模共存**：@mention 直接对话 + Orchestrator 自动分派，用户自由选择
2. **Orchestrator 是核心**：复杂任务必须有 Orchestrator 拆解、调度、聚合
3. **Agent 有自主性**：可以提问、拒绝、@别人、报告进度，不是被动执行
4. **用户永远可以介入**：任何时候可以 @Agent、修改需求、暂停执行
5. **渐进增强**：先跑通 Orchestrator 流程，再加并行、降级、冲突处理
