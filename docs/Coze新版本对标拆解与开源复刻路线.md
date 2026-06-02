# Coze 新版本对标拆解与开源复刻路线

最后更新：2026-06-02

本文目标不是泛泛做竞品分析，而是把 Coze 当前公开版本当成 AgentHub 的头号对标对象来拆解。我们的阶段性目标可以明确为：

1. 先完整理解 Coze 当前产品形态与能力边界。
2. 再把 Coze 的交互、配置、执行、资产体系拆成可复刻模块。
3. 最后让 AgentHub 优先成为一套“开源 Coze”。

本文刻意把内容分成两层：

- `官方公开事实`：来自 Coze 官方页面、官方文档、官方法律/产品说明页面。
- `实现推演`：基于其页面结构、公开 API/文档命名、产品行为模式做的架构推测。推演不等于官方确认。

## 1. 先说结论

如果我们把 Coze 新版本作为主对标对象，那么 AgentHub 的产品目标要从“IM 式多 Agent 协作平台”进一步具体化为：

- 一个面向真实工作的 `AI 工作台 / AI 空间`。
- 既能做 `即时复杂任务协作`，也能做 `长期任务 / 主动执行`。
- 既有 `专家 Agent / 技能商店 / 工作流 / 知识库 / 插件 / 评测`，也有 `编程环境 / 部署 / 资产交付`。
- 用户感知上不是“我在配置 agent 系统”，而是“我在组织一支 AI 团队完成工作”。

换句话说，Coze 当前对外卖的不是单个 Bot，也不是单次对话，而是：

`工作目标 -> 智能拆解 -> 多能力协作 -> 直接交付产物 -> 可持续运行`

这和我们赛题想做的东西高度一致。

## 2. 官方公开事实

### 2.1 Coze 当前的总定位已经不是单一 Bot 平台

从 Coze 中国站总览页可以直接看到，它把自己定义成：

- “职场 AI”
- “主动分担目标的工作伙伴”
- “AI office + AI 创作 + AI 开发 + 工作流 + 技能商店”

官方页还明确写到这些能力方向：

- 复杂问题拆解
- 工作产物直接交付
- 主动思考、主动干活
- 技能商店
- 前后端全栈开发
- 云端环境开箱即用
- 一键部署
- 自然语言生成工作流

这说明 Coze 现在的产品心智已经从“聊天机器人平台”升级成：

`通用 AI 工作平台`

来源：

- [Coze 中国站总览](https://www.coze.cn/overview)
- [Coze 空间介绍页](https://www.coze.cn/space-intro)

### 2.2 产品族已经分层

中国站总览页公开列出 Coze 的产品家族：

- 扣子
- 扣子编程
- 扣子罗盘
- 扣子开源
- 企业版

这意味着它不是一个单产品，而是一套平台矩阵：

- `扣子`：主工作产品
- `扣子编程`：偏代码与应用生成
- `扣子罗盘`：偏开发者调试、观测、评测、Prompt 开发
- `扣子开源`：偏私有化/开发平台
- `企业版`：偏组织协作与安全边界

来源：

- [Coze 中国站总览](https://www.coze.cn/overview)

### 2.3 官方文档导航暴露了它的核心对象模型

Coze 英文开发者文档导航中出现了这些一级模块：

- Development
- Library
- Task Center
- Evaluations
- Space Configuration
- Template Store
- Plugin Store
- Work Community
- API Management
- Document Center

这个导航很重要，因为它说明 Coze 的系统真相不是“只有对话”和“只有 Bot 配置”。

至少从概念层看，它已经把平台拆成：

- 开发
- 资产库
- 任务中心
- 评测
- 空间配置
- 模板与插件分发
- API 管理

来源：

- [Coze 开发者文档导航](https://www.coze.com/open/docs/zh_cn/)

### 2.4 文档与 API 暴露了它的运行时构件

搜索结果和文档路径中可以看到这些命名：

- `chat_v3`
- `create_conversation`
- `query_conversation_history`
- `workflow_stream_run`
- `database_select_node`
- `database_update_node`
- `database_delete_node`
- `plugin_node`
- `canvas_node`
- `multi_agent`

这些名称说明 Coze 至少已经对外明确了几类一等公民：

- 会话 / 对话
- 工作流流式运行
- 工作流节点
- 数据库节点
- 插件节点
- 画布节点
- 多 Agent

即使一些页面内容因为前端渲染抓不到正文，单看命名也足够说明其平台不是单纯 prompt playground。

来源：

- [chat_v3](https://www.coze.com/open/docs/developer_guides/chat_v3)
- [create_conversation](https://www.coze.com/open/docs/developer_guides/create_conversation)
- [query_conversation_history](https://www.coze.com/open/docs/guides/query_conversation_history)
- [workflow_stream_run](https://www.coze.com/open/docs/developer_guides/workflow_stream_run)
- [database_select_node](https://www.coze.com/open/docs/guides/database_select_node)
- [database_update_node](https://www.coze.com/open/docs/guides/database_update_node)
- [database_delete_node](https://www.coze.com/open/docs/guides/database_delete_node)
- [plugin_node](https://www.coze.com/open/docs/guides/plugin_node)
- [canvas_node](https://www.coze.com/open/docs/guides/canvas_node)
- [multi_agent](https://www.coze.com/open/docs/guides/multi_agent)

### 2.5 插件商店与模板商店是平台级分发体系

Coze 明确存在：

- Plugin Store
- Template Store

这意味着它不是只让用户“自己从零配”，而是内建一个可分发、可复用、可市场化的资产层。

来源：

- [Plugin Store](https://www.coze.com/store/plugin)
- [Coze 文档导航](https://www.coze.com/open/docs/zh_cn/)

### 2.6 Agent World 指向的是更大的 Agent 生态方向

`world.coze.com` 明确写了：

- “The Parallel Web”
- “Where agents live, work, and connect with each other.”
- Agent 有身份、被信任、被记住
- 服务互相发现、互相调用

这说明 Coze 的更远方向不只是“单产品内部多 Agent”，而是：

`跨服务、跨技能、跨场景的 Agent 网络`

来源：

- [Agent World](https://world.coze.com/)

### 2.7 2026-06-02 实站观察：Coze 已经把“AI 团队工作”直接做成首页主叙事

这部分不是 API 或文档命名推测，而是我在 2026-06-02 直接查看 Coze 当前官网与实站页面后的观察。

官网首页最重要的几个信号非常明确：

- Hero 主标题直接是“新一代 AI 团队，从扣子开始”。
- 副文案直接写“创建项目，召集 Agent，开启协作。从构思、讨论、执行到交付，扣子让人与 Agent 像真实团队一般并肩作战。”
- 首页演示不是单 Agent 对话，而是一个真实的多成员项目流：
  - 用户提出目标
  - `扣子 Agent` 负责拉流程
  - `创作 Agent`、`法务 Agent`、`视频 Agent`、`编程 Agent` 依次交付
  - 中间出现脚本文档等产物
  - 最终由 `扣子 Agent` 收口总结

这个点非常重要。因为它说明 Coze 并没有把多 Agent 藏到完全不可见，而是把“团队协作感”做成了首页一级卖点。

同时，首页还直接暴露了这些平台能力：

- `模型自由切换`
- `完整 Harness 能力`
- `技能调用`
- `长期记忆`
- `工作台（日程、邮箱、云电脑、云手机）`
- `CLI 与 MCP 集成`
- `无需配 API 或理解 MCP，一键安装客户端`
- `云端沙箱环境`
- `数据库、对象存储、联网检索等平台集成服务`
- `一键部署`

这说明 Coze 的产品表达已经非常成熟：

- 面向普通用户时，卖点是“AI 团队、项目、交付、工作台、客户端一键接入”。
- 面向开发者时，卖点是“CLI、MCP、云端 IDE、沙箱、部署、平台资源”。
- 两者没有被拆成割裂产品，而是被组织成一套连续的工作平台叙事。

来源：

- [Coze 中国站总览](https://www.coze.cn/overview)
- [Coze 空间介绍](https://www.coze.cn/space-intro)
- [Agent World](https://world.coze.com/)

## 3. Coze 的产品设计拆解

### 3.1 它卖的是“目标完成”，不是“模型对话”

从公开文案和页面结构来看，Coze 整体更强调：

- 我提目标
- 它拆解
- 它调用能力
- 它交付结果

而不是：

- 我选模型
- 我配 prompt
- 我自己拼工具链

所以它的产品主视角是：

`Job-to-be-done`

不是：

`Agent engineering dashboard`

这点对我们非常关键。AgentHub 现在还有不少“工程配置感”太强的界面；而 Coze 更像“工作台”。

### 3.2 主交互不是 Bot 列表，而是“空间/任务/资产”

官方导航里有 `Task Center`、`Space Configuration`、`Library`、`Evaluations`，这意味着主工作单元至少包含：

- 某个工作空间
- 某个任务
- 某批可复用资产
- 某套评估/观测

这比我们现在单纯的“群聊 + 子对话 + Agent 配置”更完整。

如果对照 AgentHub，我们现在最接近的是：

- `group session` ≈ 工作主入口
- `orchestrator run / task board` ≈ Task Center 的雏形
- `agent library` ≈ 专家资产库的雏形

但还缺：

- 明确的空间资产层
- 任务中心层
- 评测/观测层
- 成果库 / Library 层

除此之外，实站观察还能进一步确认它的主导航不是“模型中心”或“参数中心”，而是更接近：

- 对话
- 文件
- 技能商店
- Agent World

这说明 Coze 很强调四种前台心智：

1. `马上开始做事`
2. `围绕文件和资产继续做事`
3. `从技能/专家入口获得能力`
4. `进入更大的 Agent 生态`

也就是说，它把“文件/资产”和“能力市场”都放到了和对话同级的位置。

### 3.3 “技能商店”是面向用户心智的专家调用入口

Coze 中国站强调“技能商店中有同行前辈训练好的 Agent 技能”。

这句话的产品含义是：

- 用户不一定先理解 Agent、MCP、Workflow
- 用户先理解“我需要一个会做这件事的专家/技能”

所以 Coze 的资产入口更偏：

- 场景
- 结果
- 专家能力

而不是：

- runtime 类型
- 协议类型
- 技能挂载参数

这和你前面一直强调的方向是一致的：  
我们要做的是“专家 / 专家团”，而不是暴露太多底层术语给普通用户。

### 3.4 “扣子编程”证明它把代码生成与应用交付纳入主线

中国站总览直接写：

- 前后端全栈开发
- 云端环境开箱即用
- 无需客户端
- 一键部署
- 提供数据库、对象存储、身份认证等服务

这说明 Coze 不是把“代码 Agent”当一个附属能力，而是已经把：

- 代码生成
- 运行环境
- 部署
- 后端资源

打成一条主体验链路。

这对 AgentHub 的启发是：

- 我们不能只停在“多 Agent 聊天协作”
- 必须把 `执行环境 + 产物托管 + 部署验证 + 资产交付` 视作一条完整链
- 未来首页和主工作台必须显式呈现“结果资产”和“上线交付”，不能只有消息流

### 3.5 “扣子罗盘”说明评测与观测是平台的一等公民

总览页对“扣子罗盘”的描述是：

- 搭建 AI Agent
- 观测
- 评测
- Prompt 开发调试

这说明 Coze 已经把“开发”和“运行效果验证”分成独立价值面。

对我们来说，这几乎就是在提醒：

- 群聊体验只是表层
- 下面必须有 trace / eval / debug / prompt 迭代 / task replay

## 4. Coze 交互逻辑推演

这一节开始是推演，不是官方明示。

### 4.1 它大概率是“三层交互”

基于公开页面与产品叙述，Coze 的交互大概率分成：

1. `工作入口层`
   - 空间、任务、模板、技能、社区

2. `执行编排层`
   - 当前目标
   - 工作流
   - 多 Agent / 多节点协作
   - 长任务执行

3. `资产交付层`
   - 文档 / PPT / 表格 / 图片 / 音视频 / 网页 / 应用
   - 可导出 / 可部署 / 可复用

AgentHub 当前已经有：

- 会话层
- 编排层
- 产物层

但 Coze 式体验要求它们更强地融合成“一个连续工作台”，而不是分散的几个工程页面。

### 4.2 多 Agent 很可能不是主显式概念，而是底层执行机制

虽然 Coze 文档中有 `multi_agent` 路径，但从中国站文案看，它面对普通用户更常用的话术是：

- 工作伙伴
- 技能
- 工作流
- 主动执行

这意味着：

- 多 Agent 可能真实存在
- 但前台不一定总是把它赤裸裸展示成“你正在使用 6 个 agent”

对产品层更重要的是：

- 让用户感知到“有人在分工干活”
- 让用户看到阶段推进、产物、可追踪过程
- 不要求用户先理解底层架构术语

这对 AgentHub 很关键：  
我们仍然要保留“主群聊 + 子对话 + 任务看板”的透明性，但主叙事要更接近“AI 团队在工作”，而不是“你在操作一个编排引擎”。

不过从实站首页来看，还要补一句更精确的判断：

- `多 Agent 不是唯一主显式概念`
- 但 `AI 团队协作` 明显已经是 Coze 的一级显式概念

所以更准确的说法不是“Coze 完全隐藏多 Agent”，而是：

`它把多 Agent 包装成项目协作、团队接力、专家分工，而不是工程术语列表。`

### 4.3 Coze 的主动性来自“任务中心 + 长期任务 + 可恢复运行”

中国站明确写到：

- 离线时依然执行长期任务
- 每天为你总结关心资讯

所以它底下必然有某种：

- 计划任务
- 任务恢复
- 状态持久化
- 周期触发
- 结果投递

AgentHub 当前在这方面只有部分基础：

- orchestrator runs
- task scheduler
- blackboard
- execution logs
- automations / heartbeats 还没有真正成为主产品体验

如果要复刻 Coze，这块优先级要大幅抬高。

## 5. Coze 底层实现推演

### 5.1 很可能是“空间 + 任务 + 工作流 + 资产”的统一底座

从公开命名看，Coze 的平台主数据模型很可能围绕这些实体：

- Space
- Conversation
- Task
- Workflow
- Node
- Plugin
- Template
- Evaluation
- Asset / Library Item

对照我们当前模型：

- `workspaces`
- `sessions`
- `workspace_tasks`
- `orchestrator_runs`
- `messages`
- `execution_logs`
- `blackboard_entries`

其实已经有一半雏形，但：

- 我们的 `workspace` 仍偏工程工作区
- Coze 的 `space` 更像产品级工作容器

### 5.2 工作流不是外挂，而是平台内核

`workflow_stream_run`、`database_*_node`、`plugin_node`、`canvas_node` 这些路径说明：

- 工作流不是次要功能
- 节点系统不是文档里的摆设
- 数据、插件、画布、流式执行是统一运行时的一部分

AgentHub 现在更像：

- Orchestrator DAG 是内核
- Workflow editor / node runtime 还没有成为用户可编辑的一等形态

如果按 Coze 方向走，长期看我们需要：

- 让 DAG 不只服务内部 orchestrator
- 还要能外显为某种用户可理解、可编辑、可复用的 workflow / contract / board 形态

### 5.3 API 层暴露了“对话运行时”和“工作流运行时”并存

公开路径里既有：

- `chat_v3`
- `create_conversation`
- `query_conversation_history`

又有：

- `workflow_stream_run`

这通常意味着底层至少有两套相互关联但不同的运行时接口：

1. 对话运行时
2. 工作流运行时

而 Coze 把它们包装成统一产品体验。

AgentHub 现在也正在这个方向上：

- 群聊 / 子对话是对话运行时视角
- planner / DAG / task scheduler 是工作流运行时视角

这条路线是对的，只是我们前端还没完全统一。

### 5.4 插件、数据库、知识、部署应该都被当成原生能力，而非旁路集成

Coze 对外展示“插件商店”“数据库节点”“一键部署”，意味着这些不是“外部接上去的工具”，而是：

- 在产品心智里就是系统能力
- 在执行链里是原生可调用构件

对 AgentHub 的直接启发：

- MCP 虽然在技术上是外部协议，但在产品层不能只是“高级配置”
- 至少要把常用能力包装成：
  - 文件与知识
  - 浏览器与抓取
  - Git 与代码库
  - 数据库
  - 发布与预览

另外，从实站首页直接出现的“CLI 与 MCP 集成”“一键安装客户端”“无需配 API 或理解 MCP”，还能得到一个很重要的产品结论：

- Coze 的技术底座并不轻
- 但它努力把“技术复杂度”藏在平台里

这对我们非常关键。AgentHub 后续不能把：

- 模型配置
- CLI 探测
- MCP 挂载
- 沙箱安装
- 鉴权配置

直接裸露成用户第一眼的主界面心智。  
这些仍然存在，但应该沉到底层设置、专家配置、健康检查和高级能力面板里。

## 6. AgentHub 与 Coze 的差距

### 6.1 我们现在更像“多 Agent 编排工作台”，还不像“完整 AI 工作平台”

我们已经有：

- 主群聊 + 子对话
- 动态 DAG
- A2A / AG-UI / MCP 分层
- 多 Code Agent 基底
- 产物卡

但还缺 Coze 式的：

- 统一工作台叙事
- 任务中心产品层
- 资产库产品层
- 评测 / 观测产品层
- 应用生成与部署闭环
- 长期主动任务产品层

### 6.2 我们现在的“专家配置”比 Coze 更工程化

Coze 面向用户的入口更像：

- 技能
- 模板
- 专家
- 工作结果

我们现在还是很容易暴露：

- runtimeType
- codeAgentType
- skillIds
- sandboxPolicy
- modelId

这些底层概念对我们自己有用，但对产品第一视角不够友好。

### 6.3 我们还没有把“交付物”做成系统主轴

Coze 明确强调：

- PPT
- 文档
- 表格
- 图片
- 音视频
- 网页 / 应用

而我们现在的产物层更偏：

- 文件
- diff
- preview

这还不够“工作结果中心”。

### 6.4 我们还没有把“主动执行”真正产品化

Coze 强调离线持续执行、长期任务、资讯总结。  
我们现在更多还是：

- 发消息
- 执行一轮
- 给结果

要复刻 Coze，这块必须升级成：

- Scheduled work
- Inbox / task center
- Run recovery
- Result feed

### 6.5 我们目前还缺 Coze 式的“产品入口分层”

从当前实站能看到，Coze 不是把所有东西都塞在一个聊天页里，而是逐步形成了这些前台入口：

- 对话
- 文件
- 技能商店
- Agent World
- 编程 / 视频 / 罗盘 / 企业版等产品分支

而 AgentHub 现在仍然更像：

- 左侧会话树
- 中间聊天主区
- 右侧少量辅助状态

这意味着我们现在最大的问题之一不是“功能点缺几个按钮”，而是：

`我们还没有长出 Coze 那种产品级信息架构。`

## 7. 复刻 Coze 的优先级路线

### Phase 1：先把产品壳子对齐 Coze

目标：让 AgentHub 的第一眼产品感接近 Coze，而不是“多 Agent 调试器”。

优先改：

1. 首页 / 主入口心智
   - 从“聊天会话列表”升级成“工作空间 / 工作任务 / 结果资产”

2. 群聊主界面
   - 强化“目标 -> 计划 -> 执行 -> 交付”的连续工作流感
   - 弱化底层工程术语

3. 专家 / 专家团入口
   - 以结果和场景呈现，而不是以技术角色参数呈现

4. 产物中心
   - 把网页、报告、PPT、文档、表格、图片这些类型作为显式资产类型

5. 一级信息架构
   - 把“对话 / 任务 / 资产 / 专家 / 评测”做成清晰一级入口
   - 不再让“会话树”独自承载整个平台的信息组织

### Phase 2：把运行时对齐 Coze 的工作台内核

目标：让 AgentHub 不只是会调度 Agent，而是能稳定承载复杂工作目标。

优先改：

1. Task Center
   - 任务中心视图
   - 长任务状态
   - 周期任务 / 自动任务入口

2. Space
   - 把 workspace 从工程目录抽象成产品级 space
   - 工程目录只是 space 的一种执行资源

3. Library / Assets
   - 统一知识、文件、产物、模板、报告

4. Evaluations / Trace
   - 运行观测
   - 评测
   - prompt / run replay

### Phase 3：把能力层做成 Coze 式原生能力

目标：让 MCP / Skills / Browser / Database / Deploy 在产品上像“内建能力”。

优先改：

1. 浏览器与信息采集能力产品化
2. 数据源 / 数据库能力产品化
3. 文档 / PPT / 表格 / 网页生成链路产品化
4. 应用部署与预览闭环产品化

### Phase 4：把多 Agent 协作升级成 Coze 级“主动执行系统”

目标：不只是协作生成一次结果，而是持续为用户推进目标。

优先改：

1. 长任务计划与恢复
2. 主动补员与能力编排
3. 结果订阅 / feed / inbox
4. 组织与团队协作能力

## 8. 对 AgentHub 的具体改造建议

### 8.1 先把“群聊”升级成“工作会话”

现在的群聊是对的，但还不够 Coze。

要加强：

- 顶部显示目标、阶段、负责人、当前产物
- 中央主流是阶段进度和成员汇报
- 右侧或底部有任务中心 / 产物中心 / 运行日志切换

### 8.2 把“创建群聊”升级成“创建空间 / 创建工作”

Coze 的感觉更像“开始一个工作目标”，而不是“建一个聊天房间”。

所以我们后续应逐步把入口改成：

- 新建工作
- 选择目标类型 / 结果类型
- 选择空间 / 项目资源
- 推荐专家团
- 启动执行

这一步不是简单改文案，而是要把用户的起点从：

- “我要建个聊天房间”

切到：

- “我要发起一个工作目标 / 一个项目 / 一次交付”

### 8.3 把“专家配置页”从工程参数页改成“专家工作台”

保留底层参数，但第一层展示应该是：

- 专家简介
- 适用场景
- 默认能力包
- 推荐产物
- 推荐工具 / MCP
- 组合健康检查

### 8.4 把“多 Agent 协作”继续保持成我们的差异化优势

Coze 的优势是完整产品形态。  
我们的机会是：

- 做成真正开源
- 把多 Coding Agent 协作做得更透明
- 把子对话 / 任务轨迹 / 产物交接 / 协作可观测性做得比 Coze 更强

所以不是简单抄 UI，而是：

`复刻 Coze 的产品形态 + 加强开源透明协作能力`

### 8.5 我们应该直接复刻的 Coze 产品表达

从当前观察看，下面这些表达是值得直接学习甚至 1:1 复刻心智的：

1. `AI 团队`
   - 不说“多 runtime 编排”
   - 说“创建项目，召集 Agent，开启协作”

2. `项目 / 工作`
   - 不说“新建群聊”
   - 说“新建工作”“新建项目”“发起目标”

3. `文件 / 资产`
   - 文件和产物不是聊天附属物
   - 它们应当是一等入口

4. `技能商店 / 专家入口`
   - 不先暴露 agent engineering 参数
   - 先暴露“谁能帮我做这件事”

5. `客户端一键接入`
   - 不让普通用户先理解 API / MCP / CLI
   - 先让他“能用起来”

6. `云端沙箱 / 一键部署`
   - 执行环境与交付能力要是平台卖点，而不是实现细节

### 8.6 我们不该盲目复刻、而应做得更强的地方

Coze 再强，它也未必会把内部协作过程像我们希望的那样完全透明化。

AgentHub 可以在这些点上做得比它更强：

1. 真正可点击、可追踪的子对话
2. 明确可见的 DAG / 依赖 / 黑板 / handoff
3. 更好的运行时追踪和失败分类
4. 更开放的 Code Agent / MCP / Skill 生态适配
5. 更容易私有化、开源自托管和二次定制

## 9. 接下来我们应该立刻做什么

按优先级，我建议接下来直接推进这四件事：

1. `产品壳重构`
   - 把主入口从“聊天列表”升级为更接近 Coze 的“工作台”

2. `Space / Task Center / Asset Center 三块成型`
   - 这会决定我们是不是像 Coze，而不是像一个 Agent demo

3. `专家 / 专家团重新整理`
   - 以 Coze 的技能/专家心智来组织，不再让配置像工程参数表

4. `文档产物链与编程/部署闭环`
   - 这是 Coze 极强的一条主线，也是赛题会非常看重的地方

5. `一级信息架构重构`
   - 明确 AgentHub 后续首页与主壳要有哪些一级入口
   - 这是从“多 Agent demo”进化为“开源 Coze”的分水岭

## 10. 参考来源

以下是本文直接引用或用于判断的主要来源：

- [Coze 中国站总览](https://www.coze.cn/overview)
- [Coze 空间介绍](https://www.coze.cn/space-intro)
- [Coze 开发者文档导航](https://www.coze.com/open/docs/zh_cn/)
- [Plugin Store](https://www.coze.com/store/plugin)
- [Personal Access Tokens / API 管理](https://www.coze.com/open/api)
- [chat_v3](https://www.coze.com/open/docs/developer_guides/chat_v3)
- [create_conversation](https://www.coze.com/open/docs/developer_guides/create_conversation)
- [query_conversation_history](https://www.coze.com/open/docs/guides/query_conversation_history)
- [workflow_stream_run](https://www.coze.com/open/docs/developer_guides/workflow_stream_run)
- [database_select_node](https://www.coze.com/open/docs/guides/database_select_node)
- [database_update_node](https://www.coze.com/open/docs/guides/database_update_node)
- [database_delete_node](https://www.coze.com/open/docs/guides/database_delete_node)
- [plugin_node](https://www.coze.com/open/docs/guides/plugin_node)
- [canvas_node](https://www.coze.com/open/docs/guides/canvas_node)
- [multi_agent](https://www.coze.com/open/docs/guides/multi_agent)
- [Agent World](https://world.coze.com/)
