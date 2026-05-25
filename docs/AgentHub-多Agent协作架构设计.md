# AgentHub 多 Agent 协作平台 — 架构设计文档

> 版本：v2.0（重新设计版）  
> 日期：2026-05-25  
> 赛事：字节跳动 AI 全栈挑战赛  

---

## TL;DR

AgentHub 的核心设计采用 **"分层 Orchestrator + 统一 Agent Runtime + 黑板共享状态"** 的三层协作架构。Orchestrator 不是简单的任务分发器，而是一个具备 **动态规划、自适应重调度、LLM 智能聚合** 能力的协作引擎。Agent Runtime 通过统一接口屏蔽底层差异（LLM 对话 / Code Agent CLI / 原生工具），使所有 Agent 以一致的语义参与协作。共享黑板（Blackboard）作为 Agent 间的唯一状态交换媒介，替代了脆弱的字符串拼接式通信。整个系统围绕 **IM 聊天范式** 构建，每个 Agent 都是聊天列表中的一个"联系人"，用户通过 `@` 提及或 Orchestrator 自动调度来驱动多 Agent 协作。相比现有方案，新架构在 **可扩展性、容错性、产物一致性** 三个维度做了根本性改进。

---

## 1. 整体设计哲学

### 1.1 从 "串联调用" 到 "协作生态"

现有的大多数多 Agent 系统本质上是 **LLM 的串联调用** —— 一个 Agent 的输出字符串被拼接到下一个 Agent 的输入提示中。这种模式在简单任务上有效，但在复杂协作场景下面临三个根本问题：**错误级联**（一个 Agent 的幻觉会传播到整个链条）、**语义漂移**（字符串拼接无法保证跨 Agent 的语义一致性）、**不可观测性**（Agent 之间的内部状态对外部完全黑盒）[^5^]。

AgentHub 的设计哲学是 **"将 Agent 视为独立的协作者，而非函数的调用链"**。每个 Agent 有自己的角色定义、能力边界、执行上下文和产物规范。它们通过一个共享的 **黑板（Blackboard）** 交换结构化信息，而非直接传递字符串。Orchestrator 的角色类似于人类团队中的项目经理（PM），负责任务拆解、进度跟踪、冲突协调和最终汇总，但不替代 Agent 的专业判断。这种设计借鉴了 MetaGPT 的 SOP 驱动协作模式 [^16^] 和 Magentic-One 的 Orchestrator + Specialist 架构 [^19^]，但针对 **IM 聊天式交互** 和 **代码产物管理** 做了专门优化。

### 1.2 设计原则

| 原则 | 说明 | 设计体现 |
|------|------|----------|
| **Agent 即联系人** | 每个 Agent 在 IM 聊天列表中是一个独立的联系人，有头像、名称、能力标签 | 前端 UI 与后端 Agent 注册表一一对应 |
| **产物即消息** | Agent 的所有产出（代码、文档、Diff、预览）都以内联消息卡片的形式出现在聊天流中 | 统一消息格式 `AgentMessage<T>`，支持多种产物类型 |
| **结构化优于文本** | Agent 间通信使用结构化数据（JSON/Zod Schema），而非自由文本 | 黑板系统 + 严格的 Schema 校验 |
| **失败是常态** | Agent 可能失败、超时、产生冲突，系统必须优雅处理 | 重试、降级、熔断、LLM 3-way merge |
| **可观测性内建** | 每个 Agent 的执行过程、中间状态、决策理由都是可追踪的 | 执行日志 + 黑板历史 + 流式状态更新 |
| **协作规范即代码** | Spec、Skill、Rules 不是文档，而是可被系统加载执行的配置 | Harness 配置系统 + 版本化规范 |

### 1.3 与现有方案的对比

| 维度 | 现有方案（README） | 新架构（本文） | 改进点 |
|------|-------------------|---------------|--------|
| Orchestrator | DAG 静态规划，一次性生成 | **动态任务账本**，支持 mid-execution replanning [^19^] | 任务执行中可重新规划 |
| Agent 通信 | 字符串拼接传递上下文 | **黑板共享状态** + 结构化消息 [^63^] | 消除语义漂移，支持增量更新 |
| 冲突解决 | Git merge + LLM 3-way merge | **分层冲突处理**：文件级→语义级→LLM 仲裁 | 减少不必要的 LLM 调用 |
| 产物聚合 | 简单字符串拼接 | **LLM Synthesizer** 智能聚合，标注贡献者 [^50^] | 产物质量更高，可追溯 |
| 失败降级 | 固定重试次数 | **熔断器 + 指数退避 + Agent 替代** [^84^] | 避免级联失败 |
| 协作规范 | 无 | **Harness 系统**：Spec + Skill + Rules 可加载执行 [^47^] | 规范即代码，可版本化 |
| 并发控制 | 固定3个并行 | **信号量 + Token Bucket** 动态控制 [^46^] | 适应不同 API 限制 |

---

## 2. 系统架构总览

### 2.1 四层架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         第四层：API / 路由层 (Hono)                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ Sessions │ │ Messages │ │Workspaces│ │  Agents  │ │  Coding Tools    │  │
│  │  会话管理  │ │  消息处理  │ │ 工作空间  │ │ Agent管理 │ │ Code Agent 适配  │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
├─────────────────────────────────────────────────────────────────────────────┤
│                         第三层：Orchestrator 引擎层                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ Planner  │ │Scheduler │ │Synthesizer│ │ Fallback │ │ Conflict Resolver│  │
│  │ 任务规划  │ │并发调度   │ │ 产物聚合  │ │ 失败降级  │ │   冲突解决      │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
├─────────────────────────────────────────────────────────────────────────────┤
│                         第二层：Agent Runtime 统一层                         │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐    │
│  │ LLM Runtime  │ │Code-Agent    │ │ Native Tool  │ │ Registry &       │    │
│  │ 对话式 Agent │ │Runtime       │ │ Runtime      │ │ Discovery        │    │
│  │              │ │CLI Agent 适配│ │ 原生工具执行  │ │ 注册与发现       │    │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────────┘    │
├─────────────────────────────────────────────────────────────────────────────┤
│                         第一层：基础设施层                                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ LLM Client│ │ Tool     │ │Blackboard│ │  Git     │ │  Streaming &     │  │
│  │ 流式客户端 │ │ Registry │ │ 共享黑板  │ │Branch Mgr│ │  Event Bus       │  │
│  │           │ │ 工具注册表 │ │          │ │分支管理器 │ │  事件总线        │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 核心数据流

```
用户消息
    │
    ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────────────────────┐
│ 意图识别器   │────▶│ Orchestrator │────▶│ 黑板初始化 / 任务账本创建    │
│ (Router)    │     │ 引擎启动     │     │ (Task Ledger)               │
└─────────────┘     └─────────────┘     └─────────────────────────────┘
                                                │
                    ┌─────────────────────────────┼─────────────────────────────┐
                    │                             │                             │
                    ▼                             ▼                             ▼
            ┌─────────────┐               ┌─────────────┐               ┌─────────────┐
            │   Agent A   │               │   Agent B   │               │   Agent C   │
            │ (并行执行)   │               │ (并行执行)   │               │ (依赖执行)   │
            └─────────────┘               └─────────────┘               └─────────────┘
                    │                             │                             │
                    └─────────────────────────────┼─────────────────────────────┘
                                                  ▼
                                        ┌─────────────────┐
                                        │   Synthesizer   │
                                        │  (LLM 智能聚合)  │
                                        └─────────────────┘
                                                  │
                                                  ▼
                                        ┌─────────────────┐
                                        │  产物 → 消息卡片  │
                                        │  (用户可见结果)   │
                                        └─────────────────┘
```

### 2.3 关键抽象

**Agent**：AgentHub 中的最小协作单元。每个 Agent 包含：
- **Profile**：`{ id, name, avatar, role, capabilities[], systemPrompt, runtimeType }`
- **Runtime**：实际执行逻辑（LLM / Code Agent / Native Tool）
- **Sandbox**：执行隔离策略（read-only / workspace-write / danger-full-access）
- **State**：当前执行状态（idle / running / completed / failed / waiting）

**Orchestrator**：特殊的系统 Agent，具备以下专属能力：
- **任务拆解（Decomposition）**：将用户请求分解为可并行/串行的子任务
- **任务调度（Scheduling）**：基于 DAG 拓扑排序决定执行顺序
- **进度跟踪（Progress Tracking）**：维护任务账本，监控每个子任务状态
- **自适应重规划（Replanning）**：检测到失败或新信息时动态调整计划
- **产物聚合（Synthesis）**：调用 LLM 整合多个 Agent 的产出为最终结果
- **冲突解决（Conflict Resolution）**：协调多 Agent 对同一资源的修改

**黑板（Blackboard）**：所有 Agent 共享的状态空间，是 Agent 间通信的唯一媒介：
- **结构化存储**：键值对，值必须是 JSON 对象（Zod Schema 校验）
- **版本化**：每个写入产生新版本，支持历史回溯
- **命名空间**：按 `workspace/{workspaceId}/run/{runId}/` 隔离
- **访问控制**：基于 Agent 角色和能力标签的读写权限

**任务账本（Task Ledger）**：Orchestrator 维护的动态计划数据结构：
- **任务列表**：每个任务包含 `id, description, assignedAgent, dependencies[], status, artifactRef, retryCount`
- **DAG 图**：任务间的依赖关系，用于拓扑排序和并行性分析
- **执行状态**：记录已完成任务的产出引用，供下游任务读取

---

## 3. Orchestrator 引擎：核心协作大脑

### 3.1 Orchestrator 不是 "DAG 执行器"

现有方案将 Orchestrator 设计为一个 **静态 DAG 执行器** —— 在任务开始前一次性生成完整的 DAG，然后按计划执行。这种设计在面对复杂、开放式任务时存在明显局限：用户请求往往包含模糊需求，Agent 执行过程中可能发现新的依赖关系或产生意外错误，静态 DAG 无法适应这些变化。

AgentHub 的 Orchestrator 采用 **Magentic-One 的动态任务账本模式** [^19^][^23^]，核心特征：

| 特征 | 静态 DAG 模式 | 动态任务账本模式 |
|------|-------------|----------------|
| 计划时机 | 执行前一次性生成 | 执行前生成初始计划，执行中持续更新 |
| 依赖发现 | 全部依赖必须预先声明 | 支持执行中发现新依赖并动态插入 |
| 失败处理 | 重试或终止 | 重试、降级、重规划、替换 Agent 多策略 |
| 产物聚合 | 固定聚合点 | 按需聚合，支持中间产物实时可见 |
| 用户交互 | 执行完成后统一返回 | 执行中可暂停等待用户输入 |

### 3.2 两阶段规划模型

Orchestrator 采用 **"粗粒度规划 → 细粒度调度"** 的两阶段模型：

**阶段一：粗粒度规划（Coarse Planning）**
用户请求到达后，Orchestrator 首先调用 LLM 进行一次高层规划，输出：
- **目标（Goal）**：用户请求的标准化描述
- **阶段（Phases）**：2-4 个粗粒度阶段（如 "分析 → 设计 → 实现 → 审查"）
- **角色分配（Role Assignment）**：每个阶段需要的 Agent 类型
- **产物定义（Artifacts）**：每个阶段期望产出的结构化描述

```typescript
// 粗粒度规划输出 Schema
const CoarsePlanSchema = z.object({
  goal: z.string(),
  phases: z.array(z.object({
    phaseId: z.string(),
    name: z.string(),
    description: z.string(),
    requiredAgents: z.array(z.enum(['analyst', 'architect', 'engineer', 'reviewer', 'qa'])),
    expectedArtifacts: z.array(z.object({
      type: z.enum(['spec', 'design_doc', 'code', 'test', 'review_report']),
      description: z.string(),
    })),
    dependencies: z.array(z.string()), // 依赖的前置 phaseId
  })),
  estimatedComplexity: z.enum(['low', 'medium', 'high']),
});
```

**阶段二：细粒度调度（Fine Scheduling）**
每个阶段开始时，Orchestrator 根据当前黑板状态和阶段目标，生成具体的任务列表（Task Ledger Entry）：
- **任务拆解**：将阶段目标拆分为可独立执行的原子任务
- **依赖分析**：确定任务间的数据依赖和控制依赖
- **并行性分析**：识别无依赖的任务，标记为可并行
- **Agent 绑定**：根据任务类型和 Agent 能力标签匹配最佳 Agent

```typescript
// 细粒度任务 Schema
const TaskSchema = z.object({
  taskId: z.string(),
  phaseId: z.string(),
  description: z.string(),
  assignedAgent: z.string(), // Agent ID
  dependencies: z.array(z.string()), // taskId 列表
  inputRefs: z.array(z.string()), // 黑板键名，表示输入数据位置
  outputKey: z.string(), // 产出写入黑板的键名
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
  retryCount: z.number().default(0),
  maxRetries: z.number().default(3),
  timeout: z.number().default(300000), // 5分钟
  createdAt: z.number(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
});
```

### 3.3 任务账本状态机

每个任务在生命周期中经历以下状态转换：

```
                    ┌─────────────┐
         ┌─────────▶│   pending   │◀────────┐
         │          │  (等待调度)  │         │
         │          └──────┬──────┘         │
         │                 │ 依赖满足         │
         │                 ▼                │
  用户取消 │          ┌─────────────┐       │ 重试次数
  ├────────┤         │   running   │       │ 未达上限
         │          │  (执行中)    │───────┘
         │          └──────┬──────┘
         │                 │
         │     ┌───────────┼───────────┐
         │     │           │           │
         │     ▼           ▼           ▼
         │ ┌────────┐ ┌────────┐ ┌──────────┐
         └─│cancelled│ │completed│ │  failed   │
           │ (取消)  │ │(完成)  │ │ (失败)   │
           └────────┘ └────┬───┘ └────┬─────┘
                           │          │
                           ▼          ▼
                    ┌─────────────────────┐
                    │   产物写入黑板 /      │
                    │   触发 Synthesizer   │
                    └─────────────────────┘
```

### 3.4 自适应重规划（Replanning）

当任务失败或黑板状态出现意外变化时，Orchestrator 触发重规划：

**触发条件**：
- 任务连续失败达到 `maxRetries` 次
- Agent 返回的产出与预期 Schema 不匹配
- 黑板状态中出现新的关键信息（如 "发现现有代码与需求冲突"）
- 用户在中途发送了新的指令或约束

**重规划策略**：
1. **局部重规划**：仅重新规划失败任务及其下游依赖，不影响其他并行分支
2. **Agent 替换**：尝试将失败任务分配给同类型的备选 Agent（如 Codex 失败时换 Claude Code）
3. **任务拆分**：将复杂任务拆分为更小的子任务，降低单任务复杂度
4. **用户介入**：当自动重规划失败时，暂停执行并请求用户指导

```typescript
async function replan(context: ReplanContext): Promise<PlanAdjustment> {
  const { failedTask, blackboard, taskLedger } = context;
  
  // 1. 分析失败原因
  const failureAnalysis = await analyzeFailure(failedTask);
  
  // 2. 选择重规划策略
  switch (failureAnalysis.category) {
    case 'transient_error':
      return { strategy: 'retry_with_backoff', delay: calculateBackoff(failedTask.retryCount) };
    case 'agent_capability_mismatch':
      return { strategy: 'agent_substitution', alternativeAgent: findAlternativeAgent(failedTask) };
    case 'dependency_conflict':
      return { strategy: 'local_replan', adjustDependencies: resolveConflict(failedTask, blackboard) };
    case 'unrecoverable_error':
      return { strategy: 'escalate_to_user', reason: failureAnalysis.reason };
    default:
      return { strategy: 'global_replan' };
  }
}
```

### 3.5 LLM 智能聚合器（Synthesizer）

当多个 Agent 完成并行任务后，Orchestrator 调用 **Synthesizer** 整合它们的产出。Synthesizer 不是简单的字符串拼接，而是一个独立的 LLM 调用，其职责是：

- **消除冗余**：识别并合并多个 Agent 产出的重复内容
- **标注贡献**：明确最终产物中每个部分的贡献者来源
- **指出冲突**：当 Agent 产出之间存在矛盾时，明确标注并给出建议
- **统一格式**：将不同 Agent 的产出格式统一为最终交付格式

```typescript
// Synthesizer 输入 Schema
const SynthesizerInputSchema = z.object({
  goal: z.string(), // 原始用户请求
  artifacts: z.array(z.object({
    agentId: z.string(),
    agentName: z.string(),
    taskId: z.string(),
    content: z.any(), // 黑板中读取的结构化产物
    confidence: z.number().min(0).max(1),
  })),
  constraints: z.array(z.string()), // 格式/质量约束
});

// Synthesizer 输出 Schema
const SynthesizerOutputSchema = z.object({
  synthesis: z.string(), // 聚合后的最终产物
  contributions: z.array(z.object({
    section: z.string(),
    agentId: z.string(),
    agentName: z.string(),
  })),
  conflicts: z.array(z.object({
    description: z.string(),
    involvedAgents: z.array(z.string()),
    resolution: z.string(),
  })),
  warnings: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
```

Synthesizer 的设计灵感来自 **ORCH 框架** [^50^] 的 "many analyses, one merge" 理念，以及 **Swarms** 框架 [^61^] 的 `ConcurrentWorkflow + aggregator_agent` 模式。

---

## 4. Agent Runtime 统一层：屏蔽底层差异

### 4.1 三类 Runtime 的统一抽象

AgentHub 需要同时支持 **LLM 对话式 Agent**（如自定义的架构师 Agent）、**Code Agent CLI**（如 Codex、Claude Code）和 **Native Tool**（如文件读取、Git 操作）。这三类执行体的调用方式、输出格式、错误模式完全不同，必须通过统一抽象封装。

```typescript
// 统一 Agent Runtime 接口
interface AgentRuntime {
  // 元信息
  readonly runtimeType: 'llm' | 'code-agent' | 'native-tool';
  readonly agentProfile: AgentProfile;
  
  // 核心执行方法
  execute(input: AgentInput): AsyncGenerator<AgentOutputChunk, AgentResult, void>;
  
  // 能力查询
  getCapabilities(): Capability[];
  
  // 健康检查
  healthCheck(): Promise<HealthStatus>;
  
  // 取消执行
  abort(signal: AbortSignal): Promise<void>;
}

// 统一输入
interface AgentInput {
  task: string;              // 任务描述
  context: BlackboardRef[];  // 从黑板引用的上下文数据
  systemPrompt?: string;     // 可选的系统提示覆盖
  tools?: ToolRef[];         // 可用的工具列表
  timeout?: number;          // 超时时间（毫秒）
}

// 流式输出块
interface AgentOutputChunk {
  type: 'text' | 'artifact' | 'progress' | 'error' | 'tool_call';
  content: unknown;
  timestamp: number;
}

// 最终结果
interface AgentResult {
  status: 'success' | 'failure' | 'cancelled' | 'timeout';
  artifacts: Artifact[];     // 结构化产物
  outputRef: BlackboardRef;  // 写入黑板的引用
  usage: TokenUsage;         // Token 消耗
  duration: number;          // 执行耗时
}
```

### 4.2 LLM Runtime

LLM Runtime 是最基础的 Agent 执行方式，直接与 LLM API 交互。AgentHub 的自研流式客户端需要支持：

- **多供应商兼容**：OpenAI-compatible + Anthropic API 格式
- **结构化输出**：通过 Zod Schema 约束 LLM 输出格式 [^71^][^78^]
- **工具调用**：支持 Function Calling / Tool Use 模式
- **流式响应**：SSE 流式输出，实时反馈到前端
- **上下文管理**：自动注入系统提示、黑板引用、历史消息

```typescript
class LLMRuntime implements AgentRuntime {
  readonly runtimeType = 'llm';
  
  async *execute(input: AgentInput): AsyncGenerator<AgentOutputChunk, AgentResult, void> {
    // 1. 构建完整提示
    const messages = await this.buildMessages(input);
    
    // 2. 调用 LLM（流式）
    const stream = await this.llmClient.chat.completions.create({
      model: this.agentProfile.model || DEFAULT_MODEL,
      messages,
      tools: input.tools?.map(t => t.schema),
      response_format: { type: 'json_object' }, // 结构化输出
      stream: true,
    });
    
    // 3. 流式输出 + 工具调用处理
    let accumulated = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      accumulated += delta;
      yield { type: 'text', content: delta, timestamp: Date.now() };
      
      // 检测工具调用并执行
      if (chunk.choices[0]?.delta?.tool_calls) {
        yield* this.handleToolCalls(chunk.choices[0].delta.tool_calls);
      }
    }
    
    // 4. 解析并验证输出
    const parsed = await this.parseAndValidate(accumulated);
    
    // 5. 写入黑板
    const outputRef = await this.blackboard.write({
      namespace: input.context[0]?.namespace,
      key: `task_${input.taskId}_output`,
      value: parsed,
      agentId: this.agentProfile.id,
    });
    
    return {
      status: 'success',
      artifacts: parsed.artifacts || [],
      outputRef,
      usage: stream.usage,
      duration: Date.now() - startTime,
    };
  }
}
```

### 4.3 Code Agent Runtime

Code Agent Runtime 负责与外部 Code Agent CLI（Codex、Claude Code、OpenCode）集成。这是 AgentHub 最具特色的部分，也是与纯 LLM 对话式 Agent 最大的区别。

**架构设计要点**：

| 挑战 | 解决方案 |
|------|----------|
| CLI 是交互式进程，非一次性调用 | 使用 **tmux / pty** 保持长连接，或 **JSONL 会话文件** 通信 [^34^] |
| 输出是非结构化的终端文本 | 通过 **Hook 机制** 捕获关键事件（SessionStart, Stop, FileEdit）[^34^] |
| 需要工作区隔离 | 每个 Code Agent 任务在独立的 **Git 分支** 上执行 |
| 需要权限控制 | 通过 **沙箱策略** 分级控制（read-only / workspace-write / danger-full-access） |
| 产物是代码变更，非文本 | 执行完毕后通过 `git diff` 提取 **结构化 Diff**，而非原始终端输出 |

```typescript
class CodeAgentRuntime implements AgentRuntime {
  readonly runtimeType = 'code-agent';
  
  async *execute(input: AgentInput): AsyncGenerator<AgentOutputChunk, AgentResult, void> {
    // 1. Git 分支隔离
    const branchName = `agenthub/${input.runId}/${this.agentProfile.id}/${input.taskId}`;
    await this.gitManager.createBranch(branchName);
    
    // 2. 启动 Code Agent CLI 进程
    const session = await this.cliManager.startSession({
      agentType: this.agentProfile.codeAgentType, // 'codex' | 'claude-code' | 'opencode'
      workingDir: input.workspacePath,
      branch: branchName,
      timeout: input.timeout || 300000,
    });
    
    // 3. 发送任务指令
    await session.sendInput(input.task);
    
    // 4. 流式捕获输出（通过 Hook 或 stdout 解析）
    for await (const event of session.events()) {
      switch (event.type) {
        case 'output':
          yield { type: 'text', content: event.content, timestamp: event.timestamp };
          break;
        case 'file_edit':
          yield { type: 'artifact', content: { type: 'file_change', ...event }, timestamp: event.timestamp };
          break;
        case 'tool_call':
          yield { type: 'tool_call', content: event, timestamp: event.timestamp };
          break;
        case 'error':
          yield { type: 'error', content: event.error, timestamp: event.timestamp };
          break;
      }
    }
    
    // 5. 提取 Diff 产物
    const diff = await this.gitManager.extractDiff(branchName);
    const structuredDiff = await this.parseDiffToStructured(diff);
    
    // 6. 写入黑板
    const outputRef = await this.blackboard.write({
      namespace: input.context[0]?.namespace,
      key: `task_${input.taskId}_diff`,
      value: {
        type: 'code_diff',
        changes: structuredDiff,
        branch: branchName,
        agentId: this.agentProfile.id,
      },
    });
    
    return {
      status: session.exitCode === 0 ? 'success' : 'failure',
      artifacts: [{ type: 'code_diff', content: structuredDiff }],
      outputRef,
      usage: session.tokenUsage,
      duration: Date.now() - startTime,
    };
  }
}
```

### 4.4 Native Tool Runtime

Native Tool Runtime 执行简单的本地工具（如文件读取、目录列表、Git 状态查询）。这类 Runtime 是 **只读** 的，不涉及 LLM 调用，执行速度快，适合作为其他 Agent 的上下文补充。

```typescript
class NativeToolRuntime implements AgentRuntime {
  readonly runtimeType = 'native-tool';
  
  async *execute(input: AgentInput): AsyncGenerator<AgentOutputChunk, AgentResult, void> {
    // 直接执行工具函数，无 LLM 调用
    const tool = this.toolRegistry.get(input.task);
    const result = await tool.execute(input.context);
    
    yield { type: 'artifact', content: result, timestamp: Date.now() };
    
    return {
      status: 'success',
      artifacts: [result],
      outputRef: await this.blackboard.write({ ... }),
      usage: { promptTokens: 0, completionTokens: 0 },
      duration: Date.now() - startTime,
    };
  }
}
```

### 4.5 Runtime 注册与发现

所有 Runtime 实例在系统启动时注册到 **RuntimeRegistry**，支持动态添加（用户自建 Agent）：

```typescript
class RuntimeRegistry {
  private runtimes = new Map<string, AgentRuntime>();
  
  register(profile: AgentProfile, runtime: AgentRuntime): void {
    this.runtimes.set(profile.id, runtime);
  }
  
  resolve(task: Task, workspace: Workspace): AgentRuntime {
    // 根据任务类型和 Agent 能力标签匹配最佳 Runtime
    const candidates = Array.from(this.runtimes.values())
      .filter(r => r.agentProfile.capabilities.some(c => task.requiredCapabilities.includes(c)));
    
    // 优先级：用户指定 > 历史成功率 > 负载均衡
    return this.selectBestCandidate(candidates, task);
  }
  
  // 用户自建 Agent 的动态注册
  async createCustomAgent(config: CustomAgentConfig): Promise<AgentRuntime> {
    const profile: AgentProfile = {
      id: generateId(),
      name: config.name,
      avatar: config.avatar,
      role: 'custom',
      capabilities: config.capabilities,
      systemPrompt: config.systemPrompt,
      runtimeType: 'llm',
      model: config.model,
    };
    
    const runtime = new LLMRuntime(profile, this.llmClient, this.blackboard);
    this.register(profile, runtime);
    return runtime;
  }
}
```

---

## 5. 黑板系统：Agent 间通信的唯一媒介

### 5.1 为什么不用消息传递？

传统多 Agent 系统（如 AutoGen）采用 **消息传递（Message Passing）** 模式，Agent 之间直接发送消息 [^5^]。这种模式在 Agent 数量少时简单直观，但随着 Agent 增多，会出现 **消息爆炸**（N×N 的连接）、**状态不一致**（每个 Agent 维护各自的对话历史）和 **调试困难**（消息散落在各个 Agent 的上下文中）的问题。

AgentHub 采用 **黑板架构（Blackboard Architecture）** [^63^][^66^][^69^]，所有 Agent 共享一个中心化的状态空间。这种设计借鉴了经典 AI 系统中的黑板模型，但在 LLM 时代做了现代化改造：

| 特性 | 消息传递（AutoGen） | 黑板系统（AgentHub） |
|------|-------------------|-------------------|
| 通信方式 | Agent → Agent 直接发送 | Agent → Blackboard → Agent 间接读取 |
| 状态可见性 | 仅对话参与者可见 | 全局可见（按权限过滤） |
| 历史追溯 | 分散在各 Agent 内存中 | 中心化版本化存储 |
| 新 Agent 接入 | 需要知道向谁发消息 | 读取黑板即可获取全部上下文 |
| 调试 | 困难，需追踪消息链 | 简单，黑板状态即系统状态 |
| 一致性 | 最终一致，难以保证 | 强一致（单写入点 + 版本控制） |

### 5.2 黑板数据结构

```typescript
interface Blackboard {
  // 命名空间隔离
  namespace(workspaceId: string, runId: string): BlackboardNamespace;
  
  // 核心操作
  read<T>(key: string, schema: z.ZodSchema<T>): Promise<T | undefined>;
  write<T>(entry: BlackboardEntry<T>): Promise<BlackboardRef>;
  update<T>(key: string, updater: (prev: T) => T): Promise<BlackboardRef>;
  
  // 查询
  query(filter: BlackboardQuery): Promise<BlackboardEntry[]>;
  subscribe(filter: BlackboardQuery, callback: (entry: BlackboardEntry) => void): Subscription;
  
  // 版本管理
  getVersion(key: string, version: number): Promise<BlackboardEntry | undefined>;
  listVersions(key: string): Promise<number[]>;
}

interface BlackboardEntry<T = unknown> {
  key: string;
  value: T;
  schema: z.ZodSchema<T>; // 写入时校验
  agentId: string; // 写入者
  timestamp: number;
  version: number;
  taskId?: string; // 关联的任务
  tags: string[]; // 可检索标签
}

interface BlackboardRef {
  namespace: string;
  key: string;
  version: number;
}
```

### 5.3 黑板访问模式

**模式一：产物发布（Artifact Publishing）**
Agent 完成任务后将产物写入黑板，供其他 Agent 或 Synthesizer 读取：
```typescript
// Agent A 写入产物
await blackboard.write({
  key: 'design_doc.api_endpoints',
  value: { endpoints: [...] },
  schema: ApiEndpointsSchema,
  agentId: 'architect_agent',
  taskId: 'task_001',
  tags: ['design', 'api', 'phase_2'],
});

// Agent B 读取产物
const apiDesign = await blackboard.read('design_doc.api_endpoints', ApiEndpointsSchema);
```

**模式二：进度广播（Progress Broadcasting）**
Agent 在长时间运行中定期更新进度，Orchestrator 和用户界面实时订阅：
```typescript
// Agent 定期更新进度
await blackboard.update(`progress.${taskId}`, (prev) => ({
  ...prev,
  status: 'running',
  currentStep: 'generating_tests',
  percentComplete: 75,
  lastUpdate: Date.now(),
}));

// UI 订阅进度更新
blackboard.subscribe(
  { keyPattern: 'progress.*' },
  (entry) => websocket.broadcast('progress_update', entry)
);
```

**模式三：冲突标记（Conflict Marking）**
当多个 Agent 修改同一文件时，黑板中标记冲突区域供 ConflictResolver 处理：
```typescript
await blackboard.write({
  key: 'conflicts.file_src_utils_ts',
  value: {
    filePath: 'src/utils.ts',
    conflictingAgents: ['agent_a', 'agent_b'],
    ranges: [
      { start: 10, end: 25, agentAContent: '...', agentBContent: '...' },
    ],
  },
  schema: ConflictSchema,
  agentId: 'conflict_detector',
  tags: ['conflict', 'needs_resolution'],
});
```

### 5.4 黑板实现：SQLite + 内存缓存

考虑到 AgentHub 是单机部署（Bun + SQLite），黑板系统的实现策略：

```
┌─────────────────────────────────────────────────┐
│                黑板系统实现                       │
├─────────────────────────────────────────────────┤
│  内存层（L1 缓存）                                │
│  • 当前活跃 Workspace 的全部黑板数据               │
│  • Zod Schema 校验后的 JavaScript 对象            │
│  • 订阅通知机制（Map<key, Set<callback>>）        │
├─────────────────────────────────────────────────┤
│  持久层（SQLite）                                 │
│  • `blackboard_entries` 表：键值 + 版本 + 元数据  │
│  • `blackboard_subscriptions` 表：持久化订阅       │
│  • WAL 模式支持并发读写                           │
├─────────────────────────────────────────────────┤
│  序列化                                          │
│  • 值 → JSON 字符串存储                           │
│  • Schema 版本号随数据存储（支持 Schema 演进）     │
└─────────────────────────────────────────────────┘
```

---

## 6. 任务调度与并发控制

### 6.1 DAG 执行引擎

Orchestrator 根据任务账本的依赖关系构建 DAG，使用拓扑排序确定执行顺序：

```typescript
class TaskGraph {
  private adjacency = new Map<string, Set<string>>();
  private inDegree = new Map<string, number>();
  
  addTask(task: Task): void {
    if (!this.adjacency.has(task.taskId)) {
      this.adjacency.set(task.taskId, new Set());
      this.inDegree.set(task.taskId, 0);
    }
    
    for (const dep of task.dependencies) {
      if (!this.adjacency.has(dep)) {
        this.adjacency.set(dep, new Set());
        this.inDegree.set(dep, 0);
      }
      this.adjacency.get(dep)!.add(task.taskId);
      this.inDegree.set(task.taskId, (this.inDegree.get(task.taskId) || 0) + 1);
    }
  }
  
  // Kahn 算法拓扑排序，返回可并行执行的层级
  topologicalLayers(): string[][] {
    const layers: string[][] = [];
    const inDegree = new Map(this.inDegree);
    const queue: string[] = [];
    
    // 找到所有入度为 0 的任务
    for (const [taskId, degree] of inDegree) {
      if (degree === 0) queue.push(taskId);
    }
    
    while (queue.length > 0) {
      const layer: string[] = [];
      const nextQueue: string[] = [];
      
      for (const taskId of queue) {
        layer.push(taskId);
        for (const neighbor of this.adjacency.get(taskId) || []) {
          const newDegree = (inDegree.get(neighbor) || 0) - 1;
          inDegree.set(neighbor, newDegree);
          if (newDegree === 0) nextQueue.push(neighbor);
        }
      }
      
      layers.push(layer);
      queue.length = 0;
      queue.push(...nextQueue);
    }
    
    return layers;
  }
  
  // 环检测
  hasCycle(): boolean {
    const layers = this.topologicalLayers();
    const totalTasks = this.adjacency.size;
    const scheduledTasks = layers.flat().length;
    return scheduledTasks < totalTasks;
  }
}
```

### 6.2 并发控制：信号量 + Token Bucket

多 Agent 并行执行时，必须控制并发量以避免：
- **API 限流**：LLM API 有 RPM（Requests Per Minute）和 TPM（Tokens Per Minute）限制
- **资源耗尽**：过多同时运行的 Code Agent CLI 进程会耗尽 CPU/内存
- **Git 冲突**：过多同时操作 Git 工作区会导致锁竞争

AgentHub 采用 **双层并发控制** [^46^][^60^]：

```typescript
class ConcurrencyController {
  // 层1：信号量 - 控制同时执行的 Agent 数量
  private agentSemaphore: Semaphore;
  
  // 层2：Token Bucket - 控制 API 调用速率
  private tokenBuckets = new Map<string, TokenBucket>();
  
  constructor(config: ConcurrencyConfig) {
    this.agentSemaphore = new Semaphore(config.maxConcurrentAgents); // 默认 3
    
    // 为每个 LLM 供应商配置 Token Bucket
    for (const [provider, limits] of Object.entries(config.providerLimits)) {
      this.tokenBuckets.set(provider, new TokenBucket({
        rate: limits.requestsPerSecond, // 如 10 req/s
        capacity: limits.burstCapacity,  // 如 20 req
      }));
    }
  }
  
  async acquire(task: Task): Promise<ReleaseFn> {
    // 1. 等待信号量
    const releaseSemaphore = await this.agentSemaphore.acquire();
    
    // 2. 等待 Token Bucket（如果任务使用 LLM）
    const runtime = this.runtimeRegistry.get(task.assignedAgent);
    if (runtime.runtimeType === 'llm') {
      const provider = runtime.getProvider();
      const bucket = this.tokenBuckets.get(provider);
      if (bucket) await bucket.consume(1);
    }
    
    // 3. 返回释放函数
    return () => {
      releaseSemaphore();
      // Token 自动随时间补充，无需显式释放
    };
  }
}

// Token Bucket 实现
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  
  constructor(private config: { rate: number; capacity: number }) {
    this.tokens = config.capacity;
    this.lastRefill = Date.now();
  }
  
  async consume(amount: number = 1): Promise<void> {
    while (true) {
      const now = Date.now();
      const elapsed = (now - this.lastRefill) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
      this.lastRefill = now;
      
      if (this.tokens >= amount) {
        this.tokens -= amount;
        return;
      }
      
      const waitTime = (amount - this.tokens) / this.rate * 1000;
      await new Promise(r => setTimeout(r, waitTime));
    }
  }
}
```

### 6.3 执行流程

```typescript
class TaskExecutor {
  async executeRun(runId: string, workspace: Workspace): Promise<void> {
    const ledger = await this.loadTaskLedger(runId);
    const graph = new TaskGraph();
    
    for (const task of ledger.tasks) {
      graph.addTask(task);
    }
    
    if (graph.hasCycle()) {
      throw new Error('Task dependency cycle detected');
    }
    
    const layers = graph.topologicalLayers();
    
    for (const layer of layers) {
      // 并行执行当前层的所有任务
      const results = await Promise.allSettled(
        layer.map(taskId => this.executeTask(taskId, workspace))
      );
      
      // 检查结果，失败任务触发重规划
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const taskId = layer[i];
        
        if (result.status === 'rejected') {
          const adjustment = await this.orchestrator.replan({
            failedTask: ledger.getTask(taskId),
            error: result.reason,
            blackboard: this.blackboard,
          });
          
          if (adjustment.strategy === 'escalate_to_user') {
            await this.pauseAndNotifyUser(runId, adjustment.reason);
            return;
          }
          
          // 应用调整（重试/替换 Agent/重规划）
          await this.applyAdjustment(adjustment, ledger);
        }
      }
    }
    
    // 所有任务完成，触发最终聚合
    await this.orchestrator.synthesize(runId);
  }
  
  private async executeTask(taskId: string, workspace: Workspace): Promise<void> {
    const task = this.ledger.getTask(taskId);
    const release = await this.concurrencyController.acquire(task);
    
    try {
      task.status = 'running';
      task.startedAt = Date.now();
      
      const runtime = this.runtimeRegistry.resolve(task, workspace);
      const input = await this.buildAgentInput(task);
      
      // 流式执行，实时更新黑板
      for await (const chunk of runtime.execute(input)) {
        await this.processOutputChunk(task, chunk);
      }
      
      task.status = 'completed';
      task.completedAt = Date.now();
    } catch (error) {
      task.status = 'failed';
      task.retryCount++;
      throw error;
    } finally {
      release();
    }
  }
}
```

---

## 7. 冲突检测与解决

### 7.1 三层冲突处理体系

当多个 Code Agent 并行修改同一工作区时，冲突不可避免。AgentHub 设计了三层冲突处理体系，从最简单的文本级到最复杂的语义级：

```
┌─────────────────────────────────────────────────────────────────┐
│                     冲突处理三层体系                              │
├─────────────────────────────────────────────────────────────────┤
│  L1: 文件级隔离（预防）                                          │
│  • 每个 Agent 任务在独立 Git 分支执行                              │
│  • Agent 被分配修改不同文件时，无冲突                              │
│  • Orchestrator 在任务分配时尽量避免文件重叠                       │
├─────────────────────────────────────────────────────────────────┤
│  L2: Git 合并检测（自动）                                        │
│  • 任务完成后尝试 merge 回临时分支                                 │
│  • 无冲突 → 自动合并                                             │
│  • 有冲突 → 提取冲突区域，上报 L3                                 │
├─────────────────────────────────────────────────────────────────┤
│  L3: LLM 语义合并（仲裁）                                        │
│  • 将冲突区域 + 上下文提交给 LLM                                   │
│  • LLM 基于语义理解选择/合并/重写冲突代码                           │
│  • 用户确认后应用                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 Git 分支隔离策略

每个非 read-only 的 Code Agent 任务执行前，系统自动创建独立分支：

```typescript
class GitBranchManager {
  async createIsolatedBranch(config: BranchConfig): Promise<BranchInfo> {
    const branchName = `agenthub/${config.runId}/${config.agentId}/${config.taskId}`;
    
    // 1. Stash 保护用户当前工作区
    await this.git.stash.push({ message: `agenthub-pre-${branchName}` });
    
    // 2. 从 main 创建独立分支
    await this.git.checkout(['-b', branchName, 'main']);
    
    // 3. 记录分支元数据
    await this.db.insert(gitBranches).values({
      branchName,
      runId: config.runId,
      agentId: config.agentId,
      taskId: config.taskId,
      createdAt: new Date(),
      status: 'active',
    });
    
    return { branchName, baseCommit: await this.git.revparse(['HEAD']) };
  }
  
  async extractDiff(branchName: string): Promise<StructuredDiff> {
    // 提取分支相对于 main 的所有变更
    const diffOutput = await this.git.diff(['main...' + branchName, '--name-status']);
    const fileChanges = this.parseNameStatus(diffOutput);
    
    const changes: FileChange[] = [];
    for (const file of fileChanges) {
      const patch = await this.git.diff(['main...' + branchName, '--', file.path]);
      changes.push({
        path: file.path,
        status: file.status, // added | modified | deleted | renamed
        patch,
        // 解析 patch 为结构化格式
        hunks: this.parsePatchToHunks(patch),
      });
    }
    
    return { changes, branchName };
  }
  
  async detectConflicts(branches: string[]): Promise<ConflictReport> {
    // 创建临时合并分支
    const tempBranch = `agenthub/merge/${Date.now()}`;
    await this.git.checkout(['-b', tempBranch, 'main']);
    
    const conflicts: FileConflict[] = [];
    
    for (const branch of branches) {
      try {
        await this.git.merge([branch, '--no-commit', '--no-ff']);
      } catch (error) {
        // 合并失败，提取冲突文件
        const status = await this.git.status();
        for (const file of status.conflicted) {
          const content = await fs.readFile(file, 'utf-8');
          const conflictRanges = this.extractConflictMarkers(content);
          conflicts.push({
            filePath: file,
            branches: [tempBranch, branch],
            ranges: conflictRanges,
          });
        }
        
        // 重置合并状态
        await this.git.reset(['--hard']);
        await this.git.clean(['-fd']);
      }
    }
    
    // 删除临时分支
    await this.git.checkout('main');
    await this.git.branch(['-D', tempBranch]);
    
    return { conflicts, hasConflicts: conflicts.length > 0 };
  }
}
```

### 7.3 LLM 语义合并

当 Git 自动合并失败时，ConflictResolver 调用 LLM 进行语义级合并：

```typescript
class ConflictResolver {
  async resolveWithLLM(conflict: FileConflict, context: MergeContext): Promise<MergeResult> {
    // 1. 收集冲突区域的上下文
    const baseContent = await this.getBaseVersion(conflict.filePath, context.baseCommit);
    const agents = await Promise.all(
      conflict.branches.map(b => this.getAgentForBranch(b))
    );
    
    // 2. 构建 LLM 提示
    const prompt = this.buildMergePrompt({
      filePath: conflict.filePath,
      baseVersion: baseContent,
      changes: conflict.ranges.map((range, i) => ({
        agent: agents[i],
        description: agents[i].taskDescription,
        content: range.theirs,
      })),
    });
    
    // 3. 调用 LLM 进行语义合并
    const result = await this.llmClient.generateObject({
      model: this.mergeModel,
      schema: MergeResultSchema,
      prompt,
      temperature: 0.2, // 低温度，确保确定性
    });
    
    // 4. 验证合并结果
    const validation = await this.validateMergeResult(result, conflict.filePath);
    
    return {
      ...result,
      needsUserConfirmation: !validation.isSafe,
      confidence: validation.confidence,
    };
  }
  
  private buildMergePrompt(params: MergePromptParams): string {
    return `
你是一位资深的代码审查工程师。多个 Agent 同时修改了同一个文件，产生了冲突。
请基于语义理解，选择最佳的合并方案。

文件：${params.filePath}

原始代码（base）：
\`\`\`
${params.baseVersion}
\`\`\`

${params.changes.map((c, i) => `
Agent ${i + 1} (${c.agent.name}) 的修改：
任务描述：${c.description}
\`\`\`
${c.content}
\`\`\`
`).join('\n')}

请分析每个修改的意图，选择或合并出最佳的代码版本。
输出格式：
- mergedCode: 合并后的完整代码
- resolution: 选择说明（为什么这样合并）
- rejectedChanges: 被舍弃的修改及原因
- confidence: 0-1 的置信度
`;
  }
}
```

---

## 8. 产物管理与预览

### 8.1 产物类型系统

AgentHub 支持多种产物类型，每种类型有对应的预览和编辑方式：

| 产物类型 | 数据结构 | 预览方式 | 编辑能力 |
|----------|----------|----------|----------|
| **代码 Diff** | `FileChange[]` | Diff 视图（增删高亮） | 行内编辑、一键应用 |
| **网页** | `{ html, css, js }` | iframe 实时渲染 | 代码编辑器 |
| **文档** | `{ markdown, sections[] }` | Markdown 渲染 | 富文本编辑器 |
| **PPT** | `{ slides[], theme }` | 幻灯片浏览 | 基础编辑 |
| **部署状态** | `{ status, url, logs }` | 状态卡片 | 查看日志 |
| **结构化数据** | `JSON` | 表格/JSON 树 | 格式化编辑 |

### 8.2 产物 → 消息卡片转换

所有产物在聊天流中以 **内联消息卡片** 的形式展示：

```typescript
interface ArtifactMessage {
  messageId: string;
  type: 'artifact';
  sender: AgentProfile;
  timestamp: number;
  artifact: Artifact;
  actions: MessageAction[]; // 可执行操作
}

interface Artifact {
  artifactId: string;
  type: ArtifactType;
  title: string;
  content: unknown; // 类型特定的内容
  version: number;
  parentArtifactId?: string; // 用于版本链
}

interface MessageAction {
  id: string;
  label: string;
  icon: string;
  handler: ActionHandler;
  requiresConfirmation?: boolean;
}

// 代码 Diff 卡片的操作
const diffActions: MessageAction[] = [
  { id: 'preview', label: '预览', icon: 'eye', handler: showDiffPreview },
  { id: 'edit', label: '编辑', icon: 'pencil', handler: openInlineEditor },
  { id: 'apply', label: '应用', icon: 'check', handler: applyDiff, requiresConfirmation: true },
  { id: 'discard', label: '丢弃', icon: 'trash', handler: discardDiff, requiresConfirmation: true },
];

// 网页卡片的操作
const webpageActions: MessageAction[] = [
  { id: 'open', label: '全屏预览', icon: 'maximize', handler: openFullscreenPreview },
  { id: 'edit', label: '编辑代码', icon: 'code', handler: openCodeEditor },
  { id: 'deploy', label: '部署', icon: 'rocket', handler: deployWebpage, requiresConfirmation: true },
];
```

### 8.3 版本历史

每个产物支持版本历史，用户可以回溯查看和切换：

```typescript
interface ArtifactVersion {
  version: number;
  artifactId: string;
  parentVersion?: number;
  createdAt: number;
  createdBy: string; // Agent ID
  changeSummary: string; // LLM 生成的变更摘要
  content: unknown;
}

class ArtifactVersionManager {
  async createVersion(artifact: Artifact, agentId: string): Promise<ArtifactVersion> {
    const latest = await this.getLatestVersion(artifact.artifactId);
    const newVersion: ArtifactVersion = {
      version: (latest?.version || 0) + 1,
      artifactId: artifact.artifactId,
      parentVersion: latest?.version,
      createdAt: Date.now(),
      createdBy: agentId,
      changeSummary: await this.generateChangeSummary(latest?.content, artifact.content),
      content: artifact.content,
    };
    
    await this.db.insert(artifactVersions).values(newVersion);
    return newVersion;
  }
  
  async generateChangeSummary(prev: unknown, curr: unknown): Promise<string> {
    // 调用 LLM 生成变更摘要
    const result = await this.llmClient.generateObject({
      model: this.summaryModel,
      schema: z.object({ summary: z.string() }),
      prompt: `请用一句话总结代码变更：\n旧版本：${JSON.stringify(prev)}\n新版本：${JSON.stringify(curr)}`,
    });
    return result.summary;
  }
}
```

---

## 9. 协作规范体系：Harness 系统

### 9.1 从 "Prompt Engineering" 到 "Harness Engineering"

传统 AI 开发关注 "Prompt Engineering" —— 如何写提示词让 LLM 输出更好。但在多 Agent 协作场景中，单个提示词的优化收益有限，系统级的设计（Agent 角色定义、工具配置、输出格式、重试策略、内存管理）才是决定成败的关键。这种系统级设计被称为 **"Harness Engineering"** [^47^][^53^][^59^]。

AgentHub 的 Harness 系统将协作规范（Spec、Skill、Rules）编码为 **可加载执行的配置文件**，而非静态文档。

### 9.2 三层规范体系

```
┌─────────────────────────────────────────────────────────────────┐
│                     Harness 三层规范体系                         │
├─────────────────────────────────────────────────────────────────┤
│  L1: Spec（规格）- 做什么                                         │
│  • 产品需求文档（PRD）的 Agent 可解析版本                           │
│  • 定义目标、范围、验收标准                                         │
│  • 被 Planner 读取，用于任务拆解                                   │
├─────────────────────────────────────────────────────────────────┤
│  L2: Skill（技能）- 怎么做                                        │
│  • Agent 的能力定义（工具集 + 系统提示模板）                        │
│  • 可被动态加载和组合                                              │
│  • 版本化管理，支持热更新                                           │
├─────────────────────────────────────────────────────────────────┤
│  L3: Rules（规则）- 约束条件                                       │
│  • 代码规范、命名约定、安全策略                                     │
│  • 被注入到 Agent 的系统提示中                                      │
│  • 支持按 Workspace / 项目级别覆盖                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 9.3 Spec 设计

Spec 是 AgentHub 的最高层规范，定义了 **用户请求到执行计划的映射规则**：

```yaml
# .agenthub/specs/web-app-building.spec.yml
spec:
  id: web-app-building
  name: Web 应用构建
  description: 从零构建完整 Web 应用的协作流程
  version: 1.0.0
  
  # 触发条件
  triggers:
    - pattern: "(构建|创建|写).*?(网站|应用|web|app)"
    - pattern: "build.*?(website|app|web application)"
  
  # 协作流程（SOP）
  phases:
    - name: requirement_analysis
      description: 分析用户需求，澄清模糊点
      requiredAgents: [analyst]
      expectedArtifacts:
        - type: spec
          schema: RequirementSpecSchema
          
    - name: architecture_design
      description: 设计系统架构和技术选型
      requiredAgents: [architect]
      dependsOn: [requirement_analysis]
      expectedArtifacts:
        - type: design_doc
          schema: ArchitectureDesignSchema
          
    - name: implementation
      description: 并行实现前后端代码
      requiredAgents: [frontend_engineer, backend_engineer]
      dependsOn: [architecture_design]
      expectedArtifacts:
        - type: code_diff
          schema: CodeDiffSchema
          
    - name: review
      description: 代码审查和测试
      requiredAgents: [reviewer, qa_engineer]
      dependsOn: [implementation]
      expectedArtifacts:
        - type: review_report
          schema: ReviewReportSchema
  
  # 产物聚合配置
  synthesis:
    mode: phased # 按阶段聚合 | final 最终聚合
    aggregatorPrompt: |
      你是一位技术负责人。请将各 Agent 的产出整合为完整的项目交付物。
      要求：消除冗余、标注贡献者、指出风险。
```

### 9.4 Skill 设计

Skill 定义了 Agent 的 **能力包**，包含工具集和提示模板：

```typescript
// Skill 定义
interface Skill {
  id: string;
  name: string;
  description: string;
  version: string;
  
  // 系统提示模板
  systemPromptTemplate: string;
  
  // 工具集
  tools: ToolDefinition[];
  
  // 输出格式约束
  outputSchema: z.ZodSchema;
  
  // 适用场景
  applicableWhen: (task: Task, context: Blackboard) => boolean;
  
  // 示例（few-shot）
  examples: Example[];
}

// 示例：前端工程师 Skill
const frontendEngineerSkill: Skill = {
  id: 'frontend-engineer',
  name: '前端工程师',
  description: '使用 React + TypeScript + Tailwind CSS 构建前端界面',
  version: '2.0.0',
  
  systemPromptTemplate: `
你是一位资深前端工程师，擅长 React 18 + TypeScript + Tailwind CSS。

## 技术栈
- React 18 (Hooks, Suspense)
- TypeScript (strict mode)
- Tailwind CSS
- Vite (构建工具)

## 编码规范
{{RULES.frontend_coding}}

## 当前任务
{{TASK_DESCRIPTION}}

## 输入上下文
{{BLACKBOARD_REFS}}

## 输出要求
1. 生成完整的、可直接运行的代码
2. 使用 TypeScript 严格类型
3. 遵循项目已有的代码风格
4. 如果修改现有文件，输出结构化 Diff
`,
  
  tools: [
    fileReadTool,
    fileWriteTool,
    codeSearchTool,
    npmInstallTool,
  ],
  
  outputSchema: CodeDiffSchema,
  
  applicableWhen: (task, context) => 
    task.requiredCapabilities.includes('frontend') ||
    task.tags?.includes('ui') ||
    task.tags?.includes('react'),
  
  examples: [
    {
      input: '创建一个用户登录表单',
      output: { /* 示例 Diff 结构 */ },
    },
  ],
};
```

### 9.5 Rules 设计

Rules 是 **约束性规范**，被注入到 Agent 的系统提示中：

```yaml
# .agenthub/rules/frontend-coding.yml
rules:
  id: frontend-coding
  name: 前端编码规范
  version: 1.0.0
  
  constraints:
    - "使用函数组件和 Hooks，不使用类组件"
    - "所有组件必须导出具名类型 Props"
    - "样式使用 Tailwind 工具类，避免内联样式"
    - "事件处理函数以 handle 开头"
    - "异步函数以 async 开头，使用 try/catch"
    
  naming:
    components: PascalCase
    hooks: "use{PascalCase}"
    functions: camelCase
    constants: UPPER_SNAKE_CASE
    
  forbidden:
    - "any 类型（除非必要，需注释说明）"
    - "直接修改 state（必须使用 setState）"
    - "在 useEffect 中遗漏依赖数组"
    
  imports:
    order:
      - "React 内置"
      - "第三方库"
      - "项目内部模块"
      - "相对路径导入"
    
  formatting:
    semicolons: false
    singleQuote: true
    trailingComma: all
```

### 9.6 Harness 加载与热更新

```typescript
class HarnessManager {
  private specs = new Map<string, Spec>();
  private skills = new Map<string, Skill>();
  private rules = new Map<string, Rules>();
  
  // 从文件系统加载 Harness
  async loadFromWorkspace(workspacePath: string): Promise<void> {
    const harnessDir = path.join(workspacePath, '.agenthub');
    
    // 加载 Specs
    const specFiles = await glob('specs/*.spec.yml', { cwd: harnessDir });
    for (const file of specFiles) {
      const spec = yaml.parse(await fs.readFile(file, 'utf-8'));
      this.specs.set(spec.id, this.validateSpec(spec));
    }
    
    // 加载 Skills
    const skillFiles = await glob('skills/*.skill.yml', { cwd: harnessDir });
    for (const file of skillFiles) {
      const skill = yaml.parse(await fs.readFile(file, 'utf-8'));
      this.skills.set(skill.id, this.validateSkill(skill));
    }
    
    // 加载 Rules
    const ruleFiles = await glob('rules/*.yml', { cwd: harnessDir });
    for (const file of ruleFiles) {
      const rules = yaml.parse(await fs.readFile(file, 'utf-8'));
      this.rules.set(rules.id, this.validateRules(rules));
    }
  }
  
  // 热更新
  watch(workspacePath: string): void {
    const watcher = fs.watch(path.join(workspacePath, '.agenthub'), { recursive: true });
    watcher.on('change', async (eventType, filename) => {
      if (filename?.endsWith('.yml')) {
        await this.loadFromWorkspace(workspacePath);
        console.log(`Harness hot-reloaded: ${filename}`);
      }
    });
  }
  
  // 为 Agent 构建完整的系统提示
  buildSystemPrompt(agent: AgentProfile, task: Task): string {
    const skill = this.skills.get(agent.skillId);
    const applicableRules = Array.from(this.rules.values())
      .filter(r => agent.appliedRules.includes(r.id));
    
    return skill.systemPromptTemplate
      .replace('{{RULES.frontend_coding}}', this.formatRules(applicableRules))
      .replace('{{TASK_DESCRIPTION}}', task.description)
      .replace('{{BLACKBOARD_REFS}}', this.formatBlackboardRefs(task.inputRefs));
  }
}
```

---

## 10. 错误处理与容错设计

### 10.1 分层错误处理

```
┌─────────────────────────────────────────────────────────────────┐
│                     分层错误处理体系                             │
├─────────────────────────────────────────────────────────────────┤
│  L1: Agent 内部错误                                             │
│  • LLM API 超时/限流 → 指数退避重试                               │
│  • 工具调用失败 → 向 Agent 返回错误信息，允许自我纠正                 │
│  • 输出格式不符合 Schema → 自动重试（最多3次），反馈错误给 LLM        │
├─────────────────────────────────────────────────────────────────┤
│  L2: Orchestrator 协调错误                                       │
│  • 任务失败 → 局部重规划（替换 Agent / 拆分任务 / 调整依赖）          │
│  • DAG 死锁 → 检测并打破循环依赖                                  │
│  • 全局失败 → 保存状态，通知用户，支持断点续执行                       │
├─────────────────────────────────────────────────────────────────┤
│  L3: 系统级错误                                                  │
│  • 进程崩溃 → 持久化状态恢复                                       │
│  • 数据库损坏 → WAL 日志回滚                                       │
│  • Git 损坏 → 分支隔离保护主分支                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 10.2 熔断器模式

当某个 Agent 或 LLM 供应商连续失败时，触发熔断器保护：

```typescript
class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failureCount = 0;
  private lastFailureTime?: number;
  
  constructor(private config: {
    failureThreshold: number;  // 触发熔断的失败次数
    timeout: number;          // 熔断持续时间（ms）
    halfOpenMaxCalls: number; // 半开状态允许的测试调用数
  }) {}
  
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - (this.lastFailureTime || 0) > this.config.timeout) {
        this.state = 'half-open';
        this.failureCount = 0;
      } else {
        throw new CircuitBreakerOpenError('Circuit breaker is OPEN');
      }
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.state = 'closed';
    }
    this.failureCount = 0;
  }
  
  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'open';
    }
  }
}

// 使用：为每个 LLM 供应商创建独立的熔断器
const circuitBreakers = new Map<string, CircuitBreaker>();

function getCircuitBreaker(provider: string): CircuitBreaker {
  if (!circuitBreakers.has(provider)) {
    circuitBreakers.set(provider, new CircuitBreaker({
      failureThreshold: 5,
      timeout: 60000, // 1分钟
      halfOpenMaxCalls: 2,
    }));
  }
  return circuitBreakers.get(provider)!;
}
```

### 10.3 指数退避重试

```typescript
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries: number;
    baseDelay: number;
    maxDelay: number;
    retryableErrors: Class<Error>[];
  }
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      // 检查是否可重试
      const isRetryable = options.retryableErrors.some(e => error instanceof e);
      if (!isRetryable || attempt === options.maxRetries) {
        throw error;
      }
      
      // 计算退避时间：baseDelay * 2^attempt + jitter
      const delay = Math.min(
        options.baseDelay * Math.pow(2, attempt),
        options.maxDelay
      );
      const jitter = Math.random() * 1000; // 0-1s 随机抖动
      
      await sleep(delay + jitter);
    }
  }
  
  throw lastError!;
}
```

---

## 11. IM 聊天范式集成

### 11.1 消息类型系统

AgentHub 的核心交互范式是 IM 聊天，所有系统行为都映射为消息流：

```typescript
// 基础消息接口
interface BaseMessage {
  messageId: string;
  sessionId: string;
  sender: MessageSender;
  timestamp: number;
  replyTo?: string; // 回复的消息 ID
}

type MessageSender = 
  | { type: 'user'; userId: string }
  | { type: 'agent'; agentId: string; agentName: string; avatar: string }
  | { type: 'system'; eventType: string };

// 文本消息
interface TextMessage extends BaseMessage {
  type: 'text';
  content: string;
  mentions: Mention[]; // @提及
}

// 产物消息（内联卡片）
interface ArtifactMessage extends BaseMessage {
  type: 'artifact';
  artifact: Artifact;
  actions: MessageAction[];
}

// 系统事件消息
interface SystemMessage extends BaseMessage {
  type: 'system';
  eventType: 'agent_joined' | 'agent_left' | 'task_started' | 'task_completed' | 'error';
  payload: unknown;
}

// @提及
interface Mention {
  agentId: string;
  agentName: string;
  position: [number, number]; // 在消息中的位置
}
```

### 11.2 @提及路由

用户通过 `@Agent名` 指定回复对象，系统解析并路由：

```typescript
class MentionRouter {
  async routeMessage(message: TextMessage, workspace: Workspace): Promise<RoutingResult> {
    const mentions = this.parseMentions(message.content);
    
    if (mentions.length === 0) {
      // 无 @提及：单聊模式，路由到会话默认 Agent
      return { mode: 'direct', targetAgent: workspace.defaultAgent };
    }
    
    if (mentions.length === 1 && mentions[0].agentId === 'orchestrator') {
      // @orchestrator：触发 Orchestrator 调度群聊
      return { mode: 'orchestrated', targetAgents: workspace.agents };
    }
    
    if (mentions.length === 1) {
      // 单 @：指定单个 Agent 回复
      return { mode: 'direct', targetAgent: mentions[0].agentId };
    }
    
    // 多 @：触发 Orchestrator 协调多个指定 Agent
    return { mode: 'orchestrated', targetAgents: mentions.map(m => m.agentId) };
  }
  
  parseMentions(content: string): Mention[] {
    const mentionRegex = /@(\w+)/g;
    const mentions: Mention[] = [];
    let match;
    
    while ((match = mentionRegex.exec(content)) !== null) {
      const agentName = match[1];
      const agentId = this.resolveAgentName(agentName);
      if (agentId) {
        mentions.push({
          agentId,
          agentName,
          position: [match.index, match.index + match[0].length],
        });
      }
    }
    
    return mentions;
  }
}
```

### 11.3 上下文管理

聊天历史自动作为上下文传递给 Agent，支持 **Pin 消息**作为长期上下文：

```typescript
class ContextManager {
  async buildContext(session: Session, agent: AgentProfile): Promise<Context> {
    // 1. 获取最近 N 条消息（滑动窗口）
    const recentMessages = await this.getRecentMessages(session.id, 50);
    
    // 2. 获取 Pin 消息（长期上下文）
    const pinnedMessages = await this.getPinnedMessages(session.id);
    
    // 3. 获取黑板引用（Agent 间共享状态）
    const blackboardRefs = await this.getRelevantBlackboardEntries(session.workspaceId);
    
    // 4. 计算 Token 预算并截断
    const tokenBudget = this.calculateTokenBudget(agent);
    const truncated = this.truncateToBudget({
      systemPrompt: agent.systemPrompt,
      pinnedMessages,
      recentMessages,
      blackboardRefs,
    }, tokenBudget);
    
    return {
      systemPrompt: truncated.systemPrompt,
      messages: [...truncated.pinnedMessages, ...truncated.recentMessages],
      blackboardRefs: truncated.blackboardRefs,
    };
  }
  
  private calculateTokenBudget(agent: AgentProfile): number {
    // 不同模型有不同的上下文长度
    const modelLimits: Record<string, number> = {
      'gpt-4o': 128000,
      'claude-3-5-sonnet': 200000,
      'deepseek-chat': 64000,
    };
    
    const limit = modelLimits[agent.model] || 128000;
    // 保留 20% 给输出
    return Math.floor(limit * 0.8);
  }
}
```

---

## 12. 可观测性设计

### 12.1 三层可观测

| 层级 | 内容 | 存储 | 查询方式 |
|------|------|------|----------|
| **执行追踪** | 每个 Agent 的输入、输出、工具调用、耗时 | SQLite `execution_logs` 表 | 按 session/run/agent 过滤 |
| **黑板历史** | 黑板的所有写入操作（版本化） | SQLite `blackboard_entries` 表 | 按 key/时间范围查询 |
| **系统事件** | Orchestrator 决策、调度事件、错误 | SQLite `system_events` 表 | 实时流式推送 |

### 12.2 执行追踪

```typescript
interface ExecutionTrace {
  traceId: string;
  runId: string;
  sessionId: string;
  agentId: string;
  taskId: string;
  
  // 输入
  input: {
    task: string;
    context: BlackboardRef[];
    systemPrompt: string;
  };
  
  // 输出
  output: {
    status: 'success' | 'failure' | 'cancelled';
    artifacts: Artifact[];
    outputRef: BlackboardRef;
  };
  
  // 执行细节
  steps: ExecutionStep[];
  
  // 性能指标
  metrics: {
    startTime: number;
    endTime: number;
    duration: number;
    tokenUsage: TokenUsage;
    llmCalls: number;
    toolCalls: number;
  };
}

interface ExecutionStep {
  stepId: string;
  type: 'llm_call' | 'tool_call' | 'blackboard_read' | 'blackboard_write' | 'error';
  timestamp: number;
  duration: number;
  input: unknown;
  output: unknown;
}
```

### 12.3 实时状态流

前端通过 WebSocket 订阅 Agent 执行状态：

```typescript
// 服务端：流式状态推送
class StatusStreamer {
  async streamExecution(sessionId: string, runId: string): AsyncGenerator<StatusEvent> {
    const subscription = this.blackboard.subscribe(
      { namespace: `workspace/*/run/${runId}/*` },
      (entry) => {
        this.websocket.emit(sessionId, 'blackboard_update', entry);
      }
    );
    
    // 同时监听任务状态变更
    const taskSubscription = this.taskLedger.subscribe(runId, (task) => {
      this.websocket.emit(sessionId, 'task_update', {
        taskId: task.taskId,
        status: task.status,
        progress: task.progress,
        agentId: task.assignedAgent,
      });
    });
    
    try {
      while (this.isRunActive(runId)) {
        await this.waitForNextEvent();
      }
    } finally {
      subscription.unsubscribe();
      taskSubscription.unsubscribe();
    }
  }
}

// 前端：接收并展示
interface StatusEvent {
  type: 'task_update' | 'blackboard_update' | 'agent_message' | 'system_event';
  payload: unknown;
  timestamp: number;
}
```

---

## 13. 数据模型设计

### 13.1 核心实体关系

```
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│   Workspace  │◄──────│   Session    │◄──────│   Message    │
│   工作空间    │   1:N │   会话       │  1:N  │   消息       │
├──────────────┤       ├──────────────┤       ├──────────────┤
│ id           │       │ id           │       │ id           │
│ name         │       │ workspaceId  │       │ sessionId    │
│ gitRepoUrl   │       │ type         │       │ senderType   │
│ createdBy    │       │ title        │       │ content      │
│ agents[]     │       │ status       │       │ type         │
│ harness      │       │ agentId      │       │ artifactRef  │
└──────────────┘       └──────────────┘       └──────────────┘
        │
        │ 1:N
        ▼
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│    Agent     │◄──────│     Run      │◄──────│    Task      │
│   Agent定义   │  1:N  │   执行实例    │  1:N  │   任务       │
├──────────────┤       ├──────────────┤       ├──────────────┤
│ id           │       │ id           │       │ id           │
│ name         │       │ workspaceId  │       │ runId        │
│ avatar       │       │ sessionId    │       │ description  │
│ role         │       │ status       │       │ agentId      │
│ capabilities │       │ startedAt    │       │ status       │
│ runtimeType  │       │ completedAt  │       │ dependencies │
│ systemPrompt │       │ result       │       │ outputRef    │
│ sandbox      │       └──────────────┘       └──────────────┘
└──────────────┘
```

### 13.2 关键表结构（SQLite + Drizzle）

```typescript
// Agent 定义表
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  avatar: text('avatar'),
  role: text('role').notNull(), // 'orchestrator' | 'analyst' | 'architect' | 'engineer' | 'reviewer' | 'custom'
  capabilities: text('capabilities', { mode: 'json' }).$type<string[]>().notNull(),
  runtimeType: text('runtime_type').notNull(), // 'llm' | 'code-agent' | 'native-tool'
  systemPrompt: text('system_prompt'),
  model: text('model'), // LLM 模型名
  codeAgentType: text('code_agent_type'), // 'codex' | 'claude-code' | 'opencode'
  sandbox: text('sandbox').notNull().default('read-only'), // 'read-only' | 'workspace-write' | 'danger-full-access'
  isBuiltIn: integer('is_built_in', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

// 执行实例表
export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  sessionId: text('session_id').notNull(),
  triggerMessageId: text('trigger_message_id').notNull(),
  status: text('status').notNull().default('running'), // 'running' | 'completed' | 'failed' | 'cancelled'
  plan: text('plan', { mode: 'json' }).$type<CoarsePlan>(),
  taskLedger: text('task_ledger', { mode: 'json' }).$type<TaskLedger>(),
  resultRef: text('result_ref'), // 黑板引用
  startedAt: integer('started_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
});

// 任务表
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  phaseId: text('phase_id').notNull(),
  description: text('description').notNull(),
  assignedAgent: text('assigned_agent').notNull(),
  dependencies: text('dependencies', { mode: 'json' }).$type<string[]>().notNull().default([]),
  inputRefs: text('input_refs', { mode: 'json' }).$type<BlackboardRef[]>(),
  outputKey: text('output_key'),
  status: text('status').notNull().default('pending'),
  retryCount: integer('retry_count').notNull().default(0),
  maxRetries: integer('max_retries').notNull().default(3),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
});

// 黑板条目表
export const blackboardEntries = sqliteTable('blackboard_entries', {
  id: text('id').primaryKey(),
  namespace: text('namespace').notNull(),
  key: text('key').notNull(),
  value: text('value', { mode: 'json' }).notNull(),
  schema: text('schema').notNull(), // Zod Schema 标识
  agentId: text('agent_id').notNull(),
  taskId: text('task_id'),
  version: integer('version').notNull(),
  timestamp: integer('timestamp', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  tags: text('tags', { mode: 'json' }).$type<string[]>(),
}, (table) => ({
  nsKeyIdx: index('bb_ns_key_idx').on(table.namespace, table.key),
  versionIdx: index('bb_version_idx').on(table.namespace, table.key, table.version),
}));

// 执行追踪表
export const executionTraces = sqliteTable('execution_traces', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  sessionId: text('session_id').notNull(),
  agentId: text('agent_id').notNull(),
  taskId: text('task_id').notNull(),
  input: text('input', { mode: 'json' }),
  output: text('output', { mode: 'json' }),
  steps: text('steps', { mode: 'json' }).$type<ExecutionStep[]>(),
  metrics: text('metrics', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});
```

---

## 14. 部署与运行架构

### 14.1 开发环境

```bash
# 单命令启动全部服务
bun run dev

# 服务拓扑
┌─────────────────────────────────────────────────────────────┐
│                        开发环境                              │
│  ┌─────────────┐         ┌───────────────────────────────┐  │
│  │  Vite Dev   │◄────────│      Bun Server (:8000)       │  │
│  │  (:5173)    │  HMR    │  • Hono REST API              │  │
│  └─────────────┘         │  • WebSocket Server           │  │
│                          │  • Agent Runtime Workers      │  │
│                          │  • SQLite (WAL mode)          │  │
│                          └───────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 14.2 生产部署建议

```
┌─────────────────────────────────────────────────────────────────┐
│                         生产部署架构                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐         ┌─────────────────────────────────┐   │
│  │   Nginx     │◄───────▶│         Bun Server Cluster      │   │
│  │  (LB/SSL)   │         │  ┌─────────┐ ┌─────────┐        │   │
│  └─────────────┘         │  │ Worker 1│ │ Worker 2│ ...    │   │
│         │                │  │ (:8000) │ │ (:8001) │        │   │
│         │ WebSocket      │  └─────────┘ └─────────┘        │   │
│         ▼                │       Shared SQLite (WAL)       │   │
│  ┌─────────────┐         └─────────────────────────────────┘   │
│  │  PostgreSQL │                                               │
│  │  (可选升级)  │                                               │
│  └─────────────┘                                               │
│                                                                 │
│  外部依赖：                                                      │
│  • LLM API (火山方舟 / OpenAI / Anthropic)                      │
│  • Code Agent CLI (Codex / Claude Code / OpenCode) - 本地安装    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 15. 实施路线图

### 15.1 第一阶段：核心骨架（第 1-5 天）

| 模块 | 任务 | 优先级 |
|------|------|--------|
| **数据层** | Drizzle Schema 定义 + 迁移 | P0 |
| **黑板系统** | SQLite 实现 + Zod 校验 + 订阅机制 | P0 |
| **Runtime 层** | LLM Runtime + Code Agent Runtime 基础实现 | P0 |
| **Orchestrator** | 粗粒度规划 + DAG 拓扑排序 + 基础调度 | P0 |
| **IM 基础** | 消息 CRUD + WebSocket 实时推送 | P0 |
| **前端骨架** | 聊天列表 + 消息流 + 基础样式 | P0 |

### 15.2 第二阶段：协作能力（第 6-10 天）

| 模块 | 任务 | 优先级 |
|------|------|--------|
| **Orchestrator 进阶** | 细粒度调度 + 动态重规划 + Synthesizer | P0 |
| **并发控制** | 信号量 + Token Bucket + 超时管理 | P0 |
| **冲突解决** | Git 分支隔离 + 冲突检测 + LLM 语义合并 | P0 |
| **产物系统** | Diff 卡片 + 网页预览 + 版本历史 | P0 |
| **Harness 系统** | Spec/Skill/Rules 加载 + 系统提示构建 | P1 |
| **错误处理** | 重试 + 熔断 + 降级策略 | P1 |

### 15.3 第三阶段：打磨与交付（第 11-15 天）

| 模块 | 任务 | 优先级 |
|------|------|--------|
| **前端完善** | 产物卡片交互 + 部署状态 + 移动端适配 | P1 |
| **可观测性** | 执行追踪 + 状态流 + 日志 | P1 |
| **多 Agent 接入** | Codex + Claude Code + OpenCode 全部跑通 | P0 |
| **用户自建 Agent** | UI 创建 + 动态注册 + 能力标签 | P1 |
| **测试** | 冒烟测试 + 核心流程 E2E 测试 | P0 |
| **文档** | 产品设计文档 + 技术文档 + Demo 视频 | P0 |

---

## 16. 风险评估与应对

| 风险 | 影响 | 概率 | 应对策略 |
|------|------|------|----------|
| LLM API 限流/不稳定 | 高 | 中 | 熔断器 + 多供应商降级 + Token Bucket 限流 |
| Code Agent CLI 兼容性 | 高 | 中 | Hook 机制抽象 + 适配器模式 + 本地探测 |
| Git 冲突频繁导致体验差 | 中 | 高 | Orchestrator 智能分配避免文件重叠 + 语义合并 |
| 产物质量不稳定 | 高 | 中 | Harness 规范约束 + Synthesizer 质量把关 + 用户确认 |
| 上下文过长导致 LLM 性能下降 | 中 | 高 | 渐进式压缩 + 黑板引用替代全量注入 + Token 预算管理 |
| 时间不足无法完成全部功能 | 高 | 中 | 严格按 P0/P1 优先级实施，P2 功能果断舍弃 |

---

## 17. 总结

AgentHub 的新架构围绕 **"动态 Orchestrator + 统一 Runtime + 黑板共享状态"** 三大支柱构建，相比现有方案在以下方面有根本性改进：

1. **Orchestrator 从静态 DAG 执行器升级为动态任务账本**，支持执行中重规划、Agent 替换、自适应调度，大幅提升了复杂任务的完成率。

2. **Agent 间通信从字符串拼接升级为黑板共享状态**，消除了语义漂移，支持增量更新和版本追溯，使多 Agent 协作从 "黑盒" 变为 "白盒"。

3. **Harness 系统将协作规范（Spec/Skill/Rules）编码为可执行配置**，使 Agent 的行为从 "即兴发挥" 变为 "按规范执行"。

4. **三层冲突处理 + 熔断器 + 指数退避** 构建了完整的容错体系，使系统在面对 Agent 失败时能够优雅降级而非级联崩溃。

5. **产物即消息的设计** 使 Agent 的所有产出自然融入 IM 聊天流，用户可以在熟悉的聊天界面中预览、编辑、部署产物。

这套架构的核心目标是：**让多 Agent 协作像群聊一样自然，同时保证产物的质量和一致性**。在 6 月 10 日的截止日期前，建议严格按三阶段路线图实施，优先保证核心协作流程（Orchestrator 调度 + Code Agent 集成 + 产物预览）跑通，再逐步完善边缘功能。
