# Spec 协作契约规范

> 状态：已重写。旧版 Spec 曾被设计成“按 trigger 正则命中固定场景模板”的工作流骨架，这与当前 AgentHub 的通用多 Agent 协作目标冲突。当前文档只保留 Spec 作为可选协作契约的设计边界，不再把它作为默认计划来源。

## 1. 当前结论

AgentHub 当前主路径是：

```text
用户目标
  -> Orchestrator 动态理解
  -> Planner 动态生成 DAG
  -> 多个 Coding Agent 在任务子对话中真实执行
  -> 主群聊展示进度、成员汇报、产物和最终总结
```

Spec 不能再承担以下职责：

- 不能作为“Web 应用构建”“代码审查”等内置固定场景模板。
- 不能通过 trigger 正则或关键词抢先判断用户意图。
- 不能替 Orchestrator/Planner 决定阶段、分工、追加任务。
- 不能被 `ensureHarnessPresets()` 默认复制到新工作区。

Spec 可以保留的合理定位是：**用户或项目主动提供的协作契约**。它只描述验收标准、输出契约、合规约束、路径边界、可用能力等可校验信息，供 Planner 参考和系统校验，不作为隐藏路由器。

当前实现只读取 `.agenthub/contracts/*.contract.json|yml`。旧的 `.agenthub/specs/*.spec.yml` 不再是主路径，`.agenthub/specs` 目录下即使出现 `*.contract.*` 也不会被加载。

## 2. 与旧设计的差异

| 旧设计 | 当前要求 |
| --- | --- |
| `.agenthub/specs/web-app-building.spec.yml` 这类内置场景模板 | 删除，不再内置 |
| `triggers` 正则命中用户目标 | 不作为默认主路径 |
| 首次命中 Spec 即注入 Planner | 不再让静态规则抢占 Orchestrator 判断 |
| Spec 定义阶段 DAG 和 requiredAgents | Planner 动态生成 DAG，Spec 最多提供约束 |
| Spec 与 Skills/Rules 并列复制到新工作区 | 新工作区只复制通用 rules/skills，不复制 specs |

## 3. 推荐的新 Schema 方向

后续如果恢复 Spec，建议改成契约而不是模板：

```yaml
spec:
  id: project-delivery-contract
  name: 项目交付契约
  version: 1.0.0

  scope:
    description: 这个工作区希望 Agent 遵守的交付边界
    allowedPaths:
      - src/**
      - docs/**
    forbiddenPaths:
      - .env
      - node_modules/**

  outputs:
    artifactChain:
      - 需求理解或调研记录
      - 实施计划
      - 可交付文件或代码
      - 验证记录
      - 最终总结
    requiredArtifacts:
      - report
      - source_file

  quality:
    acceptanceCriteria:
      - 说明完成了哪些用户目标
      - 标明失败任务和部分产物
      - 给出可复现的验证方式
    qualityGates:
      - 关键产物必须能追溯到 runId、taskId、agentId 和 childSessionId
      - 验证失败时必须保留部分产物并说明失败原因

  capabilities:
    preferredSkills:
      - document
      - frontend
    requiredTools:
      - workspace:read
```

这类 Spec 的作用是约束和校验，不是把“做网站”硬拆成需求分析、架构设计、实现、审查。

## 4. Planner 边界

Planner 可以读取用户显式配置的契约，但必须遵守：

- 分工来源仍是模型输出。
- 系统代码只做 schema 校验、路径校验、权限校验、任务依赖合法性校验。
- 如果契约和用户目标冲突，应让 Orchestrator 说明冲突并询问用户，而不是静默覆盖。
- 失败时透明报错或重试，不生成静态兜底计划。

## 5. 代码清理状态

已经清理：

- 删除内置 `.agenthub/specs/web-app-building.spec.yml`。
- 删除内置 `.agenthub/specs/code-review.spec.yml`。
- `ensureHarnessPresets()` 不再把 `specs` 复制到新工作区。
- `HarnessManager` 和 `Planner` 的运行链路不再使用 `findBestSpec()` / `specPhases` / `ProjectSpec`。
- 显式契约由独立的契约加载器读取，只认 `.agenthub/contracts`，不再混入 Harness 的 Skills/Rules 路径，也不再兼容 `.agenthub/specs`。

历史遗留说明：

- 如果未来恢复 Spec，只能作为显式契约读取，而不是自动命中模板。
- 若要承载复杂契约，应改用正式 YAML/JSON 解析器，而不是当前简单 YAML 兼容器。

## 6. 判断准则

当你准备新增一个 Spec 时，先问：

- 它是在帮 Planner 校验输出，还是替 Orchestrator 决定意图？
- 它是项目约束，还是固定场景模板？
- 用户是否显式选择或创建了它？
- 它失败时是否透明，而不是静默回落到静态计划？

如果答案偏向“静态判断、固定场景、自动命中”，就不应该加入当前主路径。
