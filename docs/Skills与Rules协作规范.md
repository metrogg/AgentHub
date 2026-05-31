# Skills 与 Rules 协作规范

> 本文档沉淀 AgentHub 中 Skills（技能）和 Rules（规则）的设计定义、文件格式、匹配机制、注入流程和协作约定，供开发者和使用者参考。

## 1. 架构定位

Skills 和 Rules 是 Agent 的**能力层（Capability Layer）**，不是独立的运行时类型。

```
┌──────────────────────────────────────────────────┐
│                  产品交互层                        │
│          IM 群聊 / 私聊 / 子会话                    │
├──────────────────────────────────────────────────┤
│                  编排层                            │
│    Orchestrator → Planner → TaskScheduler         │
├──────────────────────────────────────────────────┤
│                  协议层                            │
│           A2A (消息/任务)  AG-UI (运行事件)         │
├──────────────────────────────────────────────────┤
│                  运行时层                          │
│          LLM Runtime  |  Code Agent Runtime       │
│          (Codex / Claude Code / OpenCode / Gemini) │
├──────────────────────────────────────────────────┤
│              ★ 能力层 (本文档范围)                  │
│     Skills  |  Rules  |  MCP  |  Shell  |  Files  │
├──────────────────────────────────────────────────┤
│                  工作区与状态层                     │
│     .agenthub/workdirs  |  handoff  |  blackboard  │
└──────────────────────────────────────────────────┘
```

核心原则：**Skills 定义"怎么做"，Rules 定义"不能做什么"，两者通过模板变量组合注入到 Agent 的系统提示中。**

## 2. 文件目录结构

```
{workspace}/.agenthub/
  skills/                    ← Skill 定义（.skill.yml）
    backend-engineer.skill.yml
    frontend-engineer.skill.yml
    reviewer.skill.yml
  rules/                     ← Rule 定义（.yml）
    code-quality.yml
    frontend-coding.yml
  specs/                     ← Spec 工作流定义（.spec.yml）
    code-review.spec.yml
    web-app-building.spec.yml
```

新建工作区时，`ensureHarnessPresets()` 自动从项目根目录 `.agenthub/` 复制预置的 skills、rules、specs 到新工作区。

## 3. Skill 定义规范

### 3.1 文件格式

文件名：`{id}.skill.yml`，顶层键为 `skill:`。

```yaml
skill:
  id: backend-engineer           # 唯一标识，与文件名一致
  name: 后端工程师                # 显示名称
  description: 使用 Hono + TypeScript + Drizzle ORM 构建后端 API
  version: 1.0.0

  applicableCapabilities:        # 能力标签，用于与 Agent 的 capabilityTags 匹配
    - backend
    - api
    - database
    - server

  applicableTags:                # 扩展标签，增加匹配命中率
    - api
    - backend
    - hono
    - drizzle

  systemPromptTemplate: |        # 系统提示模板，支持变量插值
    {{BASE_PROMPT}}

    ## 技术栈
    - Hono (Web 框架)
    - TypeScript (strict mode)
    - Drizzle ORM (SQLite)
    - Bun (运行时)

    ## 编码规范
    {{RULES.code-quality}}

    ## 当前任务
    {{TASK_DESCRIPTION}}

    ## 输出要求
    1. 生成完整的、可直接运行的代码
    2. 使用 TypeScript 严格类型
    3. 所有 API 输入必须做 Zod 校验
```

### 3.2 模板变量

| 变量 | 替换为 | 示例 |
|------|--------|------|
| `{{BASE_PROMPT}}` | Agent 的基础系统提示（含 name、role、description） | `你是 backend-agent，AgentHub 中的协作智能体。` |
| `{{RULES}}` | 所有适用 Rules 的格式化全文 | `【规范约束】\n### 代码质量规范\n约束：\n- ...\n【规范结束】` |
| `{{RULES.xxx}}` | 指定 Rule ID 的格式化内容（xxx 为 rule 的 id） | `{{RULES.code-quality}}` → code-quality 规则内容 |
| `{{TASK_DESCRIPTION}}` | 当前任务标题和描述 | `任务：实现用户注册 API\n说明：...` |
| `{{WORKSPACE_PATH}}` | 工作区绝对路径 | `/home/user/my-project` |
| `{{AGENT_NAME}}` | Skill 的 name 字段 | `后端工程师` |

### 3.3 匹配逻辑

`HarnessManager.findBestSkill()` 按以下顺序匹配（命中即返回，不继续）：

1. 遍历所有已加载的 Skills
2. 检查 `skill.applicableCapabilities` 是否与 `agent.capabilityTags` 有交集
3. 若无交集，检查 `skill.applicableTags` 是否与 `agent.capabilityTags` 有交集
4. 第一个命中的 Skill 被选中
5. 若无 Skill 命中，回退到"基础提示 + 全部 Rules"模式

> **注意**：当前实现为首次命中即返回，不做评分排序。若多个 Skill 存在重叠标签，以加载顺序（文件名字母序）决定优先级。

### 3.4 内置 Skills

| Skill ID | 名称 | 能力标签 | 引用的 Rule |
|----------|------|---------|------------|
| `backend-engineer` | 后端工程师 | backend, api, database, server | `{{RULES.code-quality}}` |
| `frontend-engineer` | 前端工程师 | frontend, ui, react, web | `{{RULES.frontend-coding}}` |
| `reviewer` | 代码审查者 | review, audit, quality | 无（自带审查维度） |

## 4. Rules 定义规范

### 4.1 文件格式

文件名：`{id}.yml`，顶层键为 `rules:`。

```yaml
rules:
  id: code-quality              # 唯一标识，与文件名一致
  name: 代码质量规范              # 显示名称
  version: 1.0.0

  constraints:                  # 约束条件（必须遵循的编码要求）
    - "所有函数必须有明确的返回类型"
    - "不使用 any，使用 unknown + 类型守卫"
    - "优先使用 const/let，避免 var"
    - "错误处理必须显式，不吞异常"
    - "所有外部输入必须校验（Zod / 手动）"

  naming:                       # 命名规范（实体类型 → 命名风格）
    functions: camelCase
    classes: PascalCase
    interfaces: PascalCase
    types: PascalCase
    enums: PascalCase
    constants: UPPER_SNAKE_CASE
    files: kebab-case

  forbidden:                    # 禁止项（明确不可出现的模式）
    - "console.log 提交到生产代码"
    - "硬编码密钥或配置"
    - "裸奔的 SQL 拼接（使用参数化查询）"
    - "循环中 await（使用 Promise.all）"

  imports:                      # 可选：导入顺序规范
    order:
      - "React 内置"
      - "第三方库"
      - "项目内部模块"
      - "相对路径导入"

  formatting:                   # 可选：格式化偏好
    semicolons: false
    singleQuote: true
    trailingComma: all
```

### 4.2 格式化输出

`HarnessManager.formatSingleRule()` 将 Rule 渲染为以下文本格式：

```
### {name}
约束：
- {constraint_1}
- {constraint_2}
禁止：
- {forbidden_1}
- {forbidden_2}
命名规范：
- {key}: {value}
```

多条 Rule 合并时，用 `【规范约束】` 和 `【规范结束】` 包裹。

### 4.3 匹配逻辑

`HarnessManager.findApplicableRules()` 当前实现为**返回所有已加载的 Rules**，不做过滤。

> **后续扩展方向**：按 Agent 的 `capabilityTags` 或 `role` 过滤，实现"后端 Agent 只加载后端规则"的精准匹配。

### 4.4 内置 Rules

| Rule ID | 名称 | 适用场景 |
|---------|------|---------|
| `code-quality` | 代码质量规范 | 通用后端/全栈编码约束 |
| `frontend-coding` | 前端编码规范 | React + Tailwind 前端约束 |

## 5. Skills 与 Rules 的协作流程

### 5.1 LLM Runtime 路径

适用于 `runtimeType === "llm"` 的 Agent，由 `LlmRuntime.execute()` 驱动。

```
用户消息
  ↓
agent-runner.ts 解析 AgentProfile
  ↓
LlmRuntime.execute()
  ↓
buildAgentSystem()
  ↓
HarnessManager.loadFromWorkspace(workspacePath)
  ├── 扫描 .agenthub/specs/*.spec.yml
  ├── 扫描 .agenthub/skills/*.skill.yml
  └── 扫描 .agenthub/rules/*.yml
  ↓
HarnessManager.buildSystemPrompt({ agent, task, workspacePath })
  ├── findBestSkill(agent, task)     → 用 capabilityTags 匹配 Skill
  ├── findApplicableRules(agent)     → 收集全部 Rules
  ├── [有 Skill] renderSkillTemplate(skill, basePrompt, rules, task)
  │     ├── {{BASE_PROMPT}}          ← Agent 基础提示
  │     ├── {{RULES}}                ← 全部 Rules 格式化文本
  │     ├── {{RULES.xxx}}            ← 指定 Rule 内容
  │     ├── {{TASK_DESCRIPTION}}     ← 当前任务描述
  │     ├── {{WORKSPACE_PATH}}       ← 工作区路径
  │     └── {{AGENT_NAME}}           ← Skill 名称
  └── [无 Skill] 基础提示 + formatRulesSection(全部 Rules)
  ↓
组装后的系统提示 → 发送给 LLM
```

### 5.2 Code Agent Runtime 路径

适用于 `runtimeType === "code-agent"` 的 Agent（Codex / Claude Code / OpenCode / Gemini），由 `CodeAgentRuntime.execute()` 驱动。

```
用户消息
  ↓
agent-runner.ts 解析 AgentProfile
  ↓
CodeAgentRuntime.execute()
  ↓
streamCodeAgentReply()
  ↓
globalSkillRegistry.buildSkillContext(combinedText, capabilityTags)
  ├── selectSkills()  → 评分匹配 SKILL.md 技能（2-5 个）
  └── 格式化为文本块："Active skills loaded for this task: ..."
  ↓
buildCodeAgentPrompt()
  ├── Agent 身份信息
  ├── 工作区路径 + 沙箱策略
  ├── 工具权限
  ├── ★ Skill Context（SKILL.md 内容）
  └── 对话历史
  ↓
组装后的提示 → 通过 CLI Adapter 发送给外部 Code Agent
```

> **重要差异**：Code Agent 路径使用 `SkillRegistry`（SKILL.md 格式的外部技能），**不使用** HarnessManager 的 YAML Skills/Rules。两条路径的 Skill 体系目前是独立的。

### 5.3 两条路径对比

| 维度 | LLM Runtime | Code Agent Runtime |
|------|-------------|-------------------|
| 加载器 | `HarnessManager` | `SkillRegistry` |
| Skill 格式 | `.skill.yml`（YAML 模板） | `SKILL.md`（Markdown + frontmatter） |
| Rule 注入 | ✅ 通过模板变量注入 | ❌ 当前未注入 |
| 匹配方式 | `capabilityTags` 交集 | 文本评分（名称/描述/token 重叠） |
| 来源 | 工作区 `.agenthub/skills/` | SkillHub / GitHub / npx |
| 变量插值 | ✅ 支持全部模板变量 | ❌ 不支持（原样注入） |

## 6. SKILL.md 外部技能体系

除 Harness YAML Skills 外，AgentHub 还支持通过 `SkillRegistry` 管理的 SKILL.md 格式外部技能。

### 6.1 发现路径

`SkillRegistry` 扫描以下目录：

| 目录 | 说明 |
|------|------|
| `{project}/.codex/skills/` | Codex 兼容技能目录 |
| `{project}/.agents/skills/` | 通用 Agent 技能目录 |
| `{project}/.claude/skills/` | Claude 兼容技能目录 |
| `{project}/storage/skills/` | 项目存储目录 |
| `{HOME}/.codex/skills/` | 用户级 Codex 技能 |
| `{HOME}/.agents/skills/` | 用户级通用技能 |
| `{HOME}/.claude/skills/` | 用户级 Claude 技能 |

每个技能为一个目录，内含 `SKILL.md` 文件。

### 6.2 安装方式

| 方式 | 命令 / 操作 |
|------|------------|
| SkillHub 市场 | 前端 Skills 市场页面一键安装 |
| GitHub URL | POST `/api/skills/install` body: `{ url: "https://github.com/..." }` |
| npx 命令 | POST `/api/skills/install` body: `{ command: "npx skills@latest add owner/repo" }` |

### 6.3 评分匹配

`SkillRegistry.selectSkills()` 对每个 SKILL.md 技能打分：

| 匹配条件 | 分值 |
|---------|------|
| 文本中显式引用 `$skillname` | +10 |
| 文本中引用 `@skill:name` | +8 |
| 文本包含 skill 的 name 或 id | +5 |
| token 重叠（name/description 与输入文本） | +1-3 |

取 top 2-5 个最高分技能返回。

### 6.4 运行时工具

LLM Runtime 的 Agent 可通过以下工具动态访问外部技能：

| 工具名 | 权限范围 | 功能 |
|--------|---------|------|
| `list_skills` | `skills:read` | 列出所有已安装的 SKILL.md 技能 |
| `read_skill` | `skills:read` | 按名称或 ID 读取指定技能的完整内容 |

## 7. Spec 与 Skills/Rules 的关系

Spec（`.spec.yml`）定义多 Agent 协作的工作流，其中 `requiredAgents` 字段引用 Agent 的 capability 标签。Spec 本身不直接引用 Skill 或 Rule，但通过以下间接链路关联：

```
Spec.requiredAgents: [reviewer]
  → Orchestrator 匹配 capabilityTags 含 "review" 的 Agent
    → Agent 的 capabilityTags 触发 Skill 匹配
      → reviewer.skill.yml 的 applicableCapabilities 含 "review" → 命中
        → Skill 模板引用 {{RULES.code-quality}} → Rule 注入
```

## 8. 开发指南

### 8.1 创建新 Skill

1. 在 `.agenthub/skills/` 下创建 `{id}.skill.yml`
2. 填写 `skill.id`（与文件名一致）、`name`、`description`、`version`
3. 定义 `applicableCapabilities` 和 `applicableTags`，确保能与目标 Agent 的 `capabilityTags` 匹配
4. 编写 `systemPromptTemplate`，合理使用模板变量
5. 若需引用特定 Rule，使用 `{{RULES.{rule-id}}}` 语法

```yaml
skill:
  id: security-engineer
  name: 安全工程师
  description: 执行安全审查与漏洞分析
  version: 1.0.0
  applicableCapabilities: [security, audit]
  applicableTags: [security, vulnerability, owasp]

  systemPromptTemplate: |
    {{BASE_PROMPT}}

    ## 安全审查维度
    - OWASP Top 10 检查
    - 输入校验完整性
    - 认证与授权逻辑
    - 密钥和敏感信息泄露

    ## 编码规范
    {{RULES.code-quality}}

    ## 当前任务
    {{TASK_DESCRIPTION}}
```

### 8.2 创建新 Rule

1. 在 `.agenthub/rules/` 下创建 `{id}.yml`
2. 填写 `rules.id`（与文件名一致）、`name`、`version`
3. 按需定义 `constraints`、`naming`、`forbidden`、`imports`、`formatting`

```yaml
rules:
  id: api-design
  name: API 设计规范
  version: 1.0.0

  constraints:
    - "RESTful 资源命名使用复数名词"
    - "分页参数统一使用 offset + limit"
    - "所有响应包含 code、data、message 三字段"

  forbidden:
    - "GET 请求携带 body"
    - "在 URL 中传递敏感参数"

  naming:
    endpoints: kebab-case
    query_params: snake_case
```

### 8.3 Agent 配置要点

在 Agent 配置中设置 `capabilityTags` 是打通 Skill 匹配的关键：

```
capabilityTags: [backend, api, hono]     → 匹配 backend-engineer.skill.yml
capabilityTags: [frontend, ui, react]    → 匹配 frontend-engineer.skill.yml
capabilityTags: [review, audit]          → 匹配 reviewer.skill.yml
capabilityTags: [security]               → 匹配自定义 security-engineer.skill.yml
```

## 9. 当前局限与演进方向

| 维度 | 当前状态 | 演进方向 |
|------|---------|---------|
| Rule 过滤 | 全部加载，不做 Agent 级过滤 | 按 capabilityTags / role 精准过滤 |
| Skill 优先级 | 首次命中即返回 | 评分排序，支持权重配置 |
| Code Agent Rule 注入 | 未实现 | 将 Harness Rules 也注入 Code Agent 提示 |
| YAML 解析 | 自研简单解析器（不支持嵌套对象） | 引入标准 YAML 库（如 `yaml` 包） |
| 双 Skill 体系 | Harness YAML 和 SKILL.md 并行 | 统一为一套，或明确分层：Harness = 内部模板，SKILL.md = 外部生态 |
| Rule 管理 UI | 无，手动编辑 YAML | 前端可视化 Rule 编辑器 |
| Spec 联动 | Spec 不直接引用 Skill/Rule | Spec 阶段可声明推荐的 Skill 和 Rule |
| 版本管理 | 文件级版本号，无冲突检测 | 支持 Skill/Rule 版本升级和回滚 |
