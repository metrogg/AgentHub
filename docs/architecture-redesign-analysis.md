# AgentHub 架构重新设计分析

> 基于对 AstronClaw、Kimi Claw 群聊、Kimi K2.6 Agent 集群、以及 LangGraph/CrewAI/AutoGen/MetaGPT 等开源框架的研究

---

## 一、当前架构问题诊断

### 1.1 核心问题（来自 multi-agent-redesign.md）

```
旧架构：用户 → Orchestrator → Planner(LLM×2) → Task DAG → Agent执行 → Synthesizer(LLM) → 结果
     ↑                                                                            ↑
     |                                                                            |
  Agent 没有自主性                                                          用户只能等最终结果
  不能提问、不能拒绝、不能 @别人                                             不能中途介入
```

**具体问题**：
1. **Agent 自主性缺失**：Agent 只是被 Orchestrator 调用的 LLM 端点，没有决策权
2. **任务分配单一**：只有 Orchestrator 预定义 DAG，缺乏灵活性
3. **通信效率低下**：Agent 间通信通过 Orchestrator 中转，延迟高
4. **用户参与受限**：只能在开始和结束时参与，不能中途介入
5. **上下文截断**：截断到 3 条消息，信息不完整

### 1.2 工程实现问题

| 问题类型 | 具体问题 | 影响 |
|---------|---------|------|
| **竞态条件** | `runAgentReply`/`cancelAgentReply` 非原子操作 | 数据丢失、状态不一致 |
| **资源泄漏** | WebSocket 错误静默吞掉、超时定时器未清理 | 内存泄漏、连接泄漏 |
| **模块臃肿** | `orchestrator-engine.ts`(1579行)、`messages.ts`(1421行) | 难以维护、测试困难 |
| **测试不足** | 只有集成测试，缺少单元测试，前端无测试 | 回归风险高 |

---

## 二、参考项目架构分析

### 2.1 AstronClaw / OpenClaw 多Agent协作系统

**核心架构**：
```
用户需求
    ↓
Director（主Agent）接收
    ↓
任务分解为子任务
    ↓
通过 sessions_spawn 创建子Agent
    ↓
子Agent在独立会话中执行
    ↓
结果通过 Announce 机制返回
    ↓
Director 汇总并交付用户
```

**关键设计**：

1. **两种核心通信模式**：
   - `sessions_spawn`：创建新Agent实例（Fork进程）
     - 支持两种模式：`run`（一次性，用户不可见）和 `session`（持久化，用户可见）
     - 独立会话、工作目录、附件副本
   - `sessions_send`：向已存在会话发送消息（IPC）
     - 支持同步（阻塞等待）和异步（立即返回）模式
     - 支持A2A多轮协商（最多5轮）

2. **三种协作模式**：
   - **Fork-Join（并行处理）**：同时spawn多个子Agent处理不同子任务，最后汇聚结果
   - **Master-Worker（主从协作）**：先spawn持久化专家Agent，然后通过send消息咨询
   - **Pipeline（流水线）**：任务分解为多个阶段，每个阶段由专门Agent处理

3. **关键设计原则**：
   - **推送优于轮询**：结果自动推送（announcement），零轮询成本
   - **隔离优于共享**：子Agent拥有独立的会话、工作目录和附件副本
   - **异步优于同步**：支持后台执行，利于高并发
   - **层次化权限控制**：深度限制、白名单、沙箱机制

4. **安全与约束**：
   - 最大递归深度（默认1层）
   - 最大子进程数（默认5个/会话）
   - 白名单机制（需配置允许启动哪些Agent）
   - 会话键层次化结构：`agent:<父ID>:subagent:<UUID>`

**与AgentHub的对比**：
| 维度 | AstronClaw/OpenClaw | AgentHub |
|------|---------------------|----------|
| **Agent创建** | sessions_spawn（独立会话） | Orchestrator调用（共享上下文） |
| **通信机制** | sessions_send（IPC） | Orchestrator中转 |
| **隔离性** | 独立会话、工作目录 | 共享上下文 |
| **协商机制** | A2A多轮协商（5轮） | 无 |
| **用户可见性** | 可配置（run/session模式） | 全部可见 |
| **权限控制** | 深度限制、白名单、沙箱 | 基础权限 |

### 2.2 Kimi Claw 群聊（最接近的参考）

**核心架构**：
```
用户创建群聊
    ↓
设置群名称 + 群目标（Group Goal）
    ↓
选择成员（多个 Claw）
    ↓
系统自动分配"指挥"（Conductor）
    ↓
指挥拆解任务为 Thread（子任务）
    ↓
每个 Thread 分配给特定 Claw
    ↓
Claw 在独立上下文中执行
    ↓
产出物汇总到工作空间
    ↓
指挥聚合汇报
```

**关键设计**：
1. **双模协作**：指挥（Conductor）+ 用户@mention
2. **Thread 机制**：独立子任务上下文，避免干扰
3. **工作空间**：共享产出物，结果层面共享
4. **群规约束**：统一行为准则，指挥和所有 Claw 都遵守
5. **用户随时介入**：可以 @Agent、修改需求、暂停执行

### 2.2 Kimi K2.6 Agent 集群

**核心能力**：
- **大规模并行**：支持 300 个子 Agent 并行工作
- **动态任务匹配**：根据 Agent 技能画像和可用工具分配任务
- **自动故障恢复**：任务失败时自动重新分配或生成子任务
- **跨框架协作**：支持 OpenClaw、Hermes Agent 等不同框架
- **7x24 运行**：支持长期自主化运行

### 2.3 MetaGPT（软件开发场景）

**核心架构**：
```
用户需求
    ↓
产品经理 Agent → PRD 文档
    ↓
架构师 Agent → 设计文档
    ↓
工程师 Agent → 代码实现
    ↓
测试 Agent → 测试报告
    ↓
标准化文档流贯穿整个流程
```

**关键设计**：
1. **标准化文档流**：PRD → 设计文档 → 代码 → 测试报告
2. **角色分工明确**：产品经理、架构师、工程师等
3. **SOP 驱动**：流程严谨，稳定性高

### 2.4 CrewAI（通用协作框架）

**核心架构**：
```
定义 Crew（团队）
    ↓
定义 Agent（角色 + 目标 + 工具）
    ↓
定义 Task（任务描述 + 依赖）
    ↓
框架编排执行
```

**关键设计**：
1. **灵活抽象**：Crew 和 Task 概念通用
2. **角色驱动**：根据角色自动协作
3. **API 直观**：上手快，易于使用

### 2.5 LangGraph（状态机架构）

**核心架构**：
```
定义状态图（Graph）
    ↓
节点 = Agent 或工具
    ↓
边 = 状态流转规则
    ↓
状态驱动执行
    ↓
支持检查点和人工介入
```

**关键设计**：
1. **状态图架构**：极致可控，流程稳定
2. **原生状态管理**：支持检查点、中断、恢复
3. **人工介入**：Human-in-the-loop 原生支持

---

## 三、架构对比分析

### 3.1 核心设计维度对比

| 维度 | 当前 AgentHub | Kimi Claw | MetaGPT | CrewAI | LangGraph |
|------|--------------|-----------|---------|--------|-----------|
| **协作模式** | Orchestrator 中心化 | 指挥 + @mention 双模 | SOP 流程驱动 | 角色链驱动 | 状态图驱动 |
| **任务分解** | Orchestrator LLM 拆解 | 指挥拆解为 Thread | 文档流驱动 | 角色配置 | 开发者显式设计 |
| **通信机制** | Orchestrator 中转 | 主群聊 + Thread + 工作空间 | 标准化文档传递 | 任务链传递 | 共享状态对象 |
| **Agent 自主性** | 低（被动执行） | 中（可提问、@别人） | 低（按 SOP 执行） | 中（角色驱动） | 高（状态驱动） |
| **用户参与** | 开始和结束 | 随时介入 | 开始和结束 | 随时介入 | 随时介入 |
| **状态管理** | 基础 | 工作空间共享 | 文档流贯穿 | 基础 | **原生强大** |
| **并行能力** | DAG 调度 | Thread 并行 | 流程串行 | 任务并行 | 图节点并行 |
| **故障恢复** | 5 种策略 | 指挥重新分配 | 流程重跑 | 超时重试 | 检查点恢复 |

### 3.2 优势与劣势分析

**当前 AgentHub 的优势**：
1. 已实现 Orchestrator 引擎（4,500 行）
2. 支持 DAG 调度和并行执行
3. 有失败降级机制
4. 技术栈现代（Bun + Hono + React）

**当前 AgentHub 的劣势**：
1. Agent 自主性不足
2. 通信效率低
3. 用户参与受限
4. 模块臃肿，难以维护

---

## 四、重新设计建议

### 4.1 核心设计理念

**借鉴 Kimi Claw 的双模协作 + LangGraph 的状态管理 + MetaGPT 的标准化流程**

```
新架构：用户 ←→ GroupChatManager ←→ Agent 群组
              ↑                    ↑
              |                    |
         随时介入              Agent 自主协作
         @mention              Thread 隔离
         修改需求              工作空间共享
```

### 4.2 关键设计改进

#### 改进 1：引入 Thread 机制（借鉴 Kimi Claw）

**当前问题**：所有消息在同一个上下文，容易干扰

**新设计**：
```typescript
interface Thread {
  id: string
  title: string
  goal: string                    // 子任务目标
  assignedAgentId: string         // 分配给谁
  context: Message[]              // 独立上下文
  artifacts: Artifact[]           // 产出物
  status: 'pending' | 'active' | 'completed' | 'failed'
  dependencies: string[]          // 依赖的其他 Thread
}
```

**优势**：
- 子任务上下文隔离，避免干扰
- 可并行执行多个 Thread
- 产出物独立管理

#### 改进 2：增强 Agent 自主性（借鉴 Kimi Claw）

**当前问题**：Agent 只是被动执行，没有决策权

**新设计**：
```typescript
interface AgentCapabilities {
  canAskQuestion: boolean         // 可以提问
  canMentionOther: boolean        // 可以 @其他 Agent
  canRejectTask: boolean          // 可以拒绝任务
  canReportProgress: boolean      // 可以报告进度
  canRequestHelp: boolean         // 可以请求帮助
}
```

**示例场景**：
```
Coder: "我需要确认：1. 用 Canvas 还是 DOM？ 2. 要支持移动端吗？@User"
Coder: "碰撞检测算法不太对，@Architect 能帮我看看吗？"
Reviewer: "这个任务需要从零写代码，更适合 @Coder。我的专长是审查已有代码。"
Coder: "进度：✅首页 ✅概况页 🔄院系页 ⏳招生页"
```

#### 改进 3：引入群规机制（借鉴 Kimi Claw）

**当前问题**：Agent 行为不一致，缺乏约束

**新设计**：
```typescript
interface GroupRules {
  outputFormat: string            // 输出格式要求
  languageStyle: string           // 语言风格
  workConstraints: string[]       // 工作约束
  qualityStandards: string[]      // 质量标准
  collaborationProtocol: string   // 协作协议
}
```

**示例**：
```
群规：
1. 所有代码必须包含注释
2. 优先使用 TypeScript
3. 每个函数不超过 50 行
4. 提交前必须运行测试
```

#### 改进 4：引入工作空间（借鉴 Kimi Claw）

**当前问题**：产出物分散，难以管理

**新设计**：
```typescript
interface Workspace {
  id: string
  name: string
  goal: string                    // 群目标
  rules: GroupRules               // 群规
  threads: Thread[]               // 所有 Thread
  artifacts: Artifact[]           // 所有产出物
  members: Agent[]                // 所有成员
  timeline: Event[]               // 时间线
}
```

#### 改进 5：标准化文档流（借鉴 MetaGPT）

**当前问题**：任务执行缺乏标准化流程

**新设计**：
```typescript
// 针对软件开发场景
const SoftwareDevSOP = {
  phases: [
    { name: 'requirements', agent: 'ProductManager', output: 'PRD' },
    { name: 'design', agent: 'Architect', output: 'DesignDoc' },
    { name: 'implementation', agent: 'Coder', output: 'Code' },
    { name: 'testing', agent: 'Tester', output: 'TestReport' },
    { name: 'review', agent: 'Reviewer', output: 'ReviewReport' }
  ]
}
```

#### 改进 6：状态图调度（借鉴 LangGraph）

**当前问题**：DAG 调度不够灵活

**新设计**：
```typescript
interface TaskGraph {
  nodes: TaskNode[]               // 任务节点
  edges: TaskEdge[]               // 依赖边
  checkpoints: Checkpoint[]       // 检查点
  humanGates: HumanGate[]         // 人工介入点
}

interface TaskNode {
  id: string
  agentId: string
  capabilities: AgentCapabilities
  timeout: number
  retryPolicy: RetryPolicy
}
```

### 4.3 架构重构方案

#### 方案 A：渐进式重构（推荐）

**Phase 1：引入 Thread 机制（1 周）**
- 修改 GroupChatManager，支持 Thread 创建和管理
- 实现 Thread 上下文隔离
- 实现工作空间共享产出物

**Phase 2：增强 Agent 自主性（1 周）**
- 扩展 Agent 接口，支持提问、@别人、拒绝、报告进度
- 修改 SpeakerSelector，支持 Agent 主动发言
- 实现群规机制

**Phase 3：优化 Orchestrator（1 周）**
- 重构 orchestrator-engine.ts，拆分为更小模块
- 引入状态图调度，支持检查点和人工介入
- 优化故障恢复机制

**Phase 4：标准化流程（1 周）**
- 实现 SOP 引擎，支持自定义流程
- 针对软件开发场景预置 SOP
- 实现标准化文档流

#### 方案 B：彻底重写（风险较高）

**完全重新设计架构，参考 Kimi Claw + LangGraph + MetaGPT**

**优势**：
- 架构更清晰
- 代码质量更高
- 更容易维护和扩展

**劣势**：
- 时间成本高（可能需要 4-6 周）
- 风险高，可能无法按时完成
- 需要重新测试

**建议**：采用方案 A，渐进式重构

---

## 五、具体实现建议

### 5.1 数据库 Schema 扩展

```sql
-- 新增 Thread 表
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  goal TEXT,
  assigned_agent_id TEXT,
  status TEXT DEFAULT 'pending',
  dependencies TEXT, -- JSON array
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (assigned_agent_id) REFERENCES workspace_agents(id)
);

-- 新增群规表
CREATE TABLE group_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  rules TEXT NOT NULL, -- JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

-- 新增检查点表
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  thread_id TEXT,
  state TEXT NOT NULL, -- JSON snapshot
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES orchestrator_runs(id)
);
```

### 5.2 核心服务重构

```typescript
// 新的 GroupChatManager
class GroupChatManager {
  // 处理用户消息
  async handleMessage(message: UserMessage): Promise<void> {
    // 1. 检查是否有 @mention
    if (message.mentions.length > 0) {
      // 模式 A：直接路由
      await this.routeToAgent(message)
    } else {
      // 模式 B：Orchestrator 自动分派
      await this.orchestratorMode(message)
    }
  }

  // Orchestrator 模式
  async orchestratorMode(message: UserMessage): Promise<void> {
    // 1. 指挥分析意图
    const plan = await this.conductor.analyze(message)
    
    // 2. 创建 Thread
    const threads = await this.createThreads(plan)
    
    // 3. 展示计划卡片
    await this.showPlanCard(plan)
    
    // 4. 用户确认后执行
    await this.executeThreads(threads)
    
    // 5. 聚合汇报
    await this.synthesizeResults(threads)
  }

  // 创建 Thread
  async createThreads(plan: ExecutionPlan): Promise<Thread[]> {
    const threads: Thread[] = []
    
    for (const task of plan.tasks) {
      const thread = await this.db.createThread({
        workspaceId: plan.workspaceId,
        title: task.title,
        goal: task.description,
        assignedAgentId: task.agentId,
        dependencies: task.dependencies
      })
      threads.push(thread)
    }
    
    return threads
  }

  // 执行 Thread（支持并行）
  async executeThreads(threads: Thread[]): Promise<void> {
    // 按依赖关系排序
    const sorted = this.topologicalSort(threads)
    
    // 并行执行同层 Thread
    for (const layer of sorted) {
      await Promise.all(layer.map(thread => this.executeThread(thread)))
    }
  }

  // 执行单个 Thread
  async executeThread(thread: Thread): Promise<void> {
    // 1. 创建独立上下文
    const context = await this.createThreadContext(thread)
    
    // 2. 执行 Agent
    const result = await this.runAgent(thread.assignedAgentId, context)
    
    // 3. 保存产出物
    await this.saveArtifacts(thread.id, result.artifacts)
    
    // 4. 更新状态
    await this.updateThreadStatus(thread.id, 'completed')
  }
}
```

### 5.3 Agent 接口增强

```typescript
// 增强的 Agent 接口
interface EnhancedAgent extends Agent {
  // 自主性能力
  capabilities: AgentCapabilities
  
  // 可以提问
  async askQuestion(question: string, target: string): Promise<void>
  
  // 可以 @其他 Agent
  async mentionAgent(agentId: string, message: string): Promise<void>
  
  // 可以拒绝任务
  async rejectTask(reason: string, suggestedAgent?: string): Promise<void>
  
  // 可以报告进度
  async reportProgress(progress: ProgressReport): Promise<void>
  
  // 可以请求帮助
  async requestHelp(helpRequest: HelpRequest): Promise<void>
}
```

---

## 六、时间规划

### 6.1 总体时间线（距离截止日期 12 天）

| 阶段 | 时间 | 目标 | 产出 |
|------|------|------|------|
| **Week 1** | 6月1-7日 | 核心架构重构 | Thread 机制 + Agent 自主性 + 群规 |
| **Week 2** | 6月8-10日 | 优化和测试 | 性能优化 + Bug 修复 + 测试覆盖 |

### 6.2 详细任务分解

**Week 1（6月1-7日）**：
- Day 1-2：数据库 Schema 扩展 + Thread 机制实现
- Day 3-4：Agent 自主性增强 + 群规机制
- Day 5-6：Orchestrator 重构 + 状态图调度
- Day 7：集成测试 + Bug 修复

**Week 2（6月8-10日）**：
- Day 8-9：性能优化 + 代码质量提升
- Day 10：最终测试 + 文档完善

---

## 七、风险与应对

### 7.1 主要风险

1. **时间风险**：12 天内完成重构可能紧张
   - **应对**：采用渐进式重构，优先实现核心功能

2. **技术风险**：新架构可能引入新问题
   - **应对**：充分测试，保留回滚方案

3. **团队风险**：团队成员可能不熟悉新架构
   - **应对**：提供详细文档和培训

### 7.2 成功关键

1. **明确优先级**：先实现 Thread 机制和 Agent 自主性
2. **充分测试**：每个阶段都要测试验证
3. **及时沟通**：团队成员保持密切沟通
4. **灵活调整**：根据实际情况调整计划

---

## 八、总结

### 8.1 核心建议

1. **借鉴 Kimi Claw 的 Thread 机制**：实现子任务上下文隔离
2. **增强 Agent 自主性**：支持提问、@别人、拒绝、报告进度
3. **引入群规机制**：统一 Agent 行为准则
4. **优化 Orchestrator**：引入状态图调度，支持检查点和人工介入
5. **标准化流程**：针对软件开发场景预置 SOP

### 8.2 预期效果

- **用户体验**：随时介入，实时反馈
- **协作效率**：Thread 并行，减少等待
- **代码质量**：群规约束，标准化流程
- **系统稳定性**：状态管理，故障恢复

### 8.3 下一步行动

1. **立即**：团队讨论，确定最终方案
2. **本周**：开始数据库 Schema 扩展
3. **下周**：实现核心功能
4. **赛前**：充分测试，完善文档

---

*本分析基于对 AstronClaw、Kimi Claw、Kimi K2.6、LangGraph、CrewAI、AutoGen、MetaGPT 等项目的研究，结合当前 AgentHub 架构问题，提出重新设计建议。*