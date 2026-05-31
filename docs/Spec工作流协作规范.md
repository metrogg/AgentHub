# Spec 工作流协作规范

> 本文档沉淀 AgentHub 中 Spec（`.spec.yml` 工作流定义）的设计定义、文件格式、匹配机制、与 Planner 的集成方式以及协作约定。

## 1. 架构定位

Spec 是 `.agenthub/` 三层配置体系中的一层，与 Skills 和 Rules 并列：

```
.agenthub/
  skills/     ← 定义 Agent "怎么做"（系统提示模板）
  rules/      ← 定义 Agent "不能做什么"（约束/禁止项）
  specs/      ← 定义多 Agent "怎么协作"（阶段 DAG + 输出契约）
```

Spec 的核心作用：**为 Planner 提供预定义的协作骨架**，让 LLM 生成的执行计划有结构化的阶段参考，而不是从零推理。

## 2. 文件格式

文件名：`{id}.spec.yml`，顶层键为 `spec:`。

### 2.1 完整 Schema

```yaml
spec:
  id: code-review                    # 唯一标识，与文件名（去 .spec.yml）一致
  name: 代码审查                      # 显示名称
  description: 对现有代码进行多维度审查的协作流程
  version: 1.0.0

  triggers:                          # 触发模式列表（正则或纯文本）
    - pattern: "(审查|review|检查).*?(代码|code|实现)"
    - pattern: "code review|cr|review my code"

  phases:                            # 协作阶段（DAG 有序）
    - name: static_analysis          # 阶段标识
      description: 静态分析代码结构、命名规范、潜在bug
      requiredAgents: [reviewer]     # 推荐的 Agent 能力标签
      expectedArtifacts:             # 预期产出物
        - type: review_report
          schema: ReviewReportSchema

    - name: security_check
      description: 安全检查
      requiredAgents: [security_engineer]
      dependsOn: [static_analysis]   # 依赖的前置阶段
      expectedArtifacts:
        - type: review_report
          schema: ReviewReportSchema

  synthesis:                         # 汇总策略
    mode: final                      # final = 全部完成后汇总 | phased = 每阶段汇总
    aggregatorPrompt: |              # 汇总提示词
      请汇总各审查维度的发现，按严重级别排序，给出可执行的修复建议。
```

### 2.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 唯一标识，与文件名一致 |
| `name` | string | ✅ | 显示名称 |
| `description` | string | ✅ | 工作流描述 |
| `version` | string | ❌ | 版本号，默认 `1.0.0` |
| `triggers` | string[] | ❌ | 触发正则列表，用于 `findBestSpec()` 匹配 |
| `phases` | Phase[] | ✅ | 协作阶段列表 |
| `phases[].name` | string | ✅ | 阶段标识 |
| `phases[].description` | string | ✅ | 阶段描述 |
| `phases[].requiredAgents` | string[] | ❌ | 推荐的 Agent 能力标签 |
| `phases[].dependsOn` | string[] | ❌ | 依赖的前置阶段 name 列表 |
| `phases[].expectedArtifacts` | Artifact[] | ❌ | 预期产出物（type + schema） |
| `synthesis.mode` | string | ❌ | `final` 或 `phased` |
| `synthesis.aggregatorPrompt` | string | ❌ | 汇总阶段的提示词 |

## 3. 匹配机制

### 3.1 HarnessManager.findBestSpec()

Planner 调用 `harnessManager.findBestSpec(goal)` 匹配 Spec：

```typescript
findBestSpec(goal: string): HarnessSpec | undefined {
  for (const spec of this.specs.values()) {
    for (const trigger of spec.triggers) {
      // 1. 尝试正则匹配（大小写不敏感）
      const regex = new RegExp(trigger, 'i')
      if (regex.test(goal)) return spec
      // 2. 正则失败则回退到简单包含
      if (goal.includes(trigger.toLowerCase())) return spec
    }
  }
  return undefined
}
```

匹配逻辑：遍历所有 Spec 的 `triggers`，对用户目标做正则/包含匹配，**首次命中即返回**。

### 3.2 匹配优先级

当前实现为首次命中即返回，不做评分排序。多个 Spec 的优先级由加载顺序（文件名字母序）决定。

> **设计取舍**：Spec 触发词通常是明确的场景标识（如"审查"、"构建"），冲突概率低。若未来需要更智能的匹配，可引入与 SKILL.md 类似的评分机制。

## 4. 与 Planner 的集成

### 4.1 执行链路

```
用户发送复杂任务
  ↓
OrchestratorEngine.dispatch()
  ↓
Planner.createPlan(input)
  ↓
┌─────────────────────────────────────────────────────┐
│ 1. Spec 匹配                                         │
│    harnessManager.loadFromWorkspace(workspacePath)    │
│    harnessManager.findBestSpec(goal)                  │
│    → 若命中，formatSpecPhases(spec) 生成结构化阶段文本   │
│                                                        │
│ 2. Spec-first 架构规格生成（useSpecFirst=true 时）      │
│    generateSpec(goal, agents) → ProjectSpec            │
│    → LLM 输出模块划分、数据流、技术栈、文件结构            │
│                                                        │
│ 3. LLM 生成执行计划                                     │
│    generateWithLlm(goal, agents, spec, specPhases)     │
│    → 将 Spec 阶段和架构规格注入 system prompt            │
│    → LLM 输出 ExecutionPlan JSON                       │
│                                                        │
│ 4. 规范化                                              │
│    normalizeGeneratedPlan(runId, goal, generated)      │
│    → 生成任务 UUID、替换依赖 ID、提取 phases              │
└─────────────────────────────────────────────────────┘
  ↓
返回 ExecutionPlan → TaskScheduler 执行
```

### 4.2 Spec 注入方式

`formatSpecPhases()` 将 Spec 转为文本注入 Planner 的 system prompt：

```
【协作规范：代码审查】
对现有代码进行多维度审查的协作流程

请按以下阶段组织任务（每个阶段可映射为 1 个或多个 task）：
1. static_analysis：静态分析代码结构、命名规范、潜在bug
2. security_check：安全检查：注入、XSS、路径遍历、密钥泄露 （依赖：static_analysis）
3. test_gap_analysis：检查测试覆盖率和边界条件 （依赖：static_analysis）
【规范结束】
```

### 4.3 Spec-first 架构规格

当 `useSpecFirst=true`（默认）时，Planner 先调用 `generateSpec()` 让 LLM 输出一个 `ProjectSpec`：

```json
{
  "goal": "实现用户注册登录系统",
  "modules": [
    {
      "name": "auth-service",
      "responsibility": "处理注册、登录、Token 签发",
      "interfaces": ["register()", "login()", "verifyToken()"],
      "dependsOn": ["user-model"]
    }
  ],
  "dataFlow": "前端 → auth API → auth-service → user-model → SQLite",
  "techStack": "Hono + Drizzle + JWT",
  "fileLayout": ["src/routes/auth.ts", "src/services/auth.ts"]
}
```

该 Spec 再注入到 `generateWithLlm()` 的 prompt 中，引导 LLM 生成更精准的 ExecutionPlan。

### 4.4 ExecutionPlan 输出结构

Planner 最终输出的 `ExecutionPlan` 结构：

```typescript
interface ExecutionPlan {
  runId: string
  title: string
  goal: string
  collaborationMode: 'pipeline' | 'mapreduce' | 'supervisor'
  phases?: OrchestratorPhase[]
  agents: ExecutionAgent[]
  tasks: ExecutionTask[]
  agentRelations?: AgentRelation[]
  clarificationQuestions?: ClarificationQuestion[]
}

interface ExecutionTask {
  id: string              // UUID
  phaseId?: string        // 所属阶段
  title: string
  description: string
  agentId: string         // 分配的 Agent UUID
  taskType: 'read' | 'research' | 'design' | 'code' | 'test' | 'review' | 'synthesize'
  dependencies: string[]  // 依赖的任务 UUID 列表
  parallelGroup?: string  // 同组可并行执行
  maxRetries: number      // 最大重试次数（默认 2，上限 5）
  outputContract?: TaskOutputContract
  validation?: TaskValidation
}
```

## 5. 内置 Specs

### 5.1 代码审查（code-review）

```
触发词：审查/检查 + 代码/code | code review | cr

阶段 DAG：
  static_analysis ──┬──→ security_check
                    └──→ test_gap_analysis

产出：review_report
汇总模式：final（全部完成后汇总）
```

### 5.2 Web 应用构建（web-app-building）

```
触发词：构建/创建/写 + 网站/应用/web/app | build + website/app

阶段 DAG：
  requirement_analysis → architecture_design → implementation ──→ review
                                                 ↑                    │
                                           (frontend, backend)   (reviewer, qa)

产出：spec → design_doc → code_diff → review_report
汇总模式：phased（每阶段汇总）
```

## 6. Spec 与 Skills/Rules 的协作

三者通过 Planner 的 prompt 组装形成完整协作链：

```
Planner system prompt 组成：

1. Orchestrator 角色指令
2. ★ Spec 阶段骨架（来自 findBestSpec）
3. ★ Spec-first 架构规格（来自 generateSpec）
4. Agent 团队目录（capabilityTags、runtimeType 等）
5. LLM 输出 JSON Schema 约束

任务执行时：

6. Agent 的 capabilityTags → 匹配 Skill
7. Skill 模板 → 引用 {{RULES.xxx}} → 注入 Rule
8. 组装后的系统提示 → 发送给 Agent 运行时
```

间接关联路径：

```
Spec.phases[].requiredAgents: [reviewer]
  → Planner 尝试匹配 capabilityTags 含 "review" 的 Agent
    → Agent 执行时，capabilityTags 触发 Skill 匹配
      → reviewer.skill.yml 命中
        → Skill 模板引用 {{RULES.code-quality}} → Rule 注入
```

## 7. 开发指南

### 7.1 创建新 Spec

1. 在 `.agenthub/specs/` 下创建 `{id}.spec.yml`
2. 定义 `triggers`：覆盖用户可能的表达方式（中英文、缩写）
3. 设计 `phases` DAG：明确阶段间依赖关系
4. 为每个阶段指定 `requiredAgents`：使用能力标签而非具体 Agent 名
5. 定义 `expectedArtifacts`：让产出可追踪
6. 选择 `synthesis.mode`：`final` 适合一次性交付，`phased` 适合渐进审查

```yaml
spec:
  id: api-development
  name: API 开发
  description: 从需求到实现的完整 API 开发流程
  version: 1.0.0

  triggers:
    - pattern: "(开发|实现|写).*?(API|接口|服务)"
    - pattern: "(build|implement|create).*?(api|endpoint|service)"

  phases:
    - name: api_design
      description: 设计 API 接口规范，定义请求/响应格式
      requiredAgents: [architect, backend]
      expectedArtifacts:
        - type: api_spec
          schema: OpenAPISchema

    - name: implementation
      description: 实现 API 路由、业务逻辑、数据校验
      requiredAgents: [backend]
      dependsOn: [api_design]
      expectedArtifacts:
        - type: code_diff
          schema: CodeDiffSchema

    - name: testing
      description: 编写单元测试和集成测试
      requiredAgents: [qa, backend]
      dependsOn: [implementation]
      expectedArtifacts:
        - type: test_result
          schema: TestResultSchema

  synthesis:
    mode: final
    aggregatorPrompt: |
      汇总 API 设计文档、实现代码和测试结果，
      确保接口一致性，输出完整的交付清单。
```

### 7.2 Spec 设计原则

| 原则 | 说明 |
|------|------|
| **粗粒度阶段** | 每个阶段对应一个协作里程碑，不要拆得太细（Planner 会进一步拆 task） |
| **能力标签而非人名** | `requiredAgents: [backend]` 而非 `requiredAgents: [zhang-san]`，让 Planner 灵活分配 |
| **明确依赖** | `dependsOn` 帮助 Planner 构建正确的 DAG，避免隐式顺序假设 |
| **产出可追踪** | `expectedArtifacts` 让汇总阶段知道要收集什么 |
| **触发词覆盖** | 中英文、全称、缩写都要覆盖，提升命中率 |

## 8. 当前局限与演进方向

| 维度 | 当前状态 | 演进方向 |
|------|---------|---------|
| Spec 匹配 | 首次正则命中即返回 | 评分排序，支持权重/优先级 |
| Phase-Agent 映射 | `requiredAgents` 仅作为 Planner 参考 | 直接约束 Planner 的 Agent 分配 |
| 产出物校验 | `expectedArtifacts` 仅作描述，不校验 | Task 完成后校验产出物类型 |
| Spec 可视化 | 无 | 前端 Spec 编辑器 + DAG 预览 |
| Spec 版本管理 | 文件级版本号 | 支持升级、回滚、冲突检测 |
| 多 Spec 组合 | 单次只匹配一个 Spec | 支持 Spec 嵌套/组合（如"构建" = 设计 Spec + 实现 Spec） |
| 自定义 Spec | 需手动编辑 YAML | 前端可视化 Spec 创建向导 |
| Spec 模板库 | 仅 2 个内置 Spec | 社区共享的 Spec 模板市场 |
| Spec 与 Synthesizer 联动 | `synthesis.aggregatorPrompt` 仅作参考 | Synthesizer 根据 Spec 阶段产出物结构化汇总 |
