# AgentHub 调研笔记 - 团队共享知识库

## 一、比赛参考信息

### 1.1 第一届AI全栈黑客松评分标准（高参考价值）
| 维度 | 基础满分(P0) | 进阶满分(含P1) | 总满分 |
|:---|---:|---:|---:|
| A 文档完整性与可复现性 | 11 | 15 | 15 |
| B 功能实现完整度 | 20 | 25 | 25 |
| C 可视化创新性 | 6 | 13 | 13 |
| D Agent架构设计 | 15 | 20 | 20 |
| E 代码质量与工程规范 | 10 | 17 | 17 |
| F 创新与自由发挥 | - | - | 10 |
| **合计** | **62** | **90** | **100** |

### 1.2 提交要求
- GitHub仓库链接（Public）
- 在线部署链接（公网可访问）
- 核心评分文档：`docs/Agent架构说明.md`
- P2技术报告（选填，最高+15分）

---

## 二、核心竞品深度分析

### 2.1 AutoGen (Microsoft)
| 维度 | 内容 |
|:---|:---|
| 定位 | 多Agent对话框架，支持Agent间自主对话 |
| 架构 | 对话驱动，Agent可自由组建群聊 |
| 亮点 | 内置GroupChat、RoundRobin、Selector等调度策略 |
| 协议 | 自定义消息协议 |
| 可借鉴 | 群聊调度策略、Agent角色定义 |

### 2.2 CrewAI
| 维度 | 内容 |
|:---|:---|
| 定位 | 基于角色的多Agent编排框架 |
| 架构 | Role-Based，Agent有明确角色和工具 |
| 亮点 | 任务流程化（Process: Sequential/Hierarchical） |
| 协议 | 自定义 |
| 可借鉴 | 角色体系、任务编排流程 |

### 2.3 LangGraph
| 维度 | 内容 |
|:---|:---|
| 定位 | 状态机驱动的多Agent框架（LangChain生态） |
| 架构 | 图结构（Graph），节点=Agent/工具，边=条件路由 |
| 亮点 | 可视化流程图、状态持久化、人机交互节点 |
| 协议 | LangChain标准 |
| 可借鉴 | 状态机编排、可视化工作流 |

### 2.4 OpenAI Swarm
| 维度 | 内容 |
|:---|:---|
| 定位 | 轻量级多Agent协作框架 |
| 架构 | 极简设计，Handoff机制实现Agent切换 |
| 亮点 | 代码极简（<100行核心），易于理解 |
| 协议 | 自定义 |
| 可借鉴 | Handoff机制、轻量级设计哲学 |

### 2.5 Agent TARS (字节跳动开源)
| 维度 | 内容 |
|:---|:---|
| 定位 | 多模态Agent框架，支持GUI操作 |
| 架构 | 三层：交互层(CLI/Web) + 执行层(Planner+Executor) + 事件总线(Event Stream) |
| 亮点 | Event Stream驱动、MCP协议、Visual Grounding、AIO Sandbox |
| 协议 | MCP（工具接入标准） |
| 可借鉴 | **Event Stream架构**、MCP协议集成、双入口设计、沙箱隔离 |

### 2.6 Claude.Orchestrator
| 维度 | 内容 |
|:---|:---|
| 定位 | Claude Code生态的多Agent编排工具 |
| 架构 | .NET全局工具，共享上下文管理 + 工作流持久化 |
| 亮点 | 上下文分层（session/project/global）、YAML工作流、断点续传 |
| 协议 | 文件系统共享上下文 |
| 可借鉴 | 上下文分层模型、工作流模板化、RBAC安全模型 |

### 2.7 Agentwise
| 维度 | 内容 |
|:---|:---|
| 定位 | 多Agent编排系统，8+专业Agent并行 |
| 架构 | 用户交互层 + 编排调度层 + 专业Agent层 + 工具集成层 + 知识管理层 |
| 亮点 | 27+ MCP服务器、实时WebSocket仪表板、自学习知识库 |
| 协议 | MCP |
| 可借鉴 | Agent-工具绑定策略、实时可观测性、命令DSL |

### 2.8 Coze/扣子 (字节跳动)
| 维度 | 内容 |
|:---|:---|
| 定位 | 零代码Agent开发平台 |
| 架构 | 拖拽式工作流 + 多Agent模式 + 插件生态 |
| 亮点 | 多Agent模式（主Agent+子Agent）、全渠道发布 |
| 协议 | 自定义插件协议 |
| 可借鉴 | 多Agent连接配置、IM式交互体验 |

### 2.9 TRAE (字节跳动AI IDE)
| 维度 | 内容 |
|:---|:---|
| 定位 | AI原生IDE，智能任务拆解+全流程开发 |
| 架构 | 多模型协同 + Builder模式 + Chat模式 |
| 亮点 | 自然语言编程、全流程自动化 |
| 关联 | 比赛中强调"TRAE协作"能力 |
| 可借鉴 | AI辅助开发工作流、Builder+Chat双模式 |

---

## 三、关键技术方案

### 3.1 多Agent通信协议
| 协议 | 说明 | 适用场景 |
|:---|:---|:---|
| **A2A (Agent-to-Agent)** | Google 2025年发布，Linux Foundation托管，150+组织支持 | 跨平台Agent互操作 |
| **MCP (Model Context Protocol)** | Anthropic提出，工具接入标准 | 工具生态集成 |
| **自定义Event Stream** | Agent TARS采用，WebSocket/API暴露 | 实时状态同步 |

### 3.2 IM聊天UI组件库
| 项目 | 特点 |
|:---|:---|
| **TDesign Chat** | 腾讯开源，React/Vue双端，useChat Hook，内置消息流 |
| **ChatUI (阿里)** | 企业级对话UI，丰富组件、主题定制、无障碍设计 |
| **react-chat-ui** | 轻量级，自动滚动、多用户分组 |

### 3.3 代码Diff展示
| 方案 | 特点 |
|:---|:---|
| **Monaco Editor Diff** | VS Code内核，功能强大，支持语法高亮 |
| **react-diff-viewer** | React组件，轻量，GitHub风格 |

### 3.4 网页预览
| 方案 | 特点 |
|:---|:---|
| **iframe + SandBox** | 标准方案，srcdoc加载HTML |
| **WebContainer (StackBlitz)** | 在浏览器运行Node.js，支持npm install |

### 3.5 一键部署
| 方案 | 特点 |
|:---|:---|
| **Vercel API** | 零配置部署前端 |
| **Docker + docker-compose** | 容器化一键部署 |
| **魔搭创空间** | 字节生态，免费CPU |

---

## 四、创新点参考方向

1. **Event Stream驱动的实时协作** - 借鉴Agent TARS，所有Agent行为序列化为Event流
2. **MCP生态统一适配** - 将Claude Code、Codex等通过MCP协议统一接入
3. **A2A协议兼容** - 支持跨平台Agent互操作
4. **可视化Agent编排** - 类似LangGraph的图编辑界面
5. **智能上下文压缩** - Agent间通信的上下文智能管理
6. **成本透明仪表板** - 实时展示Token消耗、响应时间
7. **自学习Agent画像** - Agent从协作历史中学习能力边界

---

*调研时间：2026-05-17*
*收集人：齐活林（主理人）*
