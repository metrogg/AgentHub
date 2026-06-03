# AgentHub 需求分析文档

## 1. 项目背景与目标

### 1.1 赛题背景

#### 1.1.1 字节跳动AI全栈挑战赛概述，AgentHub课题定位

字节跳动AI全栈挑战赛是由字节跳动主办的面向高校开发者的技术竞赛，旨在考察参赛者在AI产品设计、工程实现和创新思维方面的综合能力。本次AgentHub课题要求构建一个IM聊天式多Agent协作平台，核心定位是"让用户像使用飞书一样指挥多Agent完成复杂开发任务"。赛题明确要求平台采用IM聊天作为核心交互范式，通过新建对话、发送消息的方式与不同AI
Agent交互，支持单聊（1v1与单个Agent对话）和群聊（@多个Agent触发协作）两种模式，并至少接入两个主流Agent平台（Claude
Code + Codex / OpenCode）[^1]
[^2]。AgentHub的差异化定位在于：它不仅是一个聊天界面，更是一个完整的多Agent协作编排平台，涵盖任务拆解、Agent调度、产物生成、预览编辑到一键部署的全生命周期。

#### 1.1.2 评审维度与权重分析（AI协作能力30%、功能完整度25%等）

赛题设置了五个评审维度，形成清晰的优先级导向。其中AI协作能力占比最高（30%），核心考察点是参赛团队是否能在开发过程中沉淀出与AI协作的Spec、Skill、Rules等协作规范
[^3]
[^4]------这意味着"软实力"（文档、规范、协作流程）的展示价值甚至高于纯技术实现。功能完整度占25%，重点评估IM核心体验的流畅度和多Agent调度的可用性。生成效果质量占20%，关注UI体验和产物预览效果，要求对标Lovable、V0等一线AI编程产品的视觉水准。代码理解度占15%，答辩时需要清晰解释架构选型理由。创新与产品感占10%，鼓励超预期的功能设计和产品思考。

  ------------------------------------------------------------------------------------
  考察维度       权重      关键考察点                     对需求的启示
  -------------- --------- ------------------------------ ----------------------------
  AI协作能力     30%       Spec/Skill/Rules协作规范沉淀   需内置协作规范自动生成能力

  功能完整度     25%       IM体验流畅、多Agent调度跑通    P0功能必须端到端可用

  生成效果质量   20%       UI体验、产物预览效果           参考Lovable/V0设计标准 [^5]

  代码理解度     15%       架构选型解释能力               技术决策需有据可查

  创新与产品感   10%       超预期功能、详细产品方案       预留差异化创新空间
  ------------------------------------------------------------------------------------

这一权重分布揭示了一个关键洞察：冠军项目往往不是功能最多的，而是在协作规范上有系统性思考和展示的
[^6]。因此AgentHub的设计不仅要实现功能，更要通过自动化工具将规范生成内嵌到产品体验中，帮助用户（也帮助参赛团队自身）高效产出高质量的协作规范。

### 1.2 产品愿景

#### 1.2.1 AgentHub产品定位：IM聊天式多Agent协作平台

AgentHub的产品定位是"IM聊天式多Agent协作平台"，核心创新点在于将即时通讯（IM）的自然交互范式与多Agent协作的技术能力深度融合。用户不需要学习复杂的Agent配置或工作流编排工具，只需像日常聊天一样@不同的AI助手，就能触发复杂的协作任务
[^7]
[^8]。这种设计的底层逻辑源于对现有AI编程产品的痛点分析：Lovable、Bolt.new、v0等产品虽然提供了强大的AI编程能力，但均局限于单一Agent交互模式，无法应对需要多个专业角色（前端开发、后端开发、UI设计、代码审查）协作的复杂任务
[^9]。AgentHub通过引入"群聊@协作"机制，填补了多Agent协作IM交互范式的市场空白。

#### 1.2.2 核心目标：让用户像用飞书一样指挥多Agent完成复杂开发任务

AgentHub的核心目标是降低多Agent协作的使用门槛，让全栈开发者和AI产品爱好者能够"像用飞书一样指挥多Agent完成复杂开发任务"。具体而言，平台需要实现三层递进目标：第一层是"聊得来"------提供流畅的IM聊天体验，支持文本、代码、图片、文件等多种消息类型，Agent响应延迟低于2秒；第二层是"协作好"------Orchestrator协调器能够智能拆解任务、调度多个Agent并行/串行执行、聚合产出并汇报结果
[^10]
[^11]；第三层是"产得出"------从对话到产物的全链路闭环，Agent生成的代码、网页、文档支持实时预览、二次编辑和一键部署。调研显示，40%的多Agent系统试点在6个月内失败，主要原因包括协调器误分类任务、上下文窗口溢出和缺乏评估指标
[^12]，因此AgentHub在设计上需要特别关注Orchestrator的精度和鲁棒性。

### 1.3 目标用户

#### 1.3.1 主要用户画像：全栈开发者、AI产品爱好者、技术团队

AgentHub的目标用户可分为三类核心人群。第一类是全栈开发者，他们具有一定的技术基础，习惯使用Cursor、VS
Code等工具进行开发，对AI辅助编程有较高接受度，核心诉求是快速原型验证和代码生成
[^13]。第二类是AI产品爱好者，包括产品经理、设计师和非技术创始人，他们希望将创意快速转化为可演示的原型，对UI质量和交互流畅度要求高
。第三类是小型技术团队（2-5人），需要多人协作完成项目，关注Agent间的任务分配和产物一致性。竞品分析显示，Lovable的800万用户中有大量非技术背景用户
[^14]，而Cursor则主要面向专业开发者
，AgentHub需要在两者之间找到平衡------既提供专业级的多Agent协作能力，又保持IM聊天的低门槛入口。

#### 1.3.2 用户核心痛点：多Agent切换繁琐、协作流程不透明、产物管理混乱

通过对现有AI编程产品的用户反馈分析，我们识别出三个核心痛点 [^15]
[^16]。**痛点一：多Agent切换繁琐**。当前用户需要分别打开Claude、ChatGPT、Cursor等多个工具，在不同窗口间手动复制粘贴上下文，协作效率极低。**痛点二：协作流程不透明**。现有产品缺乏对多Agent协作过程的可视化展示，用户无法看到任务是如何被拆解、分配和执行的，当产出不符合预期时难以定位和调试。**痛点三：产物管理混乱**。Agent生成的代码、文档、设计稿散落在不同对话中，缺乏统一的版本管理和回溯机制，AI"破坏工作代码"是用户最频繁的抱怨之一
[^17]。AgentHub的设计正是针对这些痛点：通过统一适配器层将多个Agent整合到同一个IM界面中，通过Orchestrator的可视化执行跟踪让协作过程透明化，通过产物版本快照和Diff视图实现产物全生命周期管理。

## 2. 功能需求

### 2.1 IM聊天系统（P0核心）

#### 2.1.1 对话列表：新建/置顶/归档/搜索，按最近活跃排序

对话列表是AgentHub的导航中枢，位于界面左侧，需要支持完整的会话生命周期管理。核心功能包括：新建对话------点击"+"按钮弹出Agent选择器，可选择单聊（一个Agent）或群聊（多个Agent）模式；置顶------将高频使用的会话固定在列表顶部，最多支持10个置顶；归档------将已完成或暂不活跃的会话移入归档区，保持主列表整洁；搜索------支持按会话名称、Agent名称、消息内容进行全文搜索；排序规则------默认按最近活跃时间降序排列，新消息到达时自动置顶闪烁
[^18] [^19]。技术实现上，会话列表需要独立的WebSocket
Channel广播元数据变更，未读计数由服务端计算后增量推送到客户端
[^20]。消息分页必须使用cursor-based
pagination而非offset，以避免大数据量下的性能劣化 [^21] [^22]。

#### 2.1.2 单聊模式：1v1与单个Agent对话，适合明确任务

单聊模式是AgentHub的基础交互单元，用户与单个Agent进行1v1对话，适合任务边界清晰的场景（如"用React写一个带搜索功能的表格组件"）。单聊会话中，Agent表现为IM中的"联系人"，有独立的头像、名称和能力标签。每条用户消息作为独立请求发送到对应Agent的API，Agent的响应以SSE流式传输的方式逐token渲染到聊天界面中
[^23]
[^24]。单聊模式需要支持完整的上下文管理：聊天历史自动传递给Agent作为对话上下文，支持用户手动pin关键消息作为长期上下文锚点
[^25] [^26]。调研发现，LobeChat
v2.0已原生支持多Agent群聊协作功能，其左侧会话列表+中间聊天区域+右侧设置面板的三栏布局与AgentHub需求高度契合
[^27]。

#### 2.1.3 群聊模式：@多个Agent触发Orchestrator协调，Agent依次回复

群聊模式是AgentHub的核心差异化功能。用户在群聊中输入"@前端Agent
\@后端Agent 帮我做一个 Todo
应用"，消息首先被发送到Orchestrator协调器。Orchestrator自动理解用户意图，将"做一个Todo应用"拆解为前端任务（React界面）和后端任务（API +
数据库），然后依次调度对应Agent执行
。每个Agent完成任务后，在群聊中依次回复各自的产出（代码、说明等），最后由Orchestrator聚合所有产出并生成总结汇报。调研显示，LangGraph
Supervisor模式最适合实现这一机制------Supervisor节点做路由决策（94%精度），Worker节点执行具体任务，图结构天然支持DAG依赖调度
[^28] [^29]。群聊消息分发采用Hybrid
Fan-out策略：在线Agent实时推送，执行中的Agent通过状态卡片展示进度 [^30]
[^31]。

#### 2.1.4 多会话并行：同时开启多个对话窗口

多会话并行是IM体验的标配功能，用户可以同时打开多个会话窗口，分别与不同Agent或Agent组交流不同任务。每个会话拥有独立的消息流、状态和历史记录，会话间互不干扰
[^32] [^33]。前端使用Zustand的slice
pattern管理状态，每个会话对应一个独立的状态slice，通过选择器优化避免不必要的重渲染
[^34] [^35]。服务端采用基于Channel的会话架构：每个会话对应一个Pub/Sub
Channel，消息只在会话channel内广播；会话列表变更通过独立的元数据Channel同步
。状态绑定用户身份而非连接ID，确保用户重连后可恢复所有会话状态。根据调研，Zustand已成为2024年React状态管理的主流选择，学习成本低且无样板代码，被LobeChat等众多项目采用
。

#### 2.1.5 消息类型：文本、代码块、图片、文件附件、网页预览卡片、Diff视图卡片、部署状态卡片

AgentHub需要支持丰富的消息类型以承载多Agent协作的各种产出。基础消息类型包括：文本------支持Markdown渲染（GFM语法、LaTex、Mermaid）；代码块------语法高亮、行号显示、一键复制；图片------上传和URL引用，支持灯箱查看；文件附件------带文件名、大小和下载链接的卡片。增强消息类型包括：网页预览卡片------OG标签解析+iframe内联渲染；Diff视图卡片------基于react-diff-viewer的代码变更对比，高亮additions和deletions
[^36]；部署状态卡片------实时展示部署进度（构建中/成功/失败），含预览URL入口。消息数据模型使用Snowflake
ID确保全局唯一且有序，每条消息包含单调递增的sequence号用于会话内排序 。

  ----------------------------------------------------------------------------
  消息类型         渲染组件         关键技术                   用途
  ---------------- ---------------- -------------------------- ---------------
  文本             Markdown渲染器   react-markdown +           通用对话内容
                                    remark-gfm                 

  代码块           语法高亮         react-syntax-highlighter   Agent生成代码

  图片             图片预览         Next.js Image + 灯箱       设计稿、截图

  文件附件         文件卡片         自定义组件                 产物打包下载

  网页预览         链接卡片         react-open-graph + iframe  实时预览

  Diff视图         Diff查看器       react-diff-viewer          代码变更对比

  部署状态         状态卡片         WebSocket实时推送          部署进度跟踪
  ----------------------------------------------------------------------------

#### 2.1.6 消息操作：回复、引用、重新生成、复制代码、一键应用Diff、展开预览

每条消息需要支持一组标准操作以提升交互效率。回复------针对某条消息发起回复，形成消息线程（Threading），被回复消息显示缩略引用
[^37]
[^38]；引用------在输入框中插入被引用消息的摘要，Agent可以看到引用上下文；重新生成------对Agent的不满意回复，点击重新生成获取新回答；复制代码------代码块右上角的一键复制按钮；一键应用Diff------Diff视图卡片上的"应用更改"按钮，将代码变更直接写入产物编辑器；展开预览------点击网页预览卡片的"展开"按钮进入全屏预览模式。这些操作的设计参考了Slack的消息交互模式和Lovable的三模式设计哲学
[^39]，目标是让用户在聊天流中完成尽可能多的操作，减少页面跳转。

#### 2.1.7 上下文管理：聊天历史自动传递，支持pin关键消息作为长期上下文

上下文管理是多Agent协作的关键基础设施。自动传递------每次对话时，完整的历史消息自动作为上下文传递给Agent，Agent基于历史理解上下文进行多轮迭代
。Pin消息------用户可以将关键消息（如需求说明、设计决策、代码规范）pin到会话顶部，这些消息会作为长期上下文优先传递给Agent，避免在长对话中被后续消息淹没。上下文压缩------当对话历史超过Agent的上下文窗口限制时，Orchestrator自动进行摘要压缩，只保留关键决策点和pin消息
。调研显示，Claude Code的Plan
Mode将"Explore→Plan→Implement→Commit"四阶段工作流内化为核心能力，可防止90%的AI编码错误
，AgentHub可以借鉴这种阶段化上下文管理策略。

### 2.2 Orchestrator协调器（P0核心）

#### 2.2.1 任务拆解：自动理解用户意图，将复杂任务分解为子任务

Orchestrator协调器是AgentHub的"大脑"，负责任务拆解、Agent调度和结果聚合的全流程。任务拆解是第一步：当用户在群聊中提出复杂需求（如"帮我开发一个博客系统"），Orchestrator使用Chain-of-Thought
prompting进行逐步分解，输出结构化的子任务列表（JSON/YAML格式），每个子任务包含task_id、description、agent_type、dependencies、priority等字段
[^40]。拆解采用五阶段编排管线：需求澄清→任务拆解→Agent分配→并行求解→结果聚合
。技术实现上，推荐使用LangGraph
Supervisor模式------Supervisor节点负责意图理解和任务拆解，Worker节点执行具体任务，图结构完全可控且支持Human-in-the-loop
。任务拆解的误差模型显示，总误差与分支因子b和深度D相关（`E_0 <= b^D * e_D`），因此需要限制拆解深度不超过3层
。

#### 2.2.2 Agent调度：为子任务匹配最合适的Agent，支持并行和串行调度

Agent调度是Orchestrator的核心能力。调度前需要先进行Agent选择：根据子任务描述与Agent能力标签的匹配度进行路由。调研显示，混合路由策略效果最佳------先用能力标签做精确过滤，再用LLM或Embedding做精细排序
[^41]
[^42]。调度策略支持三种拓扑：串行------依赖步骤，前一步输出是后一步输入；并行------独立子任务同时执行，可带来5-20倍的速度提升
[^43]；层次化------复杂多域工作流，Supervisor-Worker模式
。在LangGraph中，并行模式通过fan-out +
join实现：Supervisor节点分发到多个Worker，各Worker完成后返回Supervisor进行聚合
。调度依赖基于DAG数据结构表达，支持拓扑排序确定执行顺序 [^44]。

  --------------------------------------------------------------------------------
  调度拓扑      结构              适用场景         延迟              代表框架
  ------------- ----------------- ---------------- ----------------- -------------
  串行          线性节点链        依赖步骤         高（顺序累加）    CrewAI
                                                                     Sequential

  并行          扇出+合并         独立子任务       低（5-20x加速）   LangGraph
                                                                     fan-out

  层次化        Supervisor+子图   复杂多域工作流   中                LangGraph
                                                                     Supervisor
  --------------------------------------------------------------------------------

#### 2.2.3 结果聚合：收集子Agent产出，整合为完整结果汇报

结果聚合是Orchestrator的最后一步，负责收集各子Agent的产出并整合为完整结果汇报给用户。聚合采用混合策略：先用规则合并做快速聚合（如按文件路径排序的代码列表），再用LLM
Reduce做语义升华（生成综合性的总结说明）[^45]。对于代码生成类任务，可以借鉴Mixture-of-Agents架构------多个Agent并行生成候选方案，Aggregator综合所有候选生成最优方案，核心洞察是"从多个草稿中综合最优答案比从头生成更容易"
[^46]
[^47]。聚合结果在群聊中以结构化消息卡片的形式展示，包含：任务完成摘要、各Agent产出概览、关键决策点说明、下一步建议。用户可以对聚合结果提出修改意见，Orchestrator据此进行迭代优化。

#### 2.2.4 错误处理：失败降级、超时重试、代码冲突检测

错误处理是生产级Orchestrator的必备能力。系统采用五层降级策略 [^48]
[^49]：Layer 1------子任务重试（指数退避，最多3次）；Layer
2------更换备用Agent执行；Layer 3------简化任务后重试；Layer
4------返回部分结果+错误说明；Layer
5------人工介入（human-in-the-loop）。同时需要实现标准弹性模式：重试（Retry）处理瞬态失败、熔断（Circuit
Breaker）在连续失败5次后暂停调用30秒、超时（Timeout）每次调用设时间上限、隔离舱（Bulkhead）限制并发数防止级联故障
。代码冲突检测方面，采用预防为主的策略：通过架构设计让不同Agent负责不同模块，对共享文件采用串行修改策略，提交前自动检测潜在冲突
[^50] [^51]。

### 2.3 多Agent接入（P0核心）

#### 2.3.1 统一适配器层：至少接入Claude Code + Codex/OpenCode

统一适配器层是AgentHub屏蔽多Agent平台API差异的核心组件。赛题要求至少接入两个主流Agent平台（Claude
Code + Codex / OpenCode），通过统一适配器层提供一致的调用接口
。适配器层采用Provider Pattern + Adapter
Pattern组合设计：每个Agent平台对应一个Provider实现，将平台特定的API格式转换为AgentHub内部标准协议。调研发现，各Agent平台的API差异不仅在于协议格式，更在于能力差异（工具支持、代码执行、文件操作等），因此适配器层需要建立一套能力描述语言（Capability
Description Language），让Orchestrator能根据任务需求选择最合适的Agent
。协议层次化格局已形成：MCP（工具层）→ ACP（IDE层）→
A2A（Agent间层），AgentHub通过同时支持这三层协议可以建立技术领先性
[^52]。

#### 2.3.2 用户自建Agent：对话式创建，配置System Prompt + 工具集

用户自建Agent功能允许用户根据自身需求创建定制化Agent。创建流程采用对话式引导：用户点击"新建Agent"后，系统通过一系列问题收集信息------Agent名称、角色描述、专业能力、System
Prompt、可用工具集。创建完成后，Agent以"联系人"卡片的形式出现在聊天列表中，可以像预设Agent一样被@和调度。System
Prompt是Agent行为的核心定义，需要遵循最佳实践编写：角色定义清晰、能力描述完整、约束条件明确、输出格式规范
[^53]。工具集配置允许用户为Agent绑定MCP工具（如文件操作、代码执行、网络搜索），扩展Agent的能力边界
[^54]。

#### 2.3.3 Agent展示：独立"联系人"卡片，含头像、名称、能力标签

每个Agent在聊天列表中以独立的"联系人"卡片展示，视觉风格参考IM应用的好友列表。卡片包含：头像------支持自定义头像或系统预设头像；名称------Agent的显示名称（如"前端助手"、"代码审查员"）；能力标签------以chip/badge形式展示Agent的核心能力（如"React"、"TypeScript"、"API设计"）；状态指示------在线/离线/忙碌等状态；最近消息------显示最后一条消息的摘要。Agent卡片支持点击展开详情页，展示完整的Agent配置（System
Prompt、工具集、历史对话统计）。调研显示，LobeHub的Agent
Groups功能允许配置技能、行为、工具，Agent间可以build on each other's
outputs [^55]，AgentHub可以借鉴这一设计让用户更直观地管理和配置Agent。

### 2.4 产物预览与编辑（P1重要）

#### 2.4.1 内联预览：网页iframe、文档渲染、PPT浏览

产物预览是AgentHub"产物全生命周期"管理的核心环节。内联预览功能允许Agent生成的产物直接在聊天流中以卡片形式展示，无需跳转外部页面。网页预览------使用iframe内联渲染Agent生成的HTML页面，支持实时刷新；文档渲染------支持Markdown、PDF等文档格式的在线预览；PPT浏览------支持幻灯片的基础浏览（P2优先级）。预览卡片提供"展开全屏"按钮，点击后进入全屏预览模式，获得更大的可视区域。竞品分析显示，Lovable采用云端渲染的实时预览面板，Bolt.new使用WebContainers实现浏览器内零延迟预览
[^56]，AgentHub推荐采用iframe +
Sandpack的组合方案，既保证安全性又提供接近原生的预览体验。

#### 2.4.2 代码编辑器：全屏代码编辑，语法高亮和补全

当用户需要编辑Agent生成的代码时，点击代码块或预览卡片的"编辑"按钮进入全屏代码编辑器。编辑器基于Monaco
Editor（VS
Code同款内核）实现，支持语法高亮、代码补全、错误提示、多文件Tab切换等核心功能
。编辑器采用双栏布局：左侧文件树（展示项目目录结构），右侧代码编辑区。用户可以直接在编辑器中修改代码，修改后的内容实时同步回预览iframe。编辑器支持"发送到聊天"功能------选中一段代码后右键选择"让Agent修改"，系统会自动将选中的代码和用户的修改描述一起发送到当前会话中，Agent基于上下文进行修改。

#### 2.4.3 Diff视图：代码变更对比，一键应用

Diff视图是产物管理的关键功能，用于展示Agent生成的代码变更。当Agent修改已有文件时，系统以Diff视图卡片的形式在聊天中展示变更------左侧为原代码（红色deletions），右侧为新代码（绿色additions），变更行高亮显示
。Diff视图支持三种操作：一键应用------将变更直接写入代码编辑器；部分应用------用户可以选择只应用部分变更行；忽略------跳过该变更。Diff视图的设计参考了GitHub
PR的review体验，让用户可以像review代码一样review
AI的修改，既保证效率又保留人工审核的权利。

#### 2.4.4 版本历史：产物版本快照和回溯

版本历史功能记录产物的每次变更，允许用户回溯到任意历史版本。每次Agent修改产物后，系统自动创建版本快照，记录：变更时间、变更Agent、变更摘要、Diff对比。用户可以在版本历史面板中浏览所有版本，点击任意版本查看当时的完整产物状态，并支持"恢复到该版本"操作。版本历史的存储采用增量策略------只存储Diff而非完整副本，以节省存储空间。这一功能直接回应了用户对"AI破坏工作代码"的核心痛点
，让用户可以安心尝试Agent的修改建议， knowing they can always roll
back。

#### 2.4.5 对话式编辑：选中代码→聊天描述修改→应用修改

对话式编辑是AgentHub的创新交互模式，将代码编辑与聊天对话无缝融合。操作流程为：用户在代码编辑器中选中一段代码→点击"询问Agent"按钮→系统自动将选中的代码片段和上下文插入到聊天输入框→用户输入修改描述（如"给这个函数加上错误处理"）→Agent基于选中代码和修改描述生成Diff→用户在Diff视图中确认后一键应用。这种模式的灵感来源于Cursor的Agent
Mode和Lovable的Visual Edits
，核心优势是让用户保持在对话的流畅上下文中完成编辑，无需在编辑器和聊天窗口间反复切换。

### 2.5 部署发布（P1重要）

#### 2.5.1 部署指令：聊天中发送"部署"触发

部署功能是AgentHub"对话即操作"理念的延伸。用户在聊天中直接输入"部署"或"发布"等指令，Orchestrator识别部署意图后，将当前产物打包并触发部署流程。部署指令支持参数化------"部署到生产环境"、"部署为预览链接"等。Agent返回部署状态卡片，实时展示部署进度（打包中→上传中→构建中→部署完成/失败），整个过程对用户透明可见。这一设计参考了Lovable的一键部署和Bolt.new的Netlify/Vercel集成模式
[^57]
[^58]，目标是将部署操作从复杂的命令行/控制台流程简化为一句自然语言指令。

#### 2.5.2 部署方式：预览URL生成、静态站点部署、源码打包下载

AgentHub需要支持多种部署方式以满足不同场景需求。预览URL------生成临时可分享的预览链接，方便用户展示给团队成员或客户，链接有效期默认24小时；静态站点部署------将前端产物部署到Vercel/Netlify等平台，支持自定义域名（P2）；源码打包下载------将产物打包为zip文件供用户下载到本地。部署后端推荐采用Vercel
API + Netlify API双通道方案
，根据产物类型自动选择最优部署通道。对于简单的HTML/CSS/JS产物，优先使用Vercel部署（与Next.js生态天然集成）；对于需要Node.js运行时的产物，使用Netlify或云端Docker部署。

#### 2.5.3 部署状态：实时状态卡片展示

部署状态通过WebSocket实时推送到客户端，以状态卡片的形式展示在聊天流中。状态卡片包含：部署ID、目标平台、当前阶段（用进度条表示）、预计剩余时间、预览URL（部署完成后显示）、错误信息（部署失败时显示）。用户可以在卡片上执行操作：取消部署（进行中时）、重新部署（失败时）、复制预览链接（完成后）。状态机设计为：pending→building→deploying→success/failed，每个状态转换都实时同步到前端。

### 2.6 创新功能（P2加分项）

#### 2.6.1 Agent市场：发现和安装预设Agent

Agent市场是AgentHub的可持续发展功能，让用户可以发现、安装和分享预设Agent。市场提供分类浏览（按场景：开发/设计/测试/运维；按技术栈：React/Vue/Python/Go）、搜索功能、评分和评论、一键安装。预设Agent由官方和第三方开发者贡献，安装后自动添加到用户的聊天列表中。调研显示，成功的AI平台都有Marketplace（Coze
Store、GPT Store、Cursor
Marketplace），Agent市场可以大大提升平台价值和使用黏性 [^59]
。即使在MVP阶段只展示概念界面（Mock数据），也足以体现产品的前瞻思考。

#### 2.6.2 MCP工具集成：Agent可以使用外部工具

MCP（Model Context Protocol）是Anthropic推出的AI
Agent工具集成开放标准，月下载量已超过1.1亿，已成为业界事实标准
。AgentHub通过MCP
Client集成，让Agent可以使用各种外部工具------文件操作（读写、搜索）、代码执行（Python/Node.js沙箱）、网络搜索、数据库查询等。MCP工具的配置在Agent创建/编辑页面完成，用户可以选择为Agent启用哪些MCP
Server。微软Copilot Studio已原生支持MCP
[^60]，证明其已成为企业级Agent工具集成的标准，AgentHub对MCP的支持体现了技术前瞻性。

#### 2.6.3 协作规范自动生成：根据对话自动生成Spec/Skill/Rules

协作规范自动生成是AgentHub最具差异化的创新功能，直接对应评审维度中权重最高的"AI协作能力"（30%）。在用户与Agent的协作对话过程中，系统通过LLM实时分析对话内容，自动提取关键决策点、工作模式、约束条件，生成结构化的协作规范文件
[^61]。

**生成的规范包含三个层次**：

第一层是**Spec规范（做什么）**------从对话中自动提取任务目标、范围边界、验收标准、技术约束，生成符合AGENTS.md开放标准的项目级规范文件
。Spec文档作为单一真相源（Single Source of
Truth），每个功能都先有Spec再编码，代码反向追溯Spec，确保假设和决策在整个生命周期中被追踪
[^62] [^63]。

第二层是**Skill体系（怎么做）**------将对话中反复出现的工作模式提炼为可复用的SKILL.md文件
[^64] [^65]。Skill采用agentskills.io开放标准格式，包含YAML
frontmatter（name、description、triggers）+ Markdown
body（指令、工作流、示例）+
可选资源（scripts、references）。Skill支持渐进式加载：Level
1元数据（\~100 tokens）→ Level 2指令（按需）→ Level
3资源（执行时），有效控制Token消耗 [^66] 。

第三层是**Rules规范（约束条件）**------从对话中提取的编码规范、架构约束、安全红线等，生成为模块化的Rules文件
[^67] [^68]。Rules采用四种触发模式：Always
Apply（每次对话都加载，适用于安全红线）、Auto
Attached（匹配glob模式时加载，适用于技术栈规则）、Agent
Requested（AI根据description判断）、Manual（用户@rule-name显式召唤）。这种分层触发机制确保只有相关规则进入Agent的上下文，避免Token浪费。

**技术实现上**，规范自动生成模块在Orchestrator中作为一个独立的子Agent运行，监听对话流中的关键事件（任务分配、决策确认、代码评审、错误修复），当检测到足够的信息量时触发规范生成。生成的规范文件以消息卡片的形式展示在聊天中，用户可以编辑、确认或拒绝。确认后的规范自动保存到项目的`.agents/`目录中，后续对话自动加载这些规范作为上下文
[^69]。

这一功能的价值在于：它将"AI协作规范"从参赛团队需要手动编写的工作产物，转化为平台内建的产品能力------用户在使用AgentHub协作的过程中，自然而然地沉淀出高质量的Spec/Skill/Rules。这不仅让参赛团队自身的协作记录更有说服力，也让AgentHub产品本身具备了独特的"规范即服务"能力。调研显示，业界已有4,400+规则的共享库（skills-hub.ai）和60,000+项目采用AGENTS.md标准
[^70]
[^71]，AgentHub可以成为这些开放标准的最佳实践展示平台，让规范生成成为产品核心竞争力。

#### 2.6.4 Coze生态集成：与扣子平台深度联动

Coze生态集成是AgentHub面向字节跳动评审的"隐性加分项"。三位评审导师均来自扣子（Coze）核心业务部门，展示AgentHub与Coze生态的集成价值会直接引起评审的共鸣
[^72]。集成功能包括：导入Coze
Agent------用户可以将扣子平台上已发布的Agent导入到AgentHub中使用；发布到Coze------用户在AgentHub中创建的Agent可以一键发布到扣子平台；数据互通------AgentHub中的对话产物可以与扣子空间的数据互通；工作流复用------支持调用扣子工作流作为后端编排逻辑。即使MVP阶段只实现基础的Coze
Agent导入功能，也足以展示对字节AI产品矩阵的深度理解。

## 3. 非功能需求

### 3.1 性能需求

#### 3.1.1 消息响应延迟：\<500ms（非AI消息），AI首token \<2s

性能指标直接影响用户体验。非AI消息（如已读回执、状态同步、打字指示器）的响应延迟必须低于500ms，这是IM体验的基础门槛。AI消息的延迟分为两个指标：首token延迟（从用户发送消息到Agent返回第一个token的时间）不超过2秒，这取决于Agent
API的响应速度；完整响应时间（从首token到最终token）取决于任务复杂度，简单问答应在5秒内完成，代码生成类任务可接受30-60秒。为优化AI响应体验，系统采用SSE流式传输逐token渲染，用户在等待期间可以看到Agent正在"打字"
。同时引入experimental_throttle参数（100ms批处理更新），在复杂应用中防止React重渲染跟不上流式事件
[^73]。

#### 3.1.2 支持同时在线会话数：\>=10个并行对话

系统需要支持至少10个并行对话窗口同时保持活跃状态。每个活跃会话维护独立的WebSocket连接和消息队列，前端使用Zustand的模块化store管理会话状态，通过选择器优化确保单个会话的消息更新不会触发其他会话的重渲染
。消息分页采用cursor-based
pagination，首次加载获取最新消息，向上滚动时按需加载历史消息
。会话列表按最近活跃时间排序，未读计数由服务端计算后增量推送。

### 3.2 用户体验需求

#### 3.2.1 UI体验对标Lovable/V0：现代化、低饱和度配色、清晰层次

UI体验占评审权重的20%，直接对标Lovable、V0等一线AI编程产品的视觉水准。设计原则包括：现代化------采用目前主流的极简主义设计风格，减少UI元素让AI生成的内容成为焦点
[^74]
；低饱和度配色------参考Lovable的品牌紫和V0的Vercel黑+蓝，AgentHub主色调采用紫灰色系（`#7B6D8D`），辅助色为浅灰色系（`#B8A9C9`），整体低饱和度避免视觉疲劳；清晰层次------通过阴影、间距和字体大小区分信息层级，确保用户一眼就能识别会话列表、聊天区域和产物预览的边界。深色模式为默认主题（所有主要AI工具都默认或支持深色模式），同时提供浅色模式切换
。

#### 3.2.2 交互流畅度：消息动画、打字机效果、加载状态

交互细节决定产品质感。消息动画------新消息到达时平滑滚动到底部，有淡入动画效果；打字机效果------AI响应采用流式逐字渲染，配合闪烁光标模拟真实打字体验；加载状态------Agent思考中显示"...正在思考"的脉冲动画，代码生成中显示进度条；骨架屏------会话列表和消息历史加载时显示骨架屏占位，避免白屏等待。这些微交互的设计目标是让用户感受到系统的"生命力"，减少等待的焦虑感。竞品分析表明，Lovable和v0在交互流畅度上的投入是其高用户留存的关键因素之一
。

### 3.3 安全需求

#### 3.3.1 API Key安全存储：不暴露用户敏感信息

用户的API Key（如火山方舟API Key、Claude API
Key等）必须进行安全存储。存储方案采用服务端加密（AES-256）存储，前端永不直接暴露API
Key。所有Agent API调用通过AgentHub后端代理转发，避免将API
Key发送到客户端。API
Key的输入在界面中以密码框形式展示（掩码显示），支持测试连接功能验证Key有效性。遵循最小权限原则------每个API
Key只申请必要的权限范围，避免使用具有过高权限的Key。

#### 3.3.2 代码沙箱：预览环境隔离执行

Agent生成的代码在预览时必须在隔离环境中执行，防止XSS攻击和恶意代码。方案采用iframe沙箱（sandbox属性限制脚本权限）+
内容安全策略（CSP）双重保护
。对于需要执行后端代码的场景（如Node.js脚本），使用WebAssembly沙箱或云端Docker容器隔离执行。用户数据和系统数据严格隔离，Agent生成的产物存储在用户独立的数据空间中，不允许跨用户访问。

### 3.4 可扩展性需求

#### 3.4.1 新Agent接入成本：通过配置而非代码扩展

AgentHub的扩展性核心在于"新Agent接入零代码化"。新Agent的接入不应需要修改源代码，而是通过配置完成：填写Agent名称、System
Prompt、能力标签、API端点、认证信息等配置项，系统即可自动生成对应的Provider适配器。适配器层采用Provider
Pattern设计，新Provider只需实现标准接口（sendMessage、streamResponse、getCapabilities等）即可接入
[^75]。能力注册和发现机制类似A2A的Agent
Cards概念------每个Agent在接入时注册自己的能力清单，Orchestrator在调度时根据能力匹配进行路由
。

#### 3.4.2 插件化架构：预留MCP和A2A协议接口

AgentHub的架构设计需要预留标准化协议接口，以适应快速发展的Agent生态。MCP（Model
Context Protocol）接口------预留MCP
Client的集成点，支持Agent通过标准协议调用外部工具
；A2A（Agent-to-Agent）接口------预留Agent间通信的标准协议接口，支持未来与其他Agent平台的互联互通。三层协议栈的集成策略：MCP覆盖工具层（单个API调用）、ACP覆盖IDE层（编辑器集成）、A2A覆盖Agent间层（多Agent协作通信）。通过成为这些开放标准的早期采用者，AgentHub可以建立长期的技术领先性和生态兼容性。

## 4. 需求优先级矩阵

### 4.1 P0（必须完成）

#### 4.1.1 IM核心体验 + Orchestrator基本功能 + 2个Agent接入

P0是MVP的底线，必须在第一阶段（Day
1-14）全部完成，确保有一个可演示的端到端Demo。

  -------------------------------------------------------------------------------
  P0需求项                验收标准                           最晚完成时间
  ----------------------- ---------------------------------- --------------------
  WebSocket实时通信       消息收发延迟\<500ms，支持SSE流式   Day 7

  对话列表管理            新建/置顶/归档/搜索功能可用        Day 5

  单聊模式                1v1与Agent对话，流式响应正常       Day 7

  群聊@协作               \@Agent触发协作，Agent依次回复     Day 12

  Orchestrator任务拆解    复杂任务可拆解为2+子任务           Day 10

  OrchestratorAgent调度   子任务可路由到对应Agent执行        Day 12

  2个Agent接入            Claude Code + Codex/OpenCode可用   Day 10

  消息类型支持            文本+代码块+图片+文件              Day 8

  基础上下文管理          聊天历史自动传递                   Day 9
  -------------------------------------------------------------------------------

P0功能的核心验收标准是：用户可以完成一个完整的"提出问题→多Agent协作→产出生成"的端到端流程，且体验流畅无阻塞。这是Demo演示的最低要求，也是功能完整度评分（25%）的基础。

### 4.2 P1（应该完成）

#### 4.2.1 产物预览编辑 + 部署功能 + 上下文管理

P1功能在第二阶段（Day
12-21）实现，显著提升产品的完整度和惊艳度，直接影响生成效果质量评分（20%）。

  -------------------------------------------------------------------------
  P1需求项             验收标准                        预期完成时间
  -------------------- ------------------------------- --------------------
  内联预览（iframe）   Agent生成的网页可在聊天中预览   Day 14

  全屏代码编辑器       Monaco Editor集成，支持语法高亮 Day 15

  Diff视图             代码变更对比，一键应用          Day 16

  版本历史             产物版本快照和回溯              Day 17

  对话式编辑           选中代码→描述修改→应用          Day 18

  部署功能             聊天中"部署"触发预览URL生成     Day 19

  Pin消息上下文        关键消息可pin为长期上下文       Day 16
  -------------------------------------------------------------------------

P1功能的完成度直接决定了Demo的"哇"效应------当评委看到Agent生成的网页直接在聊天中预览、Diff视图一键应用代码变更、部署指令秒级响应时，产品的技术实力和产品感会留下深刻印象。

### 4.3 P2（加分项）

#### 4.3.1 Agent市场 + MCP集成 + 协作规范自动生成 + Coze联动

P2功能是第三阶段（Day
15-21，时间允许）的加分项，不追求完整实现，展示概念和基础框架即可，主要服务于创新与产品感评分（10%）和AI协作能力评分（30%）。

  -----------------------------------------------------------------------------------
  P2需求项               目标展示效果                         与评审权重关联
  ---------------------- ------------------------------------ -----------------------
  Agent市场              可浏览预设Agent列表，Mock安装流程    创新+产品感

  MCP工具集成            Agent可调用的外部工具展示            技术前瞻性

  **协作规范自动生成**   **对话中生成Spec/Skill/Rules卡片**   **AI协作能力（30%）**

  Coze生态集成           Coze Agent导入入口（概念展示）       生态关联度
  -----------------------------------------------------------------------------------

其中**协作规范自动生成（2.6.3节）**是P2中的最高优先级，因为它直接对应30%权重的AI协作能力评审维度。即使只实现最基础的版本------在群聊协作后生成一个简单的AGENTS.md规范卡片------也足以展示对协作规范体系的理解和实践。调研洞察明确指出："投入30%的开发时间在协作规范体系的设计和自动化生成上，这是性价比最高的冠军策略"
。

优先级矩阵的整体策略遵循"MVP优先、演示导向"原则
------所有功能开发围绕"3分钟Demo如何展示"展开。P0保证"故事完整"，P1保证"体验惊艳"，P2保证"差异化记忆"。2人团队在20天内的资源分配建议为：60%时间投入P0、25%投入P1、15%投入P2，确保在有限时间内最大化评审得分。

[^1]:  Github. https://github.com/WayneEcon/Antigravity-Manager_158

[^2]:  arXiv.org. https://arxiv.org/html/2603.13417v1

[^3]:  hirefullstackdeveloperindia.com.
    https://hirefullstackdeveloperindia.com/react-vs-vuejs

[^4]:  CSDN博客.
    https://blog.csdn.net/u010554324/article/details/149661022

[^5]:  lovable.dev. https://lovable.dev/guides/lovable-vs-bolt-vs-v0

[^6]:  Github.
    https://github.com/holzerjm/civichacks-demo/blob/main/RESOURCES.md

[^7]:  Nuvox AI.
    https://nuvox-ai.com/anthropic-claude-complete-technical-architecture-guide-2025/

[^8]:  DEV Community.
    https://dev.to/eclaw/a2a-research-digest-20260315-security-analysis-and-protocol-comparison-1nck

[^9]:  搜狐. https://www.sohu.com/a/980529635_122483063

[^10]:  arXiv.org. https://arxiv.org/pdf/2509.08646?

[^11]:  arXiv.org. https://www.arxiv.org/pdf/2508.05294v4

[^12]:  arXiv.org. https://arxiv.org/html/2504.21030v1

[^13]:  codeant.ai.
    https://www.codeant.ai/blogs/best-ai-code-editor-cursor-vs-windsurf-vs-copilot

[^14]:  April 20, 2026. https://toolcrush.io/blog/lovable-review-2026

[^15]:  Trustpilot. https://www.trustpilot.com/review/lovable.dev

[^16]:  CheckThat.ai. https://checkthat.ai/brands/lovable/alternatives

[^17]:  vicky.dev. https://vicky.dev/lovable-ai-review-2026-pros-cons/

[^18]:  portkey.ai.
    https://portkey.ai/blog/open-ai-responses-api-vs-chat-completions-vs-anthropic-anthropic-messages-api

[^19]:  火山引擎. https://www.volcengine.com/docs/82379/1449737?lang=zh

[^20]:  tianpan.co.
    https://tianpan.co/blog/2026-04-16-stateful-conversations-database-scale-session-store

[^21]:  boxsoftware.net.
    https://www.boxsoftware.net/how-to-implement-cursor-based-pagination-in-a-rest-api-with-node-js/

[^22]:  DEV Community.
    https://dev.to/elasticpath/improving-paging-performance-with-large-data-exports-5ccb

[^23]:  DEV Community.
    https://dev.to/whoffagents/vercel-ai-sdk-usechat-in-production-streaming-errors-and-the-patterns-nobody-writes-about-4ecf

[^24]:  Vercel. https://vercel.com/academy/ai-sdk/basic-chatbot

[^25]:  Blink. https://blink.new/blog/claude-code-plan-mode-guide

[^26]:  Code With Mukesh.
    https://codewithmukesh.com/blog/plan-mode-claude-code/

[^27]:  lobehub.com. https://lobehub.com/de/changelog/2026-01-27-v2

[^28]:  AI Tech Connect.
    https://aitechconnect.in/news/multi-agent-orchestration-langgraph-memory

[^29]:  focused.io.
    https://focused.io/lab/multi-agent-orchestration-in-langgraph-supervisor-vs-swarm-tradeoffs-and-architecture

[^30]:  systemdesignhandbook.com.
    https://www.systemdesignhandbook.com/guides/design-a-chat-system/

[^31]:  TrueConf.
    https://trueconf.com/blog/reviews-comparisons/chat-app-system-design

[^32]:  Preprints. https://www.preprints.org/manuscript/202604.2147

[^33]:  is4.ai.
    https://is4.ai/blog/our-blog-1/openai-api-vs-anthropic-api-comparison-117

[^34]:  Useful Functions.
    https://www.usefulfunctions.co.uk/2025/11/08/state-management-2024-redux-zustand-context/

[^35]:  CSDN博客.
    https://blog.csdn.net/weixin_29012765/article/details/158295628

[^36]:  assistant-ui.com. https://www.assistant-ui.com/docs/ui/markdown

[^37]:  Github. https://github.com/AmazingAng/auth2api

[^38]:  Github. https://github.com/enescingoz/claude-code-gateway

[^39]:  lovable.dev.
    https://lovable.dev/guides/ux-process-design-for-non-designers

[^40]:  01.me. https://01.me/en/2026/02/moltbook/

[^41]:  Black Hills Information Security.
    https://www.blackhillsinfosec.com/model-context-protocol/

[^42]:  比邻.
    https://eastondev.com/blog/en/posts/ai/20260205-openclaw-architecture-guide/

[^43]:  Anthropic. https://anthropic.com/news/model-context-protocol

[^44]:  DEV Community.
    https://dev.to/eclaw/a2a-research-digest-20260312-75a

[^45]:  modelcontextprotocol.info.
    https://modelcontextprotocol.info/specification/

[^46]:  AI Notes.
    https://notes.muthu.co/2026/03/mixture-of-agents-building-collaborative-llm-pipelines-that-outperform-any-individual-model/

[^47]:  CallSphere.
    https://callsphere.ai/blog/building-mixture-of-agents-system-combining-multiple-llms-superior-output

[^48]:  coze.cn.
    https://www.coze.cn/open/docs/dev_how_to_guides/realtime_android

[^49]:  K21Academy.
    https://k21academy.com/agentic-ai/agentic-ai-protocols-comparison/

[^50]:  Github. https://github.com/orgs/community/discussions/185521

[^51]:  DEV Community.
    https://dev.to/eclaw/a2a-research-digest-20260313-survey-of-agent-interoperability-protocols-5af1

[^52]:  Space & Story.
    http://spaceandstory.co/blog/model-context-protocol-mcp

[^53]:  youngju.dev.
    https://www.youngju.dev/blog/ai-platform/langgraph_agent_workflow_guide.en

[^54]:  iBuidl.org.
    https://ibuidl.org/blog/mcp-model-context-protocol-guide-2026-20260310

[^55]:  themoonlight.io.
    https://www.themoonlight.io/zh/review/llm-rosetta-a-hub-and-spoke-intermediate-representation-for-cross-provider-llm-api-translation

[^56]:  Bilt. https://bilt.me/blog/ai-full-stack-app-builder

[^57]:  lovable.dev. https://docs.lovable.dev/integrations/supabase

[^58]:  AI App - Landlord & Rental Management.
    https://www.zite.com/blog/bolt-ai-pricing

[^59]:  cnbugs.com. https://www.cnbugs.com/post-7091.html

[^60]:  Microsoft Learn.
    https://learn.microsoft.com/en-us/microsoft-copilot-studio/agent-extend-action-mcp

[^61]:  36kr.com. https://eu.36kr.com/zh/p/3713736075636867

[^62]:  Hosted Deployment \| Server Compass.
    https://servercompass.app/blog/server-compass-vs-coolify-best-self-hosted-deployment-tools-in-2025

[^63]:  lobehub.com.
    https://lobehub.com/zh/skills/serendipityoneinc-srp-claude-code-marketplace-cloudflare-pages

[^64]:  Agent Skills. https://agentskills.io/home

[^65]:  DEV Community.
    https://dev.to/themachinepulse/do-you-need-state-management-in-2025-react-context-vs-zustand-vs-jotai-vs-redux-1ho

[^66]:  cursor.com.
    https://forum.cursor.com/t/how-can-i-apply-ai-generated-changes-only-to-specific-code-lines-ive-selected/20894

[^67]:  jiangren.com.au.
    https://jiangren.com.au/blog/cursor-guide-07-rules-mdc-deep

[^68]:  Vibe Coding Academy.
    https://www.vibecodingacademy.ai/blog/cursor-rules-complete-guide

[^69]:  serghei.pl. https://blog.serghei.pl/posts/agent-skills-101/

[^70]:  skills-hub.ai. https://skills-hub.ai/cursor-rules

[^71]:  DeployHQ.
    https://www.deployhq.com/blog/ai-coding-config-files-guide

[^72]:  稀土掘金. https://juejin.cn/post/7571475192489951242

[^73]:  Zenn.
    https://zenn.dev/coji/articles/vercel-ai-sdk-streaming-backpressure?locale=en

[^74]:  capacity.so. https://capacity.so/blog/what-is-v0-dev

[^75]:  ResearchGate.
    https://www.researchgate.net/publication/396678686_The_Model_Context_Protocol_MCP_Emergence_Technical_Architecture_and_the_Future_of_Agentic_AI_Infrastructure
