# 专家库与开源角色 / Skill / MCP 生态调研

最后更新：2026-06-01

这份文档回答：AgentHub 是否应该预装一批覆盖多场景的 Agent 配置模板？答案是应该，但当前只做小体量核心模板，并且必须把“可复用 Agent 配置资产”和“固定执行模板”区分开。

这里的“专家”本质上就是 Agent：专家配置就是 Agent 配置的产品化呈现，不能另起一套和 `workspace_agents` 平行的身份系统。近期不要做“我的专家”或完整专家市场，只在 Agent 配置页提供少量预装模板；专家团也只作为后续群聊创建/补员推荐资产，不是新的 runtime，也不是固定执行模板。

## 关键判断

1. 可以借鉴开源 subagent / prompt / skill / MCP 资产，没必要全手写。
2. 不能直接复制粘贴到执行链路，需要做许可证、质量、安全和本项目架构适配。
3. 专家就是 Agent profile，应由四部分构成：
   - 角色提示词模板
   - 默认 Skill 包
   - 推荐 MCP 能力
   - 权限 / 沙箱 / 输出契约
4. 专家团应由“角色组合 + 推荐拓扑 + 产物链 + 审批点”构成，不能是固定任务流程。
5. 当前产品体量小，优先暴露 8-10 个核心预装模板；更多行业专家先作为候选资产沉淀，不进入主 UI。
6. 用户可以从 Agent 配置页选择模板，也可以让 Orchestrator 根据群聊目标推荐补员；推荐补员默认需要用户确认。

## 可借鉴来源

### Claude Code 官方 subagents

官方设计重点：

- 每个 subagent 有 frontmatter metadata。
- body 是该 subagent 的 system prompt。
- subagent 有独立上下文。
- 可配置工具权限。
- 可预加载 skills。
- 可配置 persistent memory。

对 AgentHub 的启发：

- 我们的 Agent profile 应该至少包含 `description / tools / skills / memory / permission / prompt` 这些概念。
- 专家 prompt 不能只写“你是专家”，必须说明何时触发、能用哪些工具、输出什么。
- 预装 skill 是正式能力，不是附属文本。

参考：https://code.claude.com/docs/en/sub-agents

### VoltAgent awesome-claude-code-subagents

这个仓库提供 154+ Claude Code subagents，覆盖：

- Core Development
- Language Specialists
- Infrastructure & DevOps
- Testing & Quality
- Data & AI
- Developer Experience
- Specialized Domains
- Business & Product
- Meta Orchestration
- Research & Analysis

对 AgentHub 的启发：

- 我们不应该只放 5 个默认角色。
- 后续模板库可以按行业 / 能力分类。
- Core Development、Business/Product、Research、Testing、Meta Orchestration 这几类最适合先借鉴。
- 该仓库也明确提示社区 subagent 未必经过审计，不能直接信任。

参考：https://github.com/VoltAgent/awesome-claude-code-subagents

### BMAD Method

BMAD 的价值不是 prompt 本身，而是它把产品开发拆成一组明确角色和 workflow：

- Analyst
- Product Manager
- Architect
- Developer
- UX Designer
- Technical Writer

对 AgentHub 的启发：

- 产品、需求、架构、开发、文档角色都应进入专家库。
- 角色应该绑定 workflow / skill，而不只是角色名。
- AgentHub 可以学习其“角色 + 技能菜单 + 主要工作流”形式。

参考：https://docs.bmad-method.org/reference/agents/

### SuperClaude

SuperClaude 的启发是“命令 + persona + MCP + 模式”组合：

- 开发命令覆盖 build / test / review / deploy / design。
- personas 包含 architect、frontend、backend、security、QA 等。
- MCP 能力作为增强工具。

对 AgentHub 的启发：

- 专家不是孤立 prompt，而是要绑定常用工作流。
- 同一个专家可以在不同任务中切换工作模式。
- MCP 推荐要跟角色匹配，例如安全专家和 QA 专家不应该默认拿写权限。

参考：https://github.com/SuperClaude-Org/SuperClaude_Framework

### awesome-cursor-skills

这个列表更像“可复用工作流技能”，包括：

- responsive-testing
- accessibility-auditing
- parallel-code-review
- visual-qa-testing
- recording-browser-flow-as-test
- auto-type-checking
- saving-workspace-context
- suggesting-skills

对 AgentHub 的启发：

- 我们应该预装“任务方法论 skill”，而不是只预装角色。
- 很多能力适合做 Skill，而不是 Agent。
- 比如响应式测试、浏览器验证、代码审查、多 Agent 并行探索，都可以作为专家默认 skill。

参考：https://github.com/spencerpauly/awesome-cursor-skills

### 官方 MCP servers

官方 MCP servers 提供了基础工具型能力，例如：

- filesystem
- git
- memory
- github
- postgres

对 AgentHub 的启发：

- MCP 是工具层，不是 Agent 类型。
- 文件、Git、Memory、GitHub 这类适合作为基础 MCP 能力。
- MCP server 必须按权限、凭据、网络和沙箱隔离管理。

参考：https://github.com/modelcontextprotocol/servers

### awesome MCP servers

awesome MCP 目录覆盖浏览器自动化、数据库、云服务、开发工具、设计工具、知识库等大量 server。

对 AgentHub 的启发：

- 可以做 MCP 推荐 / 连接器配置。
- 先接稳定、低风险、开发强相关的 MCP。
- 对第三方 MCP 必须做信任分级，不应默认启用。

参考：

- https://github.com/TensorBlock/awesome-mcp-servers
- https://github.com/wong2/awesome-mcp-servers

## 专家就是 Agent

不要把专家做成 Agent 之外的新实体。推荐统一命名：

```text
Agent Profile = Expert Profile
Agent Team Profile = Expert Team Profile
```

现有 `workspace_agents` 已经包含核心字段：

- `name`
- `role`
- `roleType`
- `description`
- `avatar`
- `systemPrompt`
- `roleProfile`
- `runtimeType`
- `codeAgentType`
- `modelId`
- `capabilityTags`
- `skillIds`
- `toolPermissions`
- `sandboxPolicy`
- `contextPolicy`
- `autoInvoke`
- `approvalRequired`

后续优化应该围绕这些字段做“配置体验升级”和“schema 结构化”，而不是新建一个专家运行时。

## Agent / 专家统一配置模型

建议把 Agent 配置分成 8 个分区：

| 分区 | 说明 |
| --- | --- |
| 身份信息 | 名称、头像、颜色、简介、分类、适合场景 |
| 角色与背景 | role、roleType、背景设定、职责、不负责事项 |
| 执行基底 | code-agent / llm、Codex / Claude Code / OpenCode / Gemini、模型覆盖 |
| Prompt 模板 | systemPrompt、promptTemplateId、输出契约 |
| 能力画像 | capabilityTags、acceptsTaskTypes、produces、qualityGates |
| Skill 工具箱 | skillIds、默认 Skill、可选 Skill、自动匹配策略 |
| MCP 与工具权限 | recommendedMcpServers、enabledMcpServers、toolPermissions |
| 安全与协作 | sandboxPolicy、contextPolicy、autoInvoke、approvalRequired、handoff/review/fallback 关系 |

`roleProfile` 建议逐步结构化为：

```json
{
  "category": "技术工程",
  "expertLevel": "standard | advanced | specialist",
  "background": "角色背景",
  "responsibilities": [],
  "cannotDo": [],
  "requiredInputs": [],
  "outputContract": [],
  "qualityGates": [],
  "defaultSkillIds": [],
  "recommendedMcpServers": [],
  "preferredTopologies": [],
  "examples": []
}
```

这样前端可以把同一个 Agent 用两种方式展示：

- 在左侧/群聊里：它是聊天成员 Agent。
- 在 Agent 配置页里：它是可复用配置模板。

## AgentHub 预装模板设计

远期可以参考 WorkBuddy 的专家团/专家组织方式，但当前体量小，不做“我的专家”和完整专家市场。近期产品形态应收敛为：

```text
Agent 配置
  预装专家模板
    Orchestrator / Team Builder
    产品经理
    研究分析师
    软件架构师
    UI 设计师
    前端工程师
    后端工程师
    QA 验证员
    代码审查员
    技术写作专家
  自定义 Agent
    用户自己创建和维护的 Agent 配置

群聊创建 / 补员推荐（后续）
  轻量专家团建议
    软件交付
    深度研究报告
    产品设计
```

### 专家卡字段

专家卡不应复制一套字段，而应读取 Agent profile / preset profile：

```json
{
  "id": "frontend-engineer",
  "name": "高级前端工程师",
  "category": "技术工程",
  "description": "负责 React / TypeScript / UI 状态 / 浏览器验证",
  "runtimeType": "code-agent",
  "recommendedCodeAgentTypes": ["codex", "claude-code", "opencode"],
  "rolePromptTemplateId": "frontend-engineer-v1",
  "defaultSkillIds": ["project-context", "frontend-engineer", "responsive-testing"],
  "recommendedMcpServers": ["filesystem", "git", "playwright"],
  "sandboxPolicy": "workspace-write",
  "toolPermissions": ["workspace:read", "workspace:write"],
  "outputContract": ["diff_summary", "artifact_ref", "test_result"],
  "riskLevel": "medium"
}
```

### 专家团卡字段

```json
{
  "id": "software-delivery-team",
  "name": "软件开发团队",
  "category": "技术工程",
  "recommendedTopology": "pipeline_with_review_loop",
  "members": [
    "product-manager",
    "software-architect",
    "frontend-engineer",
    "backend-engineer",
    "qa-verifier",
    "code-reviewer"
  ],
  "sharedSkillIds": [
    "collaboration-protocol",
    "artifact-handoff",
    "status-reporting",
    "safety-boundary"
  ],
  "recommendedMcpServers": ["filesystem", "git", "github", "playwright"],
  "description": "适合从需求到开发、验证、交付的完整软件任务。"
}
```

## MVP 预装模板

首批不要铺太大，前端只暴露 10 个核心模板，覆盖比赛 demo 和真实使用的主路径。其余行业/法务/DevOps/MCP 工程等先作为候选资产保留，等核心多 Agent 执行和补员推荐稳定后再逐步放出。

| 分类 | 专家 | 默认 Skills | 推荐 MCP |
| --- | --- | --- | --- |
| 协调 | Orchestrator / Team Builder | collaboration-protocol, agent-selection, dag-planning, status-reporting | memory |
| 产品 | Product Manager | requirements-clarification, acceptance-criteria, user-story-mapping | memory, github |
| 研究 | Research Analyst | research-method, source-evaluation, fact-check | fetch/search, memory |
| 设计 | UX / UI Designer | ux-flow, visual-direction, accessibility-check | playwright, filesystem |
| 技术 | Software Architect | codebase-navigation, interface-design, risk-modeling | filesystem, git |
| 技术 | Frontend Engineer | project-context, frontend-engineer, responsive-testing | filesystem, git, playwright |
| 技术 | Backend Engineer | project-context, backend-engineer, api-contract | filesystem, git, postgres |
| 质量 | QA Verifier | verification-contract, test-runner, visual-qa-testing | playwright, git |
| 质量 | Code Reviewer | review, security-review, performance-review | git, github |
| 内容 | Technical Writer | writing-shape, edit-article, document-formatting | filesystem |

注意：

- `fetch/search` 可以先抽象成能力，具体 MCP 可根据用户配置选择。
- 第三方 MCP 默认不开启，只作为推荐。
- 高风险专家默认 read-only 或 approvalRequired。

## MVP 轻量专家团建议

专家团只是“推荐组合”，不是 Planner 的静态模板。近期只保留 3 个建议，且必须由用户在群聊创建或补员时确认。

### 软件交付

成员：

- Product Manager
- Software Architect
- Frontend Engineer
- Backend Engineer
- QA Verifier
- Code Reviewer

拓扑：

- pipeline + review loop

适合：

- 网站、应用、接口、Bug 修复、重构。

### 深度研究报告

成员：

- Research Analyst
- Fact Checker
- Data Analyst
- Technical Writer
- Reviewer

拓扑：

- parallel research + synthesis

适合：

- 行业调研、技术选型、竞品分析、PDF 报告。

### 产品设计团队

成员：

- Product Manager
- UX Researcher
- UI Designer
- UX Writer
- Frontend Prototype Engineer

拓扑：

- discovery -> design variants -> prototype -> review

适合：

- 页面设计、交互设计、原型、设计改版。


## Prompt 设计原则

借鉴这些开源项目时，应该提炼结构，而不是照抄内容：

1. frontmatter / metadata 描述触发场景、工具、技能、权限。
2. prompt body 描述角色职责、边界、工作流和输出格式。
3. skill 提供方法论和脚本资源。
4. MCP 提供外部工具和数据。
5. memory 保存长期经验，但必须分 scope。
6. workflow / topology 交给 Orchestrator，不写死在专家 prompt 里。

建议专家 prompt 统一结构：

```markdown
---
name: frontend-engineer
description: 适合 React/TypeScript/UI 实现和浏览器验证
skills:
  - project-context
  - frontend-engineer
  - responsive-testing
tools:
  - workspace:read
  - workspace:write
sandboxPolicy: workspace-write
---

你是高级前端工程师，负责把明确的产品/设计/接口要求实现为可运行前端。

## 你负责
...

## 你不负责
...

## 工作步骤
...

## 输出契约
...
```

## MCP 选型建议

### 默认可信层

优先考虑官方或成熟项目：

- filesystem：受 allowed paths 限制。
- git：读历史、diff、分支信息。
- memory：保存团队/项目经验。
- github：Issue、PR、Actions、代码评审。
- postgres/sqlite：数据分析时使用，必须只读优先。

### 浏览器与视觉层

适合 UI / QA / 前端专家：

- Playwright MCP / browser automation。
- screenshot / visual diff 类工具。

### 文档与内容层

适合 Writer / Report / Data Analyst：

- filesystem。
- document / markdown / pdf 生成工具。
- fetch/search 类工具。

### 风险控制

MCP 风险比普通 prompt 更高，因为它连接真实系统。需要：

- 安装前展示来源、权限、命令、环境变量。
- 默认禁用网络写操作。
- 凭据按 workspace / agent / task 隔离。
- 第三方 MCP 标记 trustLevel。
- 运行时显示本次调用过的 MCP tools。

## 导入开源专家资产的流程

不要直接复制仓库内容。建议流程：

```text
发现候选资产
  -> 检查许可证
  -> 检查 prompt 质量和安全边界
  -> 抽取角色结构和任务方法
  -> 改写为 AgentHub 专家 schema
  -> 映射默认 skills / MCP / 权限
  -> 小样本任务验证
  -> 标记来源和版本
  -> 加入预装模板候选库
```

### 质量检查清单

- 是否有明确触发场景？
- 是否有明确不能做什么？
- 是否有输出契约？
- 是否绑定了合适工具，而不是靠 prompt 幻想能力？
- 是否会诱导越权、联网、读取敏感文件？
- 是否适合 code-agent 基底？
- 是否能被 Orchestrator 当成能力画像读取？

## 与现有设计的关系

已有文档中“角色参考库”需要进一步升级成“Agent 配置模板库”：

- `ROLE_PRESETS` 保留，但只作为 Agent 创建参考和专家 profile seed。
- `AgentRoleType` 只保留粗粒度角色类型。
- 模板分类放到 `expertProfile.category / domain / defaultSkillIds / recommendedMcpServers`。
- 专家团不进入 Planner 静态模板，只作为创建群聊和 Orchestrator 组队的推荐资产。
- 保存到工作区后，专家就是一条 `workspace_agents` 记录。
- 近期不做“我的专家”入口；已创建 Agent 就是用户当前可用通讯录，群聊成员是 workspace-level Agent instance。

## 近期落地建议

## 当前实现进展

- 已新增共享专家 seed：`packages/shared/src/expert-profiles.ts`。
- 已包含候选 18 个 Agent/专家 profile 和 6 个专家团 profile，但前端当前只暴露 MVP 核心 10 个模板和 3 个轻量团队建议。
- 前端 Agent 配置页已从“角色模板”升级为“预装专家模板”，选择模板会写入同一份 Agent 配置：
  - `systemPrompt`
  - `roleProfile`
  - `skillIds`
  - `toolPermissions`
  - `sandboxPolicy`
  - `contextPolicy`
  - `runtimeType`
  - `codeAgentType`
- `roleProfile` 中已包含 `expertProfileId`、`category`、`background`、`outputContract`、`qualityGates`、`recommendedMcpServers` 等结构化信息。
- 已修复 Agent 配置保存时未保留 `skillIds` 的问题，避免“专属工具箱”选择后丢失。
- 发起群聊弹窗已支持填写“群聊目标”，目标会写入 workspace goal，供后续 Orchestrator 动态规划读取。
- 发起群聊弹窗已提供 3 个轻量组队建议；用户点击后才会显式创建并选中对应 Agent 配置，不会自动触发固定分工。
- 后端 `workspace_agents` 创建/更新 schema 已接入 `skillIds`，避免模板 Skill 在进入工作区时丢失。
- Orchestrator 决策阶段已读取当前成员能力画像、workspace goal 和 MVP 核心模板摘要；如果成员能力不足，应由 Orchestrator 明确建议补员，不能静默拉人或让前端关键词规则代替判断。
- 动态规划阶段已把 workspace goal 与本次用户消息合并成规划目标，避免群聊创建时填写的目标在真正执行时丢失。

### Phase 1：Agent Profile schema

优先不要新增平行专家表，而是先扩展 Agent 配置：

- `workspace_agents.roleProfile` 结构化。
- Agent library 支持同一 schema。
- 预装模板可以先用 JSON seed。
- 专家团可以用 `agent_team_profiles` 或 JSON seed，里面引用 Agent profile ids。

或先用 JSON 文件 / seed 数据起步。

### Phase 2：导入 MVP 核心模板

先做：

- 10 个前端可见预装模板
- 3 个轻量专家团建议
- 8-12 个通用 Skill
- 5 个推荐 MCP 能力

### Phase 3：轻量模板与组队 UI

参考 WorkBuddy，但按当前体量收窄：

- Agent 配置页模板选择
- 群聊创建页的目标输入
- Orchestrator 推荐成员和轻量专家团
- 分类筛选
- 搜索
- 模板详情
- 用户确认后加入群聊

### Phase 4：Orchestrator 使用模板库

当前已经推进：

- 决策阶段输入当前群聊目标。
- 决策阶段输入当前成员能力画像。
- 决策阶段输入 MVP 核心模板摘要。
- 规划阶段把 workspace goal 与本次用户消息合并。

接下来应该继续：

- 将补员建议结构化为可确认卡片，而不只是文本。
- 补员确认后，把模板转换成真实 `workspace_agents`，再重新规划。
- Planner 输入中加入可用 Skill / MCP 摘要，但只能作为能力建议，不得变成 runtimeType。
- Orchestrator 输出继续保持：使用现有成员、建议新增成员、建议加载 Skill、建议启用 MCP。
