# AgentHub 技术设计文档

## 1. 系统架构总览

### 1.1 整体架构

AgentHub
采用五层分层架构，从用户界面到外部Agent平台形成清晰的职责边界。前端层基于Next.js
15提供IM聊天界面和产物预览能力；API网关层负责统一认证、限流和路由分发；业务服务层承载会话管理、消息处理、Agent调度和部署编排等核心逻辑；Agent适配层通过统一接口屏蔽多平台API差异；外部平台层对接Claude
Code、Codex、OpenCode等主流Agent平台以及火山方舟、扣子Coze等字节跳动生态服务。

五层架构的设计遵循松耦合、插件化、协议驱动和事件溯源四大核心原则。松耦合体现在层与层之间仅通过定义良好的接口交互，任何一层的实现替换不影响其他层；插件化体现在Agent适配器以插件形式注册，新增Agent平台只需实现标准接口即可接入
[^1]；协议驱动体现在统一适配器层内部采用LLM-Rosetta验证的Hub-and-Spoke
IR架构，将O(N\^2)的适配复杂度降为O(N)
[^2]；事件溯源体现在所有消息和状态变更以不可变事件流形式存储，支持任意时间点的状态回溯。

    +--------------------------------------------------------------+
    |  前端层 (Next.js 15 + React 19 + shadcn/ui)                   |
    |  IM聊天界面 / 产物预览 / Diff编辑 / 部署管理                     |
    +--------------------------------------------------------------+
    |  API网关层 (FastAPI + WebSocket/SSE)                          |
    |  JWT认证 / 限流 / 路由 / 请求转换                              |
    +--------------------------------------------------------------+
    |  业务服务层 (Python + LangGraph + PostgreSQL)                 |
    |  会话服务 / 消息服务 / Orchestrator / 部署服务 / 产物服务        |
    +--------------------------------------------------------------+
    |  Agent适配层 (统一适配器 + MCP + A2A)                          |
    |  Claude Code适配器 / Codex适配器 / OpenCode适配器 / 扩展接口    |
    +--------------------------------------------------------------+
    |  外部平台层 (Anthropic / OpenAI / Coze / 火山方舟)            |
    |  Claude Code API / Codex CLI API / Coze API / 方舟API         |
    +--------------------------------------------------------------+

#### 1.1.1 分层架构图

数据流在AgentHub中呈现"双轨制"特征。用户发送的消息通过WebSocket实时到达业务服务层，经Orchestrator分析后分发到适配层调用外部Agent；Agent的响应则通过SSE流式返回前端，实现逐字渲染的交互体验
[^3]
[^4]。产物数据（代码、Diff、部署状态）作为消息的特殊内容类型，在同一通道中传输但经产物服务解析后存储到独立表，便于后续版本管理和预览。

#### 1.1.2 核心设计原则

四个设计原则的具体落地方案如下：松耦合通过依赖注入和服务接口实现，每个业务服务仅依赖抽象接口而非具体实现；插件化通过Provider
Registry模式实现，适配器在启动时注册到Registry，运行时通过能力标签动态匹配
[^5]；协议驱动通过定义统一的消息IR（Intermediate
Representation）实现，所有Agent平台的请求和响应先转换为IR再进行内部流转
；事件溯源通过PostgreSQL的JSONB字段存储消息内容和元数据变更历史，配合Redis发布订阅实现实时同步
[^6]。

### 1.2 技术栈选型

#### 1.2.1 前端技术栈

  -------------------------------------------------------------------------------------------------------------------------
  技术组件         选型                          选型理由                                                  调研依据
  ---------------- ----------------------------- --------------------------------------------------------- ----------------
  框架             Next.js 15 + React 19         Server                                                    dim09
                                                 Components减少客户端JS体积，Turbopack开发热更新提升10倍   
                                                 [^7]                                                      

  UI组件库         shadcn/ui + Tailwind CSS      109K Stars，组件复制到代码库无供应商锁定，AI              dim09
                                                 SDK官方模板标配 [^8]                                      

  状态管理         Zustand + TanStack Query      Zustand 1.2KB无Provider开销，TanStack                     dim01/dim09
                                                 Query处理服务端状态缓存 [^9]                              

  AI流式           Vercel AI SDK 5.x             100+模型统一API，每周200万+下载，useChat Hook简化流式开发 dim09
                                                 [^10]                                                     

  编辑器           \@monaco-editor/react         VS Code同款体验，内置DiffEditor，通过CDN懒加载控制体积    dim06
                                                 [^11]                                                     

  虚拟滚动         react-virtuoso                ResizeObserver自动处理动态高度，聊天场景零手动干预 [^12]  dim09

  Diff展示         react-diff-viewer-continued   周下载69万+，GitHub风格，split/inline双模式 [^13]         dim06

  预览             Sandpack + iframe沙箱         CodeSandbox开源，支持React/Vite/Node.js模板，HMR热重载    dim06
                                                 [^14]                                                     
  -------------------------------------------------------------------------------------------------------------------------

前端技术栈的选择经过三个维度的权衡：开发效率（20天2人团队的硬性约束）、生态成熟度（AI聊天领域的最佳实践验证）和差异化能力（定制UI体验的冠军策略需求）。React
19 + Next.js
15的组合在AI聊天领域已被Vercel官方模板、CopilotKit和LobeChat等顶级开源项目验证
[^15] [^16]。shadcn/ui相比Ant Design
v5提供了更强的定制灵活性，这对于追求差异化UI体验的冠军项目至关重要。需要特别指出的是，Arco
Design已实质停摆，字节跳动内部已转向Semi Design
[^17]，因此AgentHub选择shadcn/ui而非字节系组件库，以确保组件库的长期可维护性。

#### 1.2.2 后端技术栈

后端采用Python +
FastAPI作为Web框架，LangGraph作为Agent编排引擎，PostgreSQL作为主数据库，Redis作为缓存和消息代理。选择Python而非Node.js的原因是：LangGraph是Python生态的Agent编排框架业界标准（28K
Stars） [^18]，与火山方舟API的集成文档也以Python为主
[^19]。FastAPI相比Django或Flask提供了原生的async支持和自动API文档生成，对于需要处理大量SSE连接的AI聊天场景尤为适合。

PostgreSQL被选为主数据库的核心原因在于其对JSONB的原生支持，可以灵活存储消息内容（包含多种类型的MessageContent数组）和Agent配置，同时保持ACID事务保证
。LobeChat从纯本地IndexedDB演进为PostgreSQL服务端存储的实践也验证了这一选型的可行性
。Redis用于会话列表缓存、在线状态Pub/Sub和消息未读计数，其亚毫秒读写和内置Pub/Sub能力完美匹配IM场景的实时性需求。

#### 1.2.3 AI模型

AgentHub的AI能力底座以火山方舟API为主，具体使用豆包Seed
2.0模型版本。火山方舟提供OpenAI兼容API
[^20]，这意味着AgentHub的所有LLM调用可以通过统一的OpenAI
SDK格式进行，大幅降低适配成本。Orchestrator的意图分析和任务拆解使用豆包Seed
2.0的强模型版本（对应GPT-4级别能力），子Agent的执行则根据任务复杂度选择不同模型尺寸，实现"强模型做规划、经济模型做执行"的成本优化策略
[^21]。

兼容层设计方面，AgentHub通过统一适配器层同时支持火山方舟（OpenAI兼容）、Anthropic
Messages API和OpenAI Responses API三种格式。LLM-Rosetta的Hub-and-Spoke
IR架构提供了理论支撑：所有外部API请求先转换为IR，内部处理完成后根据需要再转换为目标格式，往返转换中位数低于80微秒
。

### 1.3 部署架构

#### 1.3.1 开发环境

开发环境使用Docker
Compose一键启动全部依赖（PostgreSQL、Redis、后端服务、前端开发服务器），确保前后端开发者在Day
1即可拥有完整的本地开发环境。`docker-compose.dev.yml`定义了四个服务：postgres（14-alpine）、redis（7-alpine）、backend（FastAPI热重载模式）、frontend（Next.js开发服务器），前后端代码通过volume挂载实现修改即时生效。

#### 1.3.2 演示环境

演示环境采用前后端分离部署策略。前端部署在Vercel，利用其全球CDN和边缘网络保证静态资源的快速加载，同时与Next.js的深度集成提供了最优的Server
Components渲染性能。后端部署在Railway或Render，提供Python运行环境、PostgreSQL数据库和Redis实例的托管服务。这种部署方案的优势在于：零运维成本（免费额度完全覆盖演示需求）、自动HTTPS、全球CDN加速，且Vercel前端可以直接调用Railway后端的API（通过CORS配置）。演示环境的部署流程通过GitHub
Actions自动化，每次push到main分支即触发重新构建和部署。

## 2. 前端架构设计

### 2.1 项目结构

#### 2.1.1 Next.js App Router目录结构

AgentHub前端采用Next.js 15 App
Router模式，路由按功能模块划分为(chat)、(agents)、(preview)三个Route
Group。App Router的优势在于支持React Server
Components，可以将数据获取逻辑放在服务端执行，减少客户端JavaScript体积
[^22]。

    app/
      (chat)/                     # 聊天主界面路由组
        layout.tsx                # 聊天布局（侧边栏+主区域）
        page.tsx                  # 默认路由重定向
        [sessionId]/              # 具体会话页面
          page.tsx
      (agents)/                   # Agent管理路由组
        layout.tsx
        page.tsx                  # Agent列表
        new/                      # 新建Agent
          page.tsx
      (preview)/                  # 产物预览路由组
        artifact/[id]/
          page.tsx
      api/                        # API路由（Server Actions）
        auth/
        sessions/
        messages/
        agents/
      layout.tsx                  # 根布局
      globals.css                 # 全局样式

    components/
      ui/                         # shadcn/ui基础组件
      chat/                       # 聊天相关组件
        ChatLayout.tsx
        ChatList.tsx
        ChatWindow.tsx
        ChatInput.tsx
        MessageRenderer.tsx
        MessageTypes/
      agents/                     # Agent相关组件
      preview/                    # 预览相关组件
      shared/                     # 共享组件

    hooks/                        # 自定义Hooks
    lib/                          # 工具函数和API客户端
    stores/                       # Zustand状态管理
    types/                        # TypeScript类型定义

#### 2.1.2 模块划分

前端模块按业务功能划分为IM模块、Agent模块、预览模块、部署模块和设置模块五大块。IM模块是最核心的模块，包含会话列表、聊天窗口、消息输入和消息渲染四个子模块，占前端开发工作量的约50%。Agent模块负责Agent的CRUD管理和能力展示。预览模块处理代码编辑器、Diff视图和网页预览的渲染。部署模块负责部署状态卡片的展示和部署进度推送的接收。设置模块管理用户偏好和API
Key配置。

### 2.2 状态管理设计

#### 2.2.1 Zustand Store设计

状态管理采用Zustand + TanStack
Query的双层架构，遵循2025年状态管理的最佳实践：服务端状态由TanStack
Query统一管理，客户端UI状态由Zustand管理
。这种分离避免了将API数据缓存逻辑混入全局状态管理的常见问题。

    // stores/chatStore.ts
    import { create } from 'zustand';
    import { immer } from 'zustand/middleware/immer';

    interface ChatState {
      activeSessionId: string | null;
      sidebarOpen: boolean;
      streamingMessageIds: Set<string>;
      setActiveSession: (id: string | null) => void;
      toggleSidebar: () => void;
      addStreamingMessage: (id: string) => void;
      removeStreamingMessage: (id: string) => void;
    }

    export const useChatStore = create<ChatState>()(
      immer((set) => ({
        activeSessionId: null,
        sidebarOpen: true,
        streamingMessageIds: new Set(),
        setActiveSession: (id) => set({ activeSessionId: id }),
        toggleSidebar: () => set((state) => { state.sidebarOpen = !state.sidebarOpen; }),
        addStreamingMessage: (id) => set((state) => { state.streamingMessageIds.add(id); }),
        removeStreamingMessage: (id) => set((state) => { state.streamingMessageIds.delete(id); }),
      }))
    );

四个核心Zustand
Store的设计遵循职责单一原则：chatStore管理聊天UI状态（活跃会话、侧边栏开关、流式消息ID集合），agentStore管理Agent配置和在线状态，previewStore管理预览面板的状态（展开/折叠、当前查看的文件），authStore管理用户认证状态。通过immer中间件实现不可变更新的写法简化，避免深拷贝的样板代码
[^23]。

#### 2.2.2 TanStack Query配置

TanStack
Query负责所有服务端数据的获取和缓存，包括会话列表、消息列表和Agent列表。会话列表配置5分钟staleTime，用户切换会话时无需重复请求。消息列表使用无限查询（useInfiniteQuery）实现cursor-based分页，初始加载最新消息，用户向上滚动时自动加载历史消息
[^24] [^25]。

    // hooks/useMessages.ts
    export function useMessages(sessionId: string) {
      return useInfiniteQuery({
        queryKey: ['messages', sessionId],
        queryFn: ({ pageParam }) => fetchMessages(sessionId, pageParam),
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        initialPageParam: undefined as string | undefined,
        staleTime: 1000 * 60, // 1分钟
      });
    }

### 2.3 实时通信设计

#### 2.3.1 WebSocket连接管理

WebSocket用于双向实时通信：用户发送消息、打字指示器、已读回执和多设备状态同步。连接管理包含自动重连（指数退避策略，首次1秒重连，最大间隔30秒）、心跳检测（30秒间隔ping/pong）和消息队列（离线期间的消息在重连后批量发送）三大机制
[^26] [^27]。

    // hooks/useWebSocket.ts
    export function useWebSocket() {
      const wsRef = useRef<WebSocket | null>(null);
      const reconnectCount = useRef(0);
      const messageQueue = useRef<string[]>([]);
      
      const connect = useCallback(() => {
        const ws = new WebSocket(WS_URL);
        ws.onopen = () => {
          reconnectCount.current = 0;
          while (messageQueue.current.length > 0) {
            ws.send(messageQueue.current.shift()!);
          }
        };
        ws.onclose = () => {
          const delay = Math.min(1000 * 2 ** reconnectCount.current, 30000);
          setTimeout(connect, delay);
          reconnectCount.current++;
        };
        wsRef.current = ws;
      }, []);
      
      const sendMessage = useCallback((msg: WebSocketMessage) => {
        const json = JSON.stringify(msg);
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(json);
        } else {
          messageQueue.current.push(json);
        }
      }, []);
      
      return { connect, sendMessage, wsRef };
    }

#### 2.3.2 SSE流式处理

AI响应的流式传输通过SSE实现，Vercel AI SDK的useChat
Hook自动处理SSE连接管理、消息解析和增量渲染 [^28] [^29]。AgentHub在AI
SDK基础上扩展了自定义的事件类型：text_delta（文本增量）、tool_call（工具调用）、artifact_delta（产物增量）、status_change（状态变更）和error（错误）。前端根据事件类型将内容路由到对应的渲染组件------文本增量追加到消息气泡，产物增量更新代码编辑器内容，状态变更更新Agent状态指示器。

#### 2.3.3 消息协议

WebSocket消息采用统一的JSON格式，包含type、payload和timestamp三个字段。消息类型分为client_to_server（send_message、mark_read、typing_indicator）和server_to_client（new_message、message_update、agent_status、error）两大类。每条消息携带全局唯一的message_id（基于Snowflake算法），确保消息去重和排序一致性
。

### 2.4 组件架构

#### 2.4.1 聊天界面组件树

聊天界面采用经典的三栏布局：左侧会话列表（ChatList）、中间聊天区域（ChatWindow +
ChatInput）、右侧可选的预览/设置面板。ChatLayout作为布局容器负责响应式适配------桌面端三栏完整展示，平板端隐藏右侧面板，手机端仅展示活跃区域。

    ChatLayout
      ChatList (侧边栏)
        SessionSearch
        SessionGroups (置顶/普通/归档)
        SessionItem[]
      ChatWindow (主区域)
        ChatHeader
        MessageList (虚拟滚动)
          MessageRenderer[]
            TextMessage
            CodeMessage
            PreviewCard
            DiffCard
            DeployCard
        ChatInput
          Textarea (自动增高)
          AgentMention (@选择)
          ToolBar (附件/快捷操作)
      ChatPanel (右侧面板，可选)
        PreviewPanel
        AgentInfoPanel

#### 2.4.2 消息渲染组件

MessageRenderer是消息渲染的核心组件，根据消息的type字段分发到不同的子渲染器。文本消息使用react-markdown +
remark-gfm渲染GitHub风格的Markdown内容，代码块使用react-syntax-highlighter进行语法高亮
[^30]。产物卡片（PreviewCard）根据产物类型进一步分发：HTML产物渲染为iframe沙箱，代码产物渲染为Monaco
Editor只读模式，Diff产物渲染为react-diff-viewer对比视图。部署卡片（DeployCard）展示部署状态指示器、进度条和操作按钮，通过SSE接收实时状态更新。

#### 2.4.3 预览组件

预览组件分为三个层次。PreviewFrame基于iframe +
srcdoc实现简单HTML预览，sandbox属性限制为`allow-scripts allow-same-origin`，CSP头防止混合内容风险
[^31]。CodeEditor基于@monaco-editor/react，通过loader.config配置CDN加载减少打包体积，React.lazy +
Suspense实现懒加载 [^32]。DiffViewer在编辑场景使用Monaco
DiffEditor提供IDE级体验，在只读展示场景使用react-diff-viewer-continued提供轻量级对比
。Sandpack作为React/Vite项目的完整预览方案，按需引入以控制包体积 。

## 3. 后端架构设计

### 3.1 API设计

#### 3.1.1 RESTful API规范

AgentHub的RESTful
API遵循统一的规范设计：所有接口前缀为`/api/v1`，认证方式采用JWT Bearer
Token，响应格式统一为`{ code: number, data: any, message: string }`的结构。API版本号嵌入URL路径（`/api/v1/`），便于未来版本升级时保持向后兼容。认证中间件在每个受保护端点前校验JWT的有效性，并将解码后的用户ID注入请求上下文。

#### 3.1.2 核心API列表

  --------------------------------------------------------------------------------------------------
  方法            路径                              描述                             认证
  --------------- --------------------------------- -------------------------------- ---------------
  POST            /api/v1/auth/login                用户登录，返回JWT                否

  GET             /api/v1/sessions                  获取会话列表（支持搜索和分页）   是

  POST            /api/v1/sessions                  创建新会话                       是

  GET             /api/v1/sessions/{id}/messages    获取会话消息（cursor分页）       是

  POST            /api/v1/messages                  发送消息（触发Agent处理）        是

  GET             /api/v1/agents                    获取Agent列表                    是

  POST            /api/v1/agents                    创建自定义Agent                  是

  POST            /api/v1/agents/{id}/invoke        直接调用Agent                    是

  POST            /api/v1/deployments               创建部署                         是

  GET             /api/v1/deployments/{id}          获取部署状态                     是

  GET             /api/v1/artifacts/{id}            获取产物详情                     是

  POST            /api/v1/artifacts/{id}/versions   保存产物版本                     是
  --------------------------------------------------------------------------------------------------

核心API的设计围绕AgentHub的四大核心业务对象展开：Session（会话）、Message（消息）、Agent（Agent定义）和Artifact（产物）。发送消息API（POST
/api/v1/messages）是整个系统的核心入口，该端点接收用户消息后，将消息持久化并触发Orchestrator进行意图分析和任务分发。由于Agent处理可能是长时间运行的，API采用异步响应模式------立即返回消息ID，后续通过SSE推送处理进度和最终结果。

#### 3.1.3 WebSocket事件协议

WebSocket协议分为连接建立、消息发送、Agent调用和状态推送四类事件。连接建立时客户端发送`auth`事件携带JWT
Token进行认证，服务端响应`auth_success`或`auth_error`。消息发送时客户端发送`send_message`事件，服务端在消息处理的不同阶段推送`message_received`（已接收）、`message_processing`（处理中）、`message_stream`（流式内容）、`message_complete`（完成）和`message_error`（错误）事件。Agent调用状态通过`agent_status`事件推送，包含agent_id、status（idle/thinking/tool_calling/error）和当前任务描述。

### 3.2 数据模型设计

#### 3.2.1 ER图设计

AgentHub的数据模型围绕六个核心实体构建：User（用户）、Conversation（会话）、Message（消息）、Agent（Agent定义）、Artifact（产物）和Deployment（部署）。User与Conversation是多对多关系（通过participants关联表），Conversation与Message是一对多关系，Agent与Conversation是多对多关系（会话中的Agent参与者），Message与Artifact是一对多关系（一条消息可包含多个产物），Artifact与Deployment是一对多关系（一个产物可有多部署版本）。

#### 3.2.2 核心表结构

    -- 用户表
    CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        avatar_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- 会话表
    CREATE TABLE conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(255),
        type VARCHAR(20) CHECK (type IN ('single', 'group')),
        created_by UUID REFERENCES users(id),
        last_message_at TIMESTAMPTZ,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- 会话参与者表
    CREATE TABLE participants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
        role VARCHAR(20) DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
        last_read_sequence BIGINT DEFAULT 0,
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(conversation_id, user_id),
        UNIQUE(conversation_id, agent_id)
    );

    -- 消息表
    CREATE TABLE messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
        sender_type VARCHAR(20) CHECK (sender_type IN ('user', 'agent', 'system')),
        sender_id UUID NOT NULL,
        content JSONB NOT NULL DEFAULT '[]',
        type VARCHAR(30) DEFAULT 'text' CHECK (type IN ('text', 'code', 'image', 'file', 'web_preview', 'diff', 'tool_call', 'tool_result', 'artifact', 'deploy_status')),
        reply_to UUID REFERENCES messages(id),
        sequence BIGSERIAL,
        status VARCHAR(20) DEFAULT 'sent' CHECK (status IN ('sending', 'sent', 'delivered', 'read', 'error', 'stream')),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Agent表
    CREATE TABLE agents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        description TEXT,
        avatar_url TEXT,
        provider VARCHAR(50) NOT NULL CHECK (provider IN ('claude_code', 'openai_codex', 'opencode', 'custom', 'coze')),
        provider_config JSONB NOT NULL DEFAULT '{}',
        system_prompt TEXT,
        capabilities JSONB DEFAULT '[]',
        tools JSONB DEFAULT '[]',
        is_builtin BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- 产物表
    CREATE TABLE artifacts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
        conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
        type VARCHAR(30) NOT NULL CHECK (type IN ('code', 'html', 'markdown', 'diff', 'ppt', 'pdf')),
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        language VARCHAR(50),
        current_version INTEGER DEFAULT 1,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- 产物版本表
    CREATE TABLE artifact_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        artifact_id UUID REFERENCES artifacts(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        diff_from_prev TEXT,
        created_by VARCHAR(20) CHECK (created_by IN ('user', 'ai')),
        commit_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(artifact_id, version)
    );

    -- 部署表
    CREATE TABLE deployments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        artifact_id UUID REFERENCES artifacts(id),
        conversation_id UUID REFERENCES conversations(id),
        platform VARCHAR(30) NOT NULL CHECK (platform IN ('vercel', 'netlify', 'github_pages', 'docker')),
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'building', 'deploying', 'ready', 'error', 'rolled_back')),
        target_url TEXT,
        deploy_config JSONB DEFAULT '{}',
        logs TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- 索引
    CREATE INDEX idx_messages_conversation_seq ON messages(conversation_id, sequence DESC);
    CREATE INDEX idx_messages_created_at ON messages(conversation_id, created_at DESC);
    CREATE INDEX idx_conversations_last_message ON conversations(last_message_at DESC);
    CREATE INDEX idx_artifacts_conversation ON artifacts(conversation_id);
    CREATE INDEX idx_deployments_conversation ON deployments(conversation_id);

数据模型的设计重点在于JSONB字段的灵活运用。消息的content字段存储结构化的MessageContent数组，每个元素包含type、content和metadata，支持文本、代码块、图片、文件附件、Diff、工具调用结果等多种内容类型的混合排列
。Agent的provider_config字段存储平台特定的配置（如API密钥引用、模型选择、温度参数），通过JSONB的灵活性避免为每种Agent平台创建独立的表。消息表采用BIGSERIAL类型的sequence字段确保会话内消息顺序的严格一致性，相比Snowflake
ID方案实现更简单且满足AgentHub的场景需求。

#### 3.2.3 Redis缓存策略

Redis在AgentHub中承担三个角色：会话列表缓存（TTL
5分钟）、在线状态Pub/Sub（实时）、消息未读计数（精确计数）。会话列表以`user:{user_id}:conversations`为key存储有序集合，score为last_message_at的时间戳，保证列表排序的实时性。未读计数以`conv:{conversation_id}:user:{user_id}:unread`为key存储整数，新消息到达时INCR，用户已读时DEL。WebSocket服务器使用Redis
Pub/Sub实现跨实例的消息广播，每个会话对应一个Redis Channel [^33]。

### 3.3 业务服务层

#### 3.3.1 会话服务

会话服务负责会话的CRUD、排序、搜索和归档。创建会话时根据类型（单聊/群聊）初始化参与者列表，群聊会话自动将Orchestrator
Agent加入参与者。搜索功能基于PostgreSQL的全文搜索，对会话标题和消息内容进行索引。归档功能将会话从活动列表移到归档列表，归档会话不再出现在默认视图中但可通过搜索找到。

#### 3.3.2 消息服务

消息服务处理消息的存储、分页查询、上下文组装和pin管理。存储时自动分配sequence号（通过PostgreSQL的BIGSERIAL），确保消息顺序。分页查询使用cursor-based方案，基于(created_at,
id)的复合游标避免offset分页在大数据量下的性能劣化
。上下文组装功能将最近的N条消息（默认20条）按顺序拼接为Agent的对话历史，pin的消息作为长期上下文优先插入。Pin功能允许用户将关键消息（如需求描述、设计决策、代码规范）固定为持久上下文，在后续对话中始终传递给Agent。

#### 3.3.3 Agent服务

Agent服务管理Agent的注册、配置更新、能力发现和状态监控。内置Agent（Claude
Code、Codex、OpenCode）在系统启动时自动注册，用户自建Agent通过对话式创建流程生成------用户提供名称、描述、System
Prompt和工具集，服务生成Agent配置并持久化。能力发现功能返回Agent支持的能力列表（如代码生成、代码审查、调试、部署），Orchestrator根据能力标签匹配进行任务分发
[^34]。

#### 3.3.4 产物服务

产物服务负责从Agent响应中提取代码块（通过正则匹配Markdown fenced code
blocks）、生成前后版本的Diff（使用diff库的structuredPatch函数）、管理版本快照和生成预览URL。产物内容更新时自动保存版本历史，采用"最近N个版本存完整快照，历史版本存diff"的混合存储策略以平衡查询性能和存储空间
[^35]。

#### 3.3.5 部署服务

部署服务封装Vercel API v13和Netlify
API的调用，实现"上传文件、创建部署、状态轮询、URL返回"的完整管道。部署流程采用异步模式，创建部署后立即返回部署ID，通过SSE实时推送部署进度（pending
to building to deploying to ready/error）
[^36]。部署配置根据产物类型自动推断------HTML产物使用静态部署，React/Vite产物使用对应的框架预设，需要服务器端渲染的产物使用Docker部署。

## 4. Orchestrator引擎设计

### 4.1 架构概述

#### 4.1.1 设计目标

Orchestrator是AgentHub的核心差异化组件，承担"项目经理"角色------理解用户意图、拆解复杂任务、调度子Agent协作执行、聚合最终结果。其设计目标包括：自动化的任务分解与Agent匹配，支持并行调度和失败降级，代码冲突检测与解决，以及完整的执行状态追踪。评审标准中AI协作能力占30%权重，Orchestrator是实现这一权重的关键引擎
[^37]。

Orchestrator采用LangGraph
Supervisor模式构建。LangGraph是业界标准的Agent编排框架（28K
Stars），提供图状工作流、内置状态管理和持久化能力，与火山方舟API的兼容性经过验证
[^38]。Supervisor模式将Orchestrator本身作为一个LLM Agent，通过function
calling决定子Agent的调度策略，相比硬编码规则具有更强的泛化能力。

#### 4.1.2 工作流程图

Orchestrator的工作流程分为四个阶段。第一阶段是意图分析，使用豆包Seed
2.0强模型识别任务类型、复杂度和所需Agent能力。第二阶段是任务拆解，将复杂任务分解为带依赖关系的子任务DAG。第三阶段是Agent调度，根据依赖关系选择并行或串行执行策略。第四阶段是结果聚合，合并子任务产出并生成连贯的最终回复。

    用户消息输入
        |
        v
    +------------------------+
    | 1. 意图分析 (LLM)      |  <- 豆包Seed 2.0强模型
    | 识别任务类型            |
    | 判断是否需要分解         |
    | 提取关键参数             |
    +-----------+------------+
                |
                v
         +------------+
         | 是否需要   |
         | 多Agent协作 |
         +-----+------+
               |
         否 <--+--> 是
         |           |
         v           v
       直接路由   +----------------------+
       单Agent   | 2. 任务拆解 (LLM)     |
         |       | 将复杂任务分解为      |
         |       | 多个子任务            |
         |       | 确定依赖关系           |
         |       | 指定执行Agent          |
         |       +----------+-----------+
         |                  |
         |                  v
         |       +----------------------+
         |       | 3. Agent调度引擎      |
         |       | 并行执行独立任务       |
         |       | 串行执行依赖任务       |
         |       | 失败降级处理           |
         |       +----------+-----------+
         |                  |
         |                  v
         |       +----------------------+
         |       | 4. 结果聚合 (LLM)     |
         |       | 合并子任务产出         |
         |       | 检测代码冲突           |
         |       | 生成最终回复           |
         |       +----------+-----------+
         |                  |
         +------------------+
                            |
                            v
                    +--------------+
                    | 返回最终结果  |
                    | 给用户        |
                    +--------------+

### 4.2 意图分析与任务拆解

#### 4.2.1 意图分析Prompt设计

意图分析是Orchestrator的第一步，使用豆包Seed
2.0强模型执行。Prompt采用结构化输出格式（JSON
Schema），要求模型识别任务类型、复杂度评分和所需Agent能力标签。分析原则为：复杂度小于等于3直接路由到单一Agent；复杂度4-7拆解为2-3个子任务；复杂度大于等于8拆解为4个以上子任务并设置检查点；编码任务默认分配给Claude
Code或Codex；部署任务需要Claude Code生成代码后由部署Agent处理。

    # orchestrator/intent_analysis.py
    INTENT_ANALYSIS_PROMPT = """You are a project manager Agent responsible for analyzing user messages and determining the best execution strategy.

    Available Agents:
    {agents_description}

    User Message: {user_message}

    Please analyze and output in JSON format:
    {
        "task_type": "type (coding/debugging/review/planning/deployment/general)",
        "complexity": "complexity score (1-10)",
        "requires_multi_agent": "whether multi-Agent collaboration is needed (boolean)",
        "primary_agent": "ID of the primary execution Agent",
        "sub_tasks": [
            {
                "id": "sub-task unique ID",
                "description": "sub-task description",
                "agent_id": "ID of the execution Agent",
                "depends_on": ["dependent sub-task IDs"],
                "estimated_effort": "estimated effort (low/medium/high)"
            }
        ],
        "context_needed": ["types of context information needed"]
    }

    Analysis principles:
    - Complexity <= 3: route directly to a single Agent
    - Complexity 4-7: decompose into 2-3 sub-tasks
    - Complexity >= 8: decompose into 4+ sub-tasks with checkpoints
    - Coding tasks default to Claude Code or Codex
    - Deployment tasks require Claude Code to generate code first, then deployment Agent
    """

#### 4.2.2 任务拆解策略

任务拆解基于依赖关系图（DAG）建模，每个子任务作为节点，依赖关系作为有向边。LangGraph的图结构天然支持DAG执行------通过add_conditional_edges实现条件分支，子任务完成后通过reducer函数更新共享状态
。拆解策略参考Claude Code的12级渐进式Agent能力模型 [^39]：Level
3（规划模式）用于生成Todo列表，Level
4（子Agent）用于并行执行独立子任务，Level
9（Agent团队）用于复杂项目的多Agent协作。

对于编码类任务，拆解遵循"设计、实现、测试、部署"的标准流水线。设计子任务由Orchestrator自身完成（生成技术方案和接口定义），实现子任务分配给Claude
Code或Codex，测试子任务由同一个Agent完成（运行测试并修复错误），部署子任务在代码通过测试后触发。

### 4.3 Agent调度引擎

#### 4.3.1 调度策略

调度引擎是Orchestrator的核心执行组件，负责将拆解后的子任务分配给合适的Agent并管理执行流程。调度策略包括顺序执行、并行执行和条件执行三种模式。顺序执行适用于有依赖关系的子任务（如先设计后实现），并行执行适用于独立子任务（如前端和后端同时开发），条件执行适用于需要根据中间结果决定后续路径的场景（如测试通过后部署，失败则修复）。

    # orchestrator/dispatcher.py
    from langgraph.graph import StateGraph, END
    from typing import TypedDict, Annotated, Sequence
    import operator

    class TaskState(TypedDict):
        messages: Annotated[Sequence[BaseMessage], operator.add]
        tasks: dict  # sub-task status tracking
        results: dict  # sub-task results
        final_response: str

    class AgentDispatcher:
        def __init__(self, agent_registry: AgentRegistry):
            self.registry = agent_registry
            self.graph = self._build_graph()
        
        def _build_graph(self):
            workflow = StateGraph(TaskState)
            
            # Add nodes
            workflow.add_node("analyze", self._analyze_task)
            workflow.add_node("dispatch", self._dispatch_tasks)
            workflow.add_node("collect", self._collect_results)
            workflow.add_node("aggregate", self._aggregate_response)
            
            # Add conditional edges
            workflow.add_conditional_edges(
                "analyze",
                self._should_parallel,
                {"parallel": "dispatch", "single": "dispatch", "error": END}
            )
            workflow.add_edge("dispatch", "collect")
            workflow.add_edge("collect", "aggregate")
            workflow.add_edge("aggregate", END)
            
            workflow.set_entry_point("analyze")
            return workflow.compile()
        
        async def execute(self, session_id: str, user_message: str, context: dict):
            initial_state = TaskState(
                messages=[HumanMessage(content=user_message)],
                tasks={},
                results={},
                final_response=""
            )
            return await self.graph.ainvoke(initial_state)

#### 4.3.2 并行执行机制

并行执行利用Python的asyncio.gather同时向多个Agent发送请求，适合独立的子任务场景。例如"开发一个待办事项应用"可以并行拆解为"生成React前端"和"生成Express后端"两个子任务，两个Agent同时工作，总耗时接近单个Agent的执行时间而非累加。

    async def execute_parallel(self, tasks: list[SubTask], context: dict) -> dict:
        """Execute independent sub-tasks in parallel"""
        async def run_task(task: SubTask):
            adapter = self.registry.get_adapter(task.agent_id)
            result = await adapter.execute(
                task_description=task.description,
                context=context,
                system_prompt=task.system_prompt
            )
            return {task.id: result}
        
        # Use asyncio.gather for parallel execution
        results = await asyncio.gather(*[run_task(t) for t in tasks])
        return {k: v for r in results for k, v in r.items()}

#### 4.3.3 串行执行机制

串行执行通过LangGraph的状态机保证依赖关系，前一个子任务的输出自动成为后一个子任务的输入。例如"生成API接口、实现接口逻辑、编写测试"的依赖链中，第二步可以引用第一步生成的接口定义，第三步可以引用第二步的实现代码。

#### 4.3.4 失败降级策略

失败降级是调度引擎的关键鲁棒性保障，采用三级降级策略。一级降级：子Agent超时（默认120秒）时自动重试一次，重试仍失败则标记该任务为failed并记录错误日志。二级降级：关键子任务失败后切换备用Agent（如Claude
Code失败时切换到Codex），切换时携带已完成的上下文确保连续性。三级降级：所有子Agent均不可用或全部失败时，Orchestrator自身接管任务执行，使用内置的通用能力生成响应，确保用户始终收到回复而非错误提示。

#### 4.3.5 代码冲突处理

多Agent并行编辑同一文件时可能产生代码冲突。冲突检测通过Git
diff算法实现------每个Agent的修改先生成unified
diff，调度引擎在合并前检查diff的hunk是否有重叠区域。无重叠时直接合并（applyPatch），有重叠时将冲突信息反馈给Orchestrator，由其生成冲突解决指令
。冲突解决Prompt要求模型分析双方修改的意图并生成合并后的代码，类似于Git的merge
conflict resolution。

### 4.4 状态机设计

#### 4.4.1 状态定义

Orchestrator的状态机定义了任务执行的完整生命周期，包含八个核心状态。

  ----------------------------------------------------------------------------------
  状态          描述                     允许转换            触发条件
  ------------- ------------------------ ------------------- -----------------------
  idle          空闲状态，等待用户输入   to analyzing        收到用户消息

  analyzing     分析用户意图，拆解任务   to dispatching / to 分析完成，需要多Agent /
                                         routing_direct      分析完成，单Agent即可

  dispatching   分发子任务到各Agent      to executing        所有子任务已分配

  executing     Agent执行中              to collecting / to  所有子任务完成 /
                                         error               有子任务失败

  collecting    收集子任务结果           to aggregating      所有结果已收到

  aggregating   聚合结果，生成最终回复   to completed / to   聚合成功 / 聚合失败
                                         error               

  completed     完成，向用户返回结果     to idle             结果已推送

  error         错误状态                 to idle / to        错误已处理 / 触发降级
                                         dispatching(降级)   
  ----------------------------------------------------------------------------------

状态机的每个转换都通过LangGraph的conditional_edges实现，转换函数检查当前状态的条件并决定下一个目标节点。状态变更通过SSE实时推送给前端，用户在聊天界面中可以看到Orchestrator的当前状态（如"正在分析任务..."、"正在调度Agent..."）。

#### 4.4.2 LangGraph集成

LangGraph的集成核心在于将Orchestrator的状态机映射为LangGraph的图节点和边。每个状态对应一个async节点函数，状态转换对应conditional_edges。Orchestrator自身作为一个LLM
Agent使用tool
calling能力调用子Agent的执行工具，子Agent的执行工具封装为@tool装饰的Python函数。

    # orchestrator/langgraph_integration.py
    from langchain_core.tools import tool
    from langgraph.prebuilt import create_react_agent

    class OrchestratorGraph:
        def __init__(self, llm, agent_registry):
            self.llm = llm
            self.registry = agent_registry
            
            # Define tools: sub-Agent execution
            @tool
            async def invoke_agent(agent_id: str, task: str, context: str = "") -> str:
                """Invoke a sub-agent to execute a task"""
                adapter = agent_registry.get_adapter(agent_id)
                return await adapter.execute(task, context)
            
            # Define tools: parallel execution of multiple Agents
            @tool
            async def invoke_parallel(tasks_json: str) -> str:
                """Execute multiple agents in parallel"""
                tasks = json.loads(tasks_json)
                results = await asyncio.gather(*[
                    self.registry.get_adapter(t["agent_id"]).execute(
                        t["task"], t.get("context", "")
                    ) for t in tasks
                ])
                return json.dumps(dict(zip([t["id"] for t in tasks], results)))
            
            # Create React Agent
            self.agent = create_react_agent(
                model=llm,
                tools=[invoke_agent, invoke_parallel]
            )
        
        async def run(self, state: TaskState) -> TaskState:
            """Run Orchestrator Agent"""
            result = await self.agent.ainvoke({"messages": state["messages"]})
            state["messages"] = result["messages"]
            state["final_response"] = self._extract_final_response(result["messages"])
            return state

### 4.5 上下文管理

#### 4.5.1 消息历史组装

Orchestrator在调用子Agent时需要组装完整的对话上下文。上下文组装策略采用"最近优先+Pinned消息"模式：默认携带最近的20条消息作为短期记忆，用户pin的消息作为长期记忆始终包含在上下文中
。上下文窗口超过模型限制时，采用Claude
Code风格的上下文压缩策略------自动摘要早期的对话内容，保留关键决策和产物引用
[^40]。

#### 4.5.2 Pinned消息处理

Pinned消息是AgentHub的一个重要交互特性，用户可以将关键消息（如需求描述、设计决策、代码规范）固定为持久上下文。Pinned消息存储在conversation_metadata的pinned_message_ids数组中，Orchestrator在组装上下文时将这些消息优先插入到对话历史的前端。Pin数量限制为10条，避免上下文过度膨胀。

### 4.6 结果聚合

#### 4.6.1 结果合并策略

多Agent协作的结果聚合采用LLM驱动的合并策略。Orchestrator将所有子任务的结果（代码、文档、分析等）作为输入，要求LLM生成一份连贯的最终回复。合并Prompt要求模型：保持各子产物的完整性（不遗漏任何产出）、添加章节标题和结构、标注各部分的贡献Agent、处理冲突（如发现代码冲突时给出解决方案）。

#### 4.6.2 格式化输出

聚合结果按MessageContent格式输出为结构化的消息内容，支持文本、代码块、产物卡片等多种类型的混合排列。例如一个完整的项目开发任务聚合结果可能包含：项目概述（文本）、生成的代码文件（代码块卡片）、部署说明（文本）、预览链接（Web预览卡片）。

## 5. 统一适配器层设计

### 5.1 架构概述

#### 5.1.1 设计目标

统一适配器层的核心目标是屏蔽不同Agent平台的API差异，为上层业务服务提供一致的调用接口。AgentHub需要对接至少两个主流Agent平台（Claude
Code和Codex），同时预留用户自建Agent的扩展能力 [^41]
[^42]。适配器层的设计需要解决四大挑战：协议差异（Anthropic Messages API
vs OpenAI Responses API vs Chat Completions）、认证方式差异（API
Key、OAuth、Session-based）、流式格式差异（SSE事件类型不同）和工具调用格式差异（JSON
Schema vs Function Calling vs MCP）。

调研发现，LLM-Rosetta的Hub-and-Spoke IR架构是解决多协议适配的最优方案
。该架构定义一个中间表示（IR）作为通用协议，每个Agent平台只需实现"IR to
native protocol"和"native protocol to
IR"两个转换器，而非为每对协议编写适配器。这将适配复杂度从O(N\^2)降为O(N)，新增第N+1个Agent平台只需实现2个转换器而非2N个。LLM-Rosetta验证显示，native
to IR转换中位数低于4微秒，IR to
native往返转换低于80微秒，性能开销可忽略不计 。

#### 5.1.2 适配器接口定义

    # adapters/base.py
    from abc import ABC, abstractmethod
    from dataclasses import dataclass
    from enum import Enum
    from typing import AsyncIterator, Optional

    class StreamEventType(Enum):
        TEXT_DELTA = "text_delta"
        TOOL_CALL = "tool_call"
        TOOL_RESULT = "tool_result"
        ARTIFACT_DELTA = "artifact_delta"
        STATUS_CHANGE = "status_change"
        ERROR = "error"
        DONE = "done"

    @dataclass
    class StreamEvent:
        type: StreamEventType
        content: str
        metadata: dict = None

    @dataclass
    class AgentResponse:
        text: str
        tool_calls: list[dict] = None
        artifacts: list[dict] = None
        status: str = "success"
        error: Optional[str] = None

    class AgentAdapter(ABC):
        """Agent adapter base class, all Agent platforms must implement this interface"""
        
        @property
        @abstractmethod
        def provider_name(self) -> str:
            """Return Provider identifier name"""
            pass
        
        @property
        @abstractmethod
        def capabilities(self) -> list[str]:
            """Return supported capabilities list"""
            pass
        
        @abstractmethod
        async def execute(
            self, 
            messages: list[dict], 
            system_prompt: Optional[str] = None,
            tools: Optional[list[dict]] = None,
            stream: bool = True
        ) -> AsyncIterator[StreamEvent] | AgentResponse:
            """Execute Agent call
            
            Args:
                messages: conversation history, unified format [{"role": "user|assistant|system", "content": str}]
                system_prompt: system prompt
                tools: available tools list, unified format [{"name": str, "description": str, "parameters": dict}]
                stream: whether to stream return
                
            Yields:
                StreamEvent: stream event
            """
            pass
        
        @abstractmethod
        async def health_check(self) -> dict:
            """Health check"""
            pass
        
        @abstractmethod
        def get_config_schema(self) -> dict:
            """Return JSON Schema for this Provider's configuration parameters"""
            pass

### 5.2 内置Agent适配器

#### 5.2.1 Claude Code适配器

Claude Code适配器基于Anthropic Messages
API实现，核心处理消息格式的双向转换。Anthropic API要求严格的user to
assistant to user消息交替模式，不支持连续的user消息
[^43]。适配器在发送请求前自动合并连续的user消息（以换行分隔），在接收响应时将Anthropic的content_block_delta事件转换为统一的StreamEvent格式。

    # adapters/claude_code.py
    class ClaudeCodeAdapter(AgentAdapter):
        provider_name = "claude_code"
        capabilities = ["coding", "debugging", "code_review", "planning", "file_operations"]
        
        def __init__(self, config: dict):
            self.api_key = config["api_key"]
            self.model = config.get("model", "claude-sonnet-4-5-20250929")
            self.base_url = config.get("base_url", "https://api.anthropic.com")
            self.client = anthropic.AsyncAnthropic(api_key=self.api_key, base_url=self.base_url)
        
        async def execute(self, messages, system_prompt=None, tools=None, stream=True):
            # 1. Convert message format: unified IR -> Anthropic format
            anthropic_messages = self._to_anthropic_messages(messages)
            anthropic_tools = self._to_anthropic_tools(tools) if tools else None
            
            # 2. Call Anthropic API
            async with self.client.messages.stream(
                model=self.model,
                max_tokens=4096,
                system=system_prompt or "",
                messages=anthropic_messages,
                tools=anthropic_tools
            ) as stream:
                async for event in stream:
                    # 3. Convert response format: Anthropic -> unified StreamEvent
                    yield self._to_stream_event(event)
        
        def _to_anthropic_messages(self, messages: list[dict]) -> list[dict]:
            """Unified message format -> Anthropic Messages API format"""
            anthropic_msgs = []
            for msg in messages:
                if msg["role"] == "tool":
                    anthropic_msgs.append({
                        "role": "user",
                        "content": [{"type": "tool_result", "tool_use_id": msg["tool_call_id"], "content": msg["content"]}]
                    })
                elif msg["role"] == "assistant" and msg.get("tool_calls"):
                    content = [{"type": "text", "text": msg["content"] or ""}]
                    for tc in msg["tool_calls"]:
                        content.append({
                            "type": "tool_use",
                            "id": tc["id"],
                            "name": tc["function"]["name"],
                            "input": tc["function"]["arguments"]
                        })
                    anthropic_msgs.append({"role": "assistant", "content": content})
                else:
                    anthropic_msgs.append({"role": msg["role"], "content": msg["content"]})
            return anthropic_msgs
        
        def _to_stream_event(self, event) -> StreamEvent:
            """Anthropic stream event -> unified StreamEvent"""
            if event.type == "content_block_delta":
                if event.delta.type == "text_delta":
                    return StreamEvent(StreamEventType.TEXT_DELTA, event.delta.text)
                elif event.delta.type == "input_json_delta":
                    return StreamEvent(StreamEventType.TOOL_CALL, event.delta.partial_json)
            elif event.type == "message_stop":
                return StreamEvent(StreamEventType.DONE, "")
            return StreamEvent(StreamEventType.TEXT_DELTA, "")

Claude
Code适配器的特殊处理包括：工具调用参数通过input_json_delta流式传输（partial_json分块），适配器需要在内存中累积完整的JSON后再解析
[^44]；上下文窗口最高200K tokens，适配器在超过阈值时触发自动摘要
[^45]；system
prompt仅支持单个且在开头位置，多个system消息需要合并为一个。

#### 5.2.2 Codex CLI适配器

Codex CLI适配器基于OpenAI Responses
API实现。OpenAI于2026年2月完全移除了Chat
Completions支持，全面转向Responses API
[^46]，因此Codex适配器直接使用Responses API而非兼容层。Responses
API与Chat
Completions的关键差异包括：输入使用input字段而非messages字段、支持服务端状态管理（可选）、内置web_search/file_search/code_interpreter等工具、流式事件格式不同
[^47]。

    # adapters/codex_cli.py
    class CodexCLIAdapter(AgentAdapter):
        provider_name = "openai_codex"
        capabilities = ["coding", "debugging", "web_search", "file_search"]
        
        def __init__(self, config: dict):
            self.api_key = config["api_key"]
            self.model = config.get("model", "codex-mini-latest")
            self.base_url = config.get("base_url", "https://api.openai.com")
            self.client = openai.AsyncOpenAI(api_key=self.api_key, base_url=self.base_url)
        
        async def execute(self, messages, system_prompt=None, tools=None, stream=True):
            # Responses API uses input instead of messages
            response = await self.client.responses.create(
                model=self.model,
                input=self._to_responses_input(messages, system_prompt),
                tools=self._to_responses_tools(tools) if tools else None,
                stream=True,
                reasoning={"effort": "medium"}
            )
            
            async for event in response:
                yield self._to_stream_event(event)
        
        def _to_responses_input(self, messages: list[dict], system_prompt: str = None) -> list:
            """Unified message format -> Responses API input format"""
            input_msgs = []
            if system_prompt:
                input_msgs.append({"role": "system", "content": system_prompt})
            for msg in messages:
                if msg["role"] == "tool":
                    input_msgs.append({"role": "user", "content": json.dumps({"type": "tool_result", "call_id": msg["tool_call_id"], "output": msg["content"]})})
                else:
                    input_msgs.append({"role": msg["role"], "content": msg["content"]})
            return input_msgs

Codex CLI适配器利用Responses
API的内置工具（web_search、file_search、computer_use）能力，当AgentHub请求的工具与内置工具匹配时直接映射，不匹配的通过function类型工具传递
[^48]。这种设计让Codex
Agent天然具备联网搜索和代码执行能力，无需额外配置。

#### 5.2.3 OpenCode适配器

OpenCode项目已于2025年9月归档
[^49]，但其架构设计具有重要参考价值。AgentHub的OpenCode适配器定位为兼容层，支持通过OpenAI兼容API或自托管端点接入OpenCode
Agent。适配器实现相对简单------将统一IR转换为OpenAI Chat
Completions格式（OpenCode支持的标准接口），处理SSE流式响应的格式转换。由于OpenCode已归档，此适配器作为扩展性示例，展示AgentHub支持第三方Agent的能力。

#### 5.2.4 适配器对比

  ---------------------------------------------------------------------------------------------------
  维度         Claude Code              Codex CLI                                 OpenCode
  ------------ ------------------------ ----------------------------------------- -------------------
  API类型      Anthropic Messages API   OpenAI Responses API                      OpenAI兼容API

  流式格式     content_block_delta      response.output_text.delta                choices\[\].delta

  工具调用     tool_use content block   function工具                              function_calling

  消息格式     严格user-assistant交替   input数组，更灵活                         标准messages数组

  系统提示     仅开头单个               支持多个                                  支持多个

  上下文窗口   200K tokens              128K-2M                                   取决于模型

  内置工具     无（需外部MCP）          web_search,file_search,code_interpreter   MCP+LSP

  认证方式     API Key (x-api-key)      API Key (Authorization: Bearer)           API Key

  状态管理     无状态                   服务端状态（可选）                        无状态
  ---------------------------------------------------------------------------------------------------

三个适配器的核心差异体现在API范式、流式事件格式和工具调用机制上。Claude
Code的Messages
API以content_block为核心抽象，文本和工具调用都是不同类型的content block
；Codex CLI的Responses
API以input/output为核心抽象，内置工具和自定义工具统一在tools参数中声明
；OpenCode的兼容API最接近传统Chat
Completions格式。统一适配器层通过IR（Intermediate
Representation）屏蔽这些差异，上层业务代码无需关心底层Agent使用的是哪种API。

### 5.3 用户自建Agent

#### 5.3.1 配置模型

用户自建Agent通过对话式创建流程生成配置。配置模型包含Agent的基本信息（名称、描述、头像）、Provider选择（Claude
Code / Codex / OpenAI兼容）、API凭证（API Key或环境变量名）、System
Prompt、工具集选择和高级参数（模型、温度、最大token数）。

    # schemas/custom_agent.py
    class CustomAgentConfig(BaseModel):
        name: str = Field(..., min_length=1, max_length=100)
        description: str = Field(..., max_length=500)
        provider: Literal["anthropic", "openai", "openai_compatible"]
        model: str = Field(default="gpt-4o")
        api_config: dict = Field(default_factory=dict)
        # {
        #   "base_url": "https://api.example.com/v1",
        #   "api_key_env": "MY_AGENT_API_KEY",
        #   "api_key": "sk-xxx"  # optional, env takes priority
        # }
        system_prompt: str = Field(default="You are a helpful assistant.")
        tools: list[dict] = Field(default_factory=list)
        # [{"type": "mcp", "server_config": {...}}]
        capabilities: list[str] = Field(default_factory=list)
        parameters: dict = Field(default_factory=dict)
        # {"temperature": 0.7, "max_tokens": 4096}

自建Agent的API凭证安全通过服务端存储和环境变量引用双重保障。用户在创建Agent时输入的API
Key经加密后存储在数据库中（使用Fernet对称加密），运行时通过环境变量或密钥管理服务解密。Agent配置以JSON格式存储在agents表的provider_config字段中，天然支持灵活的扩展字段。

#### 5.3.2 动态加载机制

自定义Agent在创建时动态注册到AgentRegistry，无需重启服务。Registry维护内存中的Agent
ID到适配器实例映射，创建时根据Provider类型实例化对应的适配器类并传入配置。AgentRegistry同时维护Agent的能力标签索引，Orchestrator在任务分发时通过能力标签快速匹配可用的Agent。

#### 5.3.3 OpenAI兼容API支持

OpenAI兼容API是连接火山方舟、扣子Coze和多数第三方Provider的通用桥梁
[^50]。兼容层将统一IR转换为标准OpenAI Chat Completions请求格式（POST
/v1/chat/completions），解析SSE流式响应的choices\[\].delta格式。火山方舟的Base
URL为`https://ark.cn-beijing.volces.com/api/v3`，扣子Coze通过`POST /v3/chat`端点提供对话能力
[^51]
[^52]。兼容层支持前缀缓存以降低长文本推理成本，支持上下文缓存（Context
API）的会话模式和前缀模式 。

### 5.4 MCP集成

#### 5.4.1 MCP Client实现

MCP（Model Context
Protocol）是Anthropic推出的Agent与工具通信的标准协议，被称为"AI时代的USB-C"
。AgentHub的MCP Client基于官方Python
SDK实现，支持stdio和HTTP/SSE两种传输方式。Client在启动时连接到配置的MCP
Server，通过Initialize握手协商协议版本和能力，然后调用tools/list获取可用工具列表
[^53]。

    # mcp/client.py
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    class MCPClientManager:
        def __init__(self):
            self.sessions: dict[str, ClientSession] = {}
            self.tool_registry: dict[str, dict] = {}
        
        async def connect_server(self, server_id: str, config: dict):
            """Connect to MCP Server"""
            if config["type"] == "stdio":
                params = StdioServerParameters(
                    command=config["command"],
                    args=config.get("args", []),
                    env=config.get("env", {})
                )
                transport = stdio_client(params)
            elif config["type"] == "sse":
                transport = sse_client(config["url"], config.get("headers", {}))
            
            read, write = await transport.__aenter__()
            session = await ClientSession(read, write).__aenter__()
            await session.initialize()
            
            # Register tools
            tools = await session.list_tools()
            for tool in tools.tools:
                self.tool_registry[f"{server_id}:{tool.name}"] = {
                    "server_id": server_id,
                    "name": tool.name,
                    "description": tool.description,
                    "schema": tool.inputSchema,
                    "session": session
                }
            
            self.sessions[server_id] = session
        
        async def call_tool(self, full_name: str, arguments: dict) -> str:
            """Call MCP tool"""
            tool = self.tool_registry[full_name]
            session = tool["session"]
            result = await session.call_tool(tool["name"], arguments=arguments)
            return result.content
        
        def get_available_tools(self) -> list[dict]:
            """Get all available tools, convert to unified format"""
            return [{
                "name": name,
                "description": tool["description"],
                "parameters": tool["schema"]
            } for name, tool in self.tool_registry.items()]

#### 5.4.2 工具发现与调用

MCP工具的发现和调用遵循"注册、发现、调用、结果"的完整流程。MCP Client
Manager在系统启动时根据配置连接所有MCP
Server，获取工具列表并注册到统一工具注册表。Agent在执行时通过get_available_tools()获取可用工具列表，工具调用时通过call_tool()将请求路由到对应的MCP
Server。工具结果以字符串形式返回，Agent适配器将结果格式化为tool_result消息追加到对话历史中。

MCP的安全挑战在AgentHub中通过三层防护解决
[^54]：工具调用前显式权限确认（用户在UI中看到工具调用请求并选择批准或拒绝）、最小权限原则（每个Agent仅配置其需要的工具集）、工具调用范围的权限限定（敏感操作如文件删除需要额外确认）。

#### 5.4.3 A2A协议前瞻性设计

A2A（Agent-to-Agent
Protocol）由Google推出，现由Linux基金会治理，解决Agent与Agent之间的水平通信问题
[^55] [^56]。AgentHub的适配器层预留A2A Agent
Card支持，为跨平台Agent协作提供扩展路径。

A2A的核心概念包括Agent
Card（能力元数据，位于`/.well-known/agent.json`）、Task（工作单位，有完整的生命周期状态机）和Artifact（完成的输出）
[^57] [^58]。AgentHub未来可以作为A2A
Client连接到其他支持A2A的Agent平台，也可以将自己的Agent以A2A
Server形式暴露给其他平台调用。

    # adapters/a2a_protocol.py (reserved implementation)
    class A2AAdapter(AgentAdapter):
        """A2A Protocol Adapter - reserved implementation for cross-platform Agent collaboration"""
        
        async def discover_agent(self, agent_url: str) -> dict:
            """Discover Agent Card"""
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{agent_url}/.well-known/agent.json") as resp:
                    return await resp.json()
        
        async def send_task(self, agent_url: str, task_input: dict) -> AsyncIterator[StreamEvent]:
            """Send task to A2A Agent"""
            # Use tasks.sendSubscribe to get SSE streaming updates
            payload = {
                "jsonrpc": "2.0",
                "method": "tasks/sendSubscribe",
                "params": {"task": task_input}
            }
            async with aiohttp.ClientSession() as session:
                async with session.post(f"{agent_url}/a2a", json=payload) as resp:
                    async for line in resp.content:
                        event = json.loads(line)
                        yield self._parse_a2a_event(event)

A2A协议的采用路线图建议从Phase
3开始------当AgentHub需要与外部Agent平台互操作时引入A2A支持
[^59]。当前MCP解决Agent与工具的垂直连接问题，A2A解决Agent与Agent的水平通信问题，两者互补而非竞争
[^60]。

### 5.5 适配器注册与发现

#### 5.5.1 Registry模式

AgentRegistry采用单例模式管理所有适配器的生命周期。Registry在应用启动时从数据库加载Agent配置，为每个内置Agent和已启用的自定义Agent创建适配器实例。Registry提供三个核心接口：get_adapter(agent_id)按ID获取适配器实例，get_by_capability(capability)按能力标签筛选适配器，get_all_agents()返回所有Agent的元数据列表。

#### 5.5.2 动态注册流程

自定义Agent的注册流程为：用户在前端填写Agent配置表单，后端验证配置（API连通性测试），创建数据库记录，实例化适配器，注册到AgentRegistry，返回Agent
ID。注册失败时返回详细的错误信息（如API Key无效、Base
URL不可达），帮助用户快速定位配置问题。

## 6. AI协作规范体系设计

### 6.1 设计目标

AI协作规范体系是AgentHub在评审标准中"AI协作能力（30%权重）"的核心支撑。该体系的目标是将AgentHub与AI
Agent的协作过程规范化为可沉淀、可复用、可进化的结构化知识，包括Spec文档（做什么）、Skill体系（怎么做）和Rules规范（约束条件）三个层次
[^61]。设计参考了Claude
Code的CLAUDE.md体系、AGENTS.md开放标准（60,000+项目采用）和agentskills.io标准，形成AgentHub特有的协作规范体系
[^62] [^63] [^64]。

规范体系的创新之处在于：与AgentHub的群聊模式深度集成，协作规范不是静态文件而是动态生成的对话产物；Orchestrator在任务调度时自动应用相关规范，Agent在执行过程中遵循规范约束；规范支持版本管理，每次协作后自动更新以反映最新的项目约定。

### 6.2 Spec规范层

#### 6.2.1 Spec文档格式

Spec文档是AI协作的"源文件"，其质量直接决定AI协作的产出质量。AgentHub采用YAML
frontmatter + Markdown body的混合格式，兼顾机器可读性和人类可读性 。

    ---
    type: spec
    status: draft
    participants:
      - orchestrator
      - claude_code
      - codex
    scope: |
      开发一个React Todo应用，包含增删改查功能
    non_goals:
      - 用户认证系统
      - 后端持久化
      - 多用户协作
    acceptance_criteria:
      - 可以添加新的待办事项
      - 可以标记完成/取消完成
      - 可以删除待办事项
      - 可以筛选全部/进行中/已完成
    tech_stack:
      frontend: React + TypeScript + Tailwind CSS
      state: useState + useContext
    test_plan: |
      1. 手动测试所有CRUD操作
     2. 验证筛选功能
     3. 验证响应式布局
    ---

    # 详细设计

    ## 组件结构
    - App: 根组件，管理全局状态
    - TodoList: 渲染待办列表
    - TodoItem: 单个待办项
    - AddTodo: 添加表单
    - FilterBar: 筛选栏

    ## 数据模型
    interface Todo {
      id: string;
      text: string;
      completed: boolean;
      createdAt: Date;
    }

Spec文档在AgentHub中的生成方式有两种：用户主动要求生成（"@Orchestrator
生成Spec"），Orchestrator在群聊协作过程中自动提取关键决策点并生成Spec。生成的Spec作为产物卡片嵌入聊天流中，用户可以编辑确认后保存到规范库。

#### 6.2.2 Spec生成流程

Spec生成采用"对话提取 +
LLM结构化"的两阶段流程。第一阶段，Orchestrator监控群聊对话，使用规则引擎提取关键决策点（技术选型、接口设计、约束条件）。第二阶段，将提取的内容和对话历史作为上下文输入LLM，要求模型按照Spec模板生成结构化文档。生成的Spec经过用户确认后存入specs表，与对应会话关联。

    # specs/generator.py
    class SpecGenerator:
        def __init__(self, llm):
            self.llm = llm
            self.extraction_prompt = """Analyze the following conversation and extract key decisions:
    1. Technical choices (frameworks, libraries, architecture)
    2. Scope boundaries (what's included and excluded)
    3. Interface definitions (APIs, data models)
    4. Quality constraints (performance, security, testing)

    Conversation:
    {conversation}

    Output in JSON format."""
        
        async def generate_from_conversation(self, conversation_id: str) -> dict:
            # 1. Fetch conversation messages
            messages = await self.get_conversation_messages(conversation_id)
            
            # 2. Extract key decisions
            extraction = await self.llm.ainvoke(
                self.extraction_prompt.format(conversation=messages)
            )
            decisions = json.loads(extraction.content)
            
            # 3. Generate structured spec
            spec_prompt = f"""Generate a technical spec based on these decisions:
    {json.dumps(decisions, indent=2)}

    Use the following template:
    - YAML frontmatter with type, status, participants, scope, non_goals, acceptance_criteria
    - Markdown body with detailed design sections"""
            
            spec_result = await self.llm.ainvoke(spec_prompt)
            return self._parse_spec(spec_result.content)

#### 6.2.3 Spec在AgentHub中的应用

生成的Spec通过以下方式融入AgentHub的工作流：Orchestrator在调度Agent时自动将相关Spec作为上下文的一部分传递给Agent，确保Agent了解项目约束；用户可以在聊天中引用Spec（"@Claude
Code
按照Spec实现TodoList组件"），Orchestrator解析引用并提取相关段落作为Agent的上下文；Spec支持版本管理，每次重大变更后自动生成新版本并保留历史记录。

### 6.3 Skill体系层

#### 6.3.1 Skill定义格式

AgentHub采用agentskills.io标准格式定义Skill
。Skill是AI时代的"新包管理格式"，描述Agent如何完成特定类型的工作 [^65]。

    ---
    name: react-component-dev
    description: Develop React components following best practices.
      Use when the task involves creating, refactoring, or testing React components.
    when_to_use: |
      - Creating new React components
      - Refactoring class components to hooks
      - Adding TypeScript types to components
      - Do NOT use for: backend API development, CSS styling-only tasks
    triggers:
      - keywords: ["React", "component", "hook", "JSX"]
      - globs: ["**/*.tsx", "**/*.jsx"]
    allowed_tools:
      - Read
      - Write
      - Search
    context: shared  # shared | isolated
    model: sonnet
    effort: medium
    ---

    # React Component Development Skill

    ## Workflow
    1. Analyze requirements and identify component props
    2. Create component file with proper TypeScript types
    3. Implement component logic using hooks
    4. Add unit tests with React Testing Library
    5. Verify accessibility (ARIA attributes, keyboard navigation)

    ## Standards
    - Use functional components with hooks
    - Props interface must be exported
    - Use React.FC<Props> for typing
    - One component per file
    - Max 200 lines per component

    ## Example
    ```tsx
    // Good: typed props, functional component, exported interface
    export interface ButtonProps {
      label: string;
      onClick: () => void;
      variant?: 'primary' | 'secondary';
    }

    export const Button: React.FC<ButtonProps> = ({ label, onClick, variant = 'primary' }) => {
      return <button className={`btn btn-${variant}`} onClick={onClick}>{label}</button>;
    };

    #### 6.3.2 Skill在AgentHub中的应用

    Skill在AgentHub中有三层应用：项目级Skill（存储在.agents/skills/目录下，对项目内所有Agent可见）、个人级Skill（用户自定义的跨项目Skill）和内置Skill（AgentHub预置的常用Skill库）。Skill通过渐进式加载机制进入Agent上下文——Level 1元数据（name + description，约100 tokens）在启动时始终加载，Level 2指令（Markdown body）在触发时按需加载，Level 3资源（scripts、templates）在执行时按需加载 ^65^ ^64^。

    Orchestrator在任务分发时根据任务类型匹配相关Skill，将Skill的指令作为system prompt的一部分传递给Agent。例如当用户要求"写一个React按钮组件"时，Orchestrator检测到关键词"React"和"component"，自动加载react-component-dev Skill并将其工作流和标准注入Claude Code的上下文。

    #### 6.3.3 内置Skill库

    AgentHub预置以下内置Skill，覆盖主要的开发场景：

    | Skill名称 | 适用场景 | 触发条件 |
    |-----------|---------|---------|
    | code-generation | 通用代码生成 | 所有编码任务 |
    | code-review | 代码审查 | "review"、"检查"、"audit" |
    | debug-diagnosis | 调试诊断 | "bug"、"error"、"debug" |
    | spec-writing | 编写Spec文档 | "spec"、"规范"、"文档" |
    | test-generation | 测试用例生成 | "test"、"测试" |
    | deployment | 部署流程 | "deploy"、"部署"、"发布" |
    | refactoring | 代码重构 | "refactor"、"重构" |

    ### 6.4 Rules规范层

    #### 6.4.1 Rules文件格式

    AgentHub的Rules规范参考Cursor的.mdc格式和Claude Code的.claude/rules/体系，采用YAML frontmatter + Markdown body的格式 ^66^ ^67^。

    ```markdown
    ---
    description: API design standards for Node.js/Express backends
    globs: src/api/**
    alwaysApply: false
    triggers:
      - keywords: ["API", "endpoint", "route", "controller"]
      - globs: ["src/api/**/*.ts"]
    ---

    # API Design Standards

    ## RESTful Conventions
    - Use plural nouns for resource names: `/users`, `/todos`
    - Use HTTP methods correctly: GET (read), POST (create), PUT (update), DELETE (remove)
    - Return consistent response format: { success: boolean, data: any, error?: string }

    ## Error Handling
    - Use HTTP status codes: 200 (OK), 201 (Created), 400 (Bad Request), 404 (Not Found), 500 (Server Error)
    - Include error details in response body
    - Log errors with correlation ID

    ## Validation
    - Validate all input with Zod schemas
    - Return 400 with validation error details
    - Sanitize user input to prevent injection

#### 6.4.2 Rules作用域与触发机制

Rules支持四种触发模式，对应不同的加载时机和Token消耗 [^66] [^67]：

  ---------------------------------------------------------------------------------------
  模式        触发方式                 Token效率         适用场景
  ----------- ------------------------ ----------------- --------------------------------
  Always      每次对话都加载           最低              安全红线、核心架构规则
  Apply                                                  

  Auto        匹配glob模式时加载       高                技术栈相关规则（React、API等）
  Attached                                               

  Agent       AI根据description判断    最高              特定场景规则（部署、调试等）
  Requested                                              

  Manual      用户@rule-name显式召唤   最高              不常用但重要的参考规则
  ---------------------------------------------------------------------------------------

Agent
Requested模式是AgentHub的推荐模式------Orchestrator在分析用户意图后自动判断哪些Rules与当前任务相关，避免Always
Apply模式带来的Token浪费。这种模式下Always Apply规则的总量应控制在2000
tokens以内 。

#### 6.4.3 层级架构

AgentHub采用AGENTS.md的nearest-wins层级规则体系 [^68] [^69]
[^70]。项目根目录的AGENTS.md定义通用规则（所有Agent适用），子目录的AGENTS.md覆盖父目录的规则（目录层级越深优先级越高）。

    project/
      AGENTS.md                    <- 通用规则（所有agent适用）
      src/
        frontend/
          AGENTS.md                <- 前端特定规则
        backend/
          AGENTS.md                <- 后端特定规则
        api/
          v1/
            AGENTS.md              <- API层特定规则（最优先）

Agent在工作时优先使用最近（目录层级最深）的AGENTS.md。这种层级架构确保不同领域的Agent遵循不同的规范，避免通用规则对特定领域的不适用。

### 6.5 协作规范在群聊中的应用

#### 6.5.1 群聊中的规范注入

在群聊模式下，Orchestrator在每次调度Agent前自动检索与任务相关的协作规范，并将其注入Agent的上下文中。规范注入遵循优先级规则：会话级临时规范
\> 项目级规范 \> 个人级规范 \> 内置规范。例如用户在与Claude
Code讨论React组件开发时，Orchestrator会自动注入react-component-dev
Skill和frontend目录下的AGENTS.md规则。

#### 6.5.2 规范自动更新

协作规范不是静态的------在群聊协作过程中，AgentHub会自动检测规范偏差并建议更新。当Agent频繁违反某条规则时，系统提示用户是否更新规则或调整Agent行为。当项目技术栈发生变化时（如从React切换到Vue），Orchestrator建议更新相关Skill和Rules。这种自进化机制确保协作规范始终与项目实际保持一致，避免"Prompt
Rot"（提示词腐烂）问题 [^71]。

### 6.6 数据模型

#### 6.6.1 规范存储表结构

    -- 协作规范表
    CREATE TABLE collaboration_specs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
        type VARCHAR(20) NOT NULL CHECK (type IN ('spec', 'skill', 'rule')),
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        frontmatter JSONB DEFAULT '{}',
        status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
        version INTEGER DEFAULT 1,
        parent_version UUID REFERENCES collaboration_specs(id),
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- 规范与消息关联表（追踪规范从哪些对话中生成）
    CREATE TABLE spec_message_refs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        spec_id UUID REFERENCES collaboration_specs(id) ON DELETE CASCADE,
        message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
        ref_type VARCHAR(20) CHECK (ref_type IN ('generated_from', 'applied_to', 'updated_by'))
    );

    CREATE INDEX idx_specs_conversation ON collaboration_specs(conversation_id);
    CREATE INDEX idx_specs_type_status ON collaboration_specs(type, status);

## 7. 产物管线设计

### 7.1 产物类型支持

AgentHub支持六类产物类型，覆盖AI
Agent主要的产出形式。代码产物（code）是最核心的类型，支持50+编程语言的语法高亮和编辑。HTML产物（html）支持实时iframe预览，Markdown产物（markdown）支持富文本渲染，Diff产物（diff）支持前后版本对比，PPT和PDF产物支持浏览查看。

  ---------------------------------------------------------------------------
  产物类型     预览方式            编辑能力     版本管理     部署支持
  ------------ ------------------- ------------ ------------ ----------------
  code         Monaco Editor       完整编辑     是           否

  html         iframe沙箱          源代码编辑   是           Vercel/Netlify

  markdown     react-markdown      源代码编辑   是           否

  diff         react-diff-viewer   接受/拒绝    是           否

  ppt          PptxViewJS          否           否           否

  pdf          react-pdf           否           否           否
  ---------------------------------------------------------------------------

### 7.2 产物生成与提取

#### 7.2.1 从Agent响应中提取产物

Agent响应中的产物通过正则表达式和Markdown解析器提取。代码块通过匹配fenced
code
blocks（`language\n...\n`）提取，语言标识符决定产物类型（html、markdown、python等）。Diff内容通过匹配diff代码块或手动生成（前后版本对比）。部署相关产物通过解析Agent返回的JSON元数据提取。

    # services/artifact_extractor.py
    import re
    from typing import List, Dict

    class ArtifactExtractor:
        CODE_BLOCK_PATTERN = re.compile(r'```(\w+)?\n(.*?)\n```', re.DOTALL)
        
        def extract_from_response(self, response_text: str) -> List[Dict]:
            """Extract artifacts from Agent response text"""
            artifacts = []
            
            for match in self.CODE_BLOCK_PATTERN.finditer(response_text):
                language = match.group(1) or 'text'
                content = match.group(2)
                
                artifact_type = self._language_to_artifact_type(language)
                artifacts.append({
                    'type': artifact_type,
                    'language': language,
                    'title': self._generate_title(content, language),
                    'content': content
                })
            
            return artifacts
        
        def _language_to_artifact_type(self, language: str) -> str:
            type_map = {
                'html': 'html', 'htm': 'html',
                'markdown': 'markdown', 'md': 'markdown',
                'diff': 'diff',
                'pptx': 'ppt', 'pdf': 'pdf'
            }
            return type_map.get(language.lower(), 'code')

#### 7.2.2 产物存储

产物存储采用"主表+版本表"的两层结构。主表（artifacts）存储产物的最新版本，包含type、title、content、language等字段。版本表（artifact_versions）存储历史版本，每次产物更新时自动创建新版本记录。版本内容存储完整的快照（而非diff链），以简化查询逻辑，考虑到AgentHub的产物通常不会太大（代码文件数百行以内），完整快照的空间开销在可接受范围内。

### 7.3 产物预览

#### 7.3.1 代码预览

代码预览基于@monaco-editor/react实现，通过loader.config配置CDN加载以减少打包体积。对于只读展示，使用shiki进行服务端语法高亮生成静态HTML，避免加载完整的Monaco编辑器。编辑模式下提供完整的IDE体验：语法高亮、自动补全、错误提示和mini
map 。

    // components/preview/CodePreview.tsx
    import Editor from '@monaco-editor/react';

    // 配置CDN加载
    import { loader } from '@monaco-editor/react';
    loader.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });

    export function CodePreview({ content, language, editable = false }: Props) {
      return (
        <Editor
          height="400px"
          language={language}
          value={content}
          options={{
            readOnly: !editable,
            minimap: { enabled: true },
            automaticLayout: true,
            scrollBeyondLastLine: false,
          }}
        />
      );
    }

#### 7.3.2 网页预览

网页预览根据复杂度分为三个层次。简单HTML使用iframe +
srcdoc方式直接渲染，无需额外依赖。React/Vite项目使用Sandpack提供完整的浏览器内实时预览，支持热模块重载和多模板
。完整Node.js项目预览使用WebContainers（StackBlitz），但鉴于其较大的体积和启动延迟，仅在用户明确要求时按需加载
[^72]。

所有网页预览均通过sandbox
iframe隔离执行环境，sandbox属性配置为`allow-scripts allow-same-origin allow-popups`，CSP头设置为`frame-ancestors 'self'`防止点击劫持
。父子窗口通信通过postMessage实现，AgentHub发送代码更新，iframe内bundler接收并热更新。

#### 7.3.3 Diff视图

Diff视图在编辑场景使用Monaco
DiffEditor提供IDE级体验（支持行内编辑、diff导航），在只读展示场景使用react-diff-viewer-continued提供轻量级对比（GitHub风格、split/inline双模式）。Diff的生成使用diff
npm库的structuredPatch函数，产出标准的unified
diff格式。Diff的应用（一键应用修改）使用applyPatch函数，失败时回退到全量替换策略
。

### 7.4 产物版本管理

#### 7.4.1 版本存储策略

版本管理采用完整快照策略------每个版本存储产物的完整内容，而非diff链。这种策略简化了查询逻辑（无需回溯diff链），对于AgentHub场景中通常较小的产物（代码文件数百行）空间开销在可接受范围内。保留最近20个完整版本，超过后自动归档最早的版本。

#### 7.4.2 版本对比

版本对比功能允许用户选择任意两个版本进行Diff对比。前端使用diff库的createPatch函数生成unified
diff，然后由react-diff-viewer-continued渲染。对话式修改支持用户选中代码段后在聊天中描述修改需求，Agent生成修改后的新版本。

### 7.5 部署管线

#### 7.5.1 部署流程设计

部署管线封装Vercel API
v13的完整部署能力，实现"文件收集、SHA计算、文件上传、部署创建、状态轮询"的五步流程
[^73]
[^74]。部署流程完全异步------用户发送"部署"指令后，AgentHub立即返回部署状态卡片，后续通过SSE实时推送进度更新。

    # services/vercel_deploy.py
    class VercelDeployer:
        def __init__(self, token: str):
            self.token = token
            self.base_url = "https://api.vercel.com"
        
        async def deploy(self, files: dict[str, str], project_name: str) -> str:
            """Deploy files to Vercel
            
            Args:
                files: dict of {path: content}
                project_name: Vercel project name
                
            Returns:
                deployment_id
            """
            # 1. Calculate SHA-256 for each file
            file_shas = {path: sha256(content) for path, content in files.items()}
            
            # 2. Upload files
            for path, sha in file_shas.items():
                await self._upload_file(sha, files[path].encode())
            
            # 3. Create deployment
            deployment = await self._create_deployment(
                name=project_name,
                files=[{"file": path, "sha": sha} for path, sha in file_shas.items()]
            )
            
            return deployment["id"]
        
        async def get_status(self, deployment_id: str) -> dict:
            """Get deployment status"""
            resp = await self._request("GET", f"/v13/deployments/{deployment_id}")
            return {
                "status": resp["readyState"],  # QUEUED/BUILDING/READY/ERROR
                "url": resp.get("url"),
                "error": resp.get("errorMessage")
            }

#### 7.5.2 部署平台适配

部署平台适配层抽象了Vercel和Netlify的共同操作（创建部署、查询状态、获取URL），具体平台差异在适配器内部处理。Vercel使用SHA-based文件上传（先计算SHA，仅上传不存在的文件），Netlify使用ZIP文件上传。部署配置根据产物类型自动推断框架预设（Next.js、React、Vue等），减少用户配置负担
[^75] [^76]。

  -----------------------------------------------------------------------------------------
  部署平台     上传方式            状态查询                免费额度     适用场景
  ------------ ------------------- ----------------------- ------------ -------------------
  Vercel       SHA-based文件上传   GET                     100GB/月     Next.js/React项目
                                   /v13/deployments/{id}                

  Netlify      ZIP文件上传         GET /deploys/{id}       100GB/月     通用静态站点
  -----------------------------------------------------------------------------------------

#### 7.5.3 部署状态实时推送

部署状态通过SSE实时推送给前端，推送频率为每2秒轮询一次部署平台API。状态流转为：pending（等待）→
building（构建中）→ deploying（分发中）→
ready（就绪）或error（错误）。前端部署状态卡片根据状态显示不同UI：pending为灰色转圈，building为蓝色进度条，deploying为紫色进度条，ready为绿色对勾+可点击URL，error为红色错误信息+重试按钮
。

## 8. 安全与性能设计

### 8.1 认证与授权

#### 8.1.1 JWT认证

AgentHub采用JWT（JSON Web
Token）实现无状态认证。用户登录后服务端签发包含user_id、exp（过期时间）和iat（签发时间）的JWT
Token，前端存储在localStorage中。每次API请求和WebSocket连接时在Header中携带Token，服务端中间件验证Token的有效性和过期时间。Token过期时间为7天，支持静默刷新（在Token过期前自动续期）。

#### 8.1.2 API Key管理

用户自建Agent时输入的API
Key通过Fernet对称加密后存储在数据库中。加密密钥通过环境变量注入，不在代码中硬编码。Agent调用时解密Key并注入请求的Header中，解密过程仅在服务端内存中完成，Key不以明文形式传输到前端。支持通过环境变量名引用API
Key（如`ARK_API_KEY`），避免在数据库中存储敏感信息。

### 8.2 输入安全

#### 8.2.1 消息内容过滤

用户输入的消息在发送到Agent之前经过内容安全过滤，包括XSS防护（转义HTML特殊字符）、SQL注入防护（参数化查询）和提示词注入防护。提示词注入防护通过检测常见的注入模式（如"ignore
previous instructions"、"you are now
DAN"）并在发现时拦截请求，防止恶意用户操控Agent行为 。

#### 8.2.2 产物沙箱隔离

网页预览产物在sandbox
iframe中执行，sandbox属性限制为`allow-scripts allow-same-origin`。对于不可信内容（用户上传的HTML），移除`allow-same-origin`以防止iframe内脚本访问父窗口。CSP头设置为`script-src 'self' 'unsafe-inline'; frame-ancestors 'self'`，禁止外部脚本加载和跨域iframe嵌入
。

### 8.3 代码沙箱隔离

AgentHub不直接执行Agent生成的代码（代码执行由外部Agent平台负责），但在网页预览场景中需要渲染用户生成的HTML/JS。预览iframe使用最严格的sandbox配置：`sandbox="allow-scripts"`（仅允许脚本执行，禁止表单提交、弹窗、本地存储访问等）。对于需要网络请求的预览（如调用外部API），通过Service
Worker代理请求并实施CORS策略限制可访问的域名。

### 8.4 性能优化

#### 8.4.1 前端性能

前端性能优化围绕三个关键点展开。首屏加载：Monaco
Editor通过CDN懒加载减少初始bundle体积（从5MB降至按需加载）；消息列表超过50条启用虚拟滚动（react-virtuoso），只渲染可视区域的消息；Next.js
Image组件自动优化图片大小和格式。运行时性能：使用React.memo和useMemo减少不必要的重渲染；Zustand的selector模式确保组件只订阅需要的状态片段。流式渲染：AI响应通过SSE流式传输，用户无需等待完整响应即可看到内容逐字出现。

#### 8.4.2 后端性能

后端性能优化包括数据库层面和API层面。数据库：为高频查询列创建复合索引（messages表的conversation_id +
sequence、conversations表的last_message_at），消息分页使用cursor-based方案避免offset在大数据量下的性能劣化
。API层面：会话列表和Agent列表使用Redis缓存（TTL
5分钟），减少数据库查询；WebSocket连接使用asyncio实现高并发，单实例支持1000+并发连接；LangGraph的图执行使用异步模式避免阻塞事件循环。

#### 8.4.3 流式响应优化

流式响应通过SSE实现，关键优化点包括：使用aiohttp的StreamingResponse替代同步Response，确保在接收到Agent的第一个token时立即推送给前端；Agent适配器的_to_stream_event转换函数必须是非阻塞的（中位数低于80微秒
），避免在转换环节引入延迟；前端使用Vercel AI SDK的useChat
Hook自动处理SSE连接管理、消息缓冲和增量渲染，无需手动维护SSE连接状态 。

## 9. 开发计划

### 9.1 里程碑规划

#### 9.1.1 Phase 1: 基础设施（Day 1-5）

Phase
1的目标是搭建前后端基础架构，实现核心数据模型的CRUD和基础UI框架。前端完成Next.js项目初始化、shadcn/ui组件库集成、Zustand
Store和TanStack
Query配置、聊天界面基础布局（三栏结构、会话列表、消息输入框）。后端完成FastAPI项目初始化、PostgreSQL和Docker
Compose配置、核心数据模型的数据库迁移、基础CRUD API实现、JWT认证中间件。

Day
5的里程碑是"前后端基础架构完成，数据库可读写，前端UI框架可用"。这一里程碑的达成标志着团队可以从基础设施搭建转向业务功能开发。

#### 9.1.2 Phase 2: 核心功能（Day 6-12）

Phase
2是项目的核心开发阶段，目标是实现IM聊天、Agent接入和Orchestrator的基础能力。Day
6-7实现WebSocket消息收发和实时通信，包括消息持久化、已读回执和打字指示器。Day
8-9实现Claude
Code和Codex两个内置Agent的适配器，完成统一适配器层的接口设计和Registry模式。Day
10-11实现Orchestrator的基础版本------意图分析、任务拆解和Agent路由调度。Day
12完成产物预览功能（代码高亮、HTML iframe预览）。

Day
12的里程碑是"IM聊天可用，Agent可对话，产物可预览"。这是项目的MVP里程碑，标志着核心用户流程已打通。

#### 9.1.3 Phase 3: 高级功能（Day 13-18）

Phase 3在MVP基础上添加高级功能和差异化特性。Day
13-14实现产物版本管理和Diff视图，包括版本快照存储、unified
diff生成和react-diff-viewer展示。Day 15-16实现部署发布功能（Vercel
API集成、部署状态卡片、SSE实时推送）。Day
17-18实现AI协作规范体系（Spec生成、Skill匹配、Rules应用），这是评审标准中30%权重的核心支撑。

Day 18的里程碑是"产物可版本管理，可部署发布，协作规范体系可用"。

#### 9.1.4 Phase 4: 打磨优化（Day 19-20）

Phase 4是项目的最后冲刺阶段，目标是UI打磨、Bug修复和Demo准备。Day
19进行UI细节打磨（动画效果、响应式适配、错误状态处理）和端到端测试。Day
20准备Demo视频（3分钟）和答辩材料，确保所有功能在演示环境中可正常运行。

### 9.2 技术风险与应对

  ------------------------------------------------------------------------------
  风险                    影响              缓解措施
  ----------------------- ----------------- ------------------------------------
  火山方舟API不稳定       Agent不可用       准备Mock数据兜底，实现离线模式

  LangGraph学习曲线陡峭   编排功能延期      Day 1-2集中学习，从简单Chain开始

  WebSocket连接不稳定     实时通信失效      实现自动重连（指数退避）和消息队列

  Monaco Editor体积过大   首屏加载慢        CDN懒加载，显示loading占位符

  多Agent并行代码冲突     产物质量差        实现diff冲突检测和自动合并

  20天开发周期紧张        功能做不完        严格执行MVP优先，P2功能可放弃
  ------------------------------------------------------------------------------

### 9.3 团队分工

  ----------------------------------------------------------------------------------
  角色              职责                            技术重点
  ----------------- ------------------------------- --------------------------------
  前端开发          UI/UX实现、交互逻辑、实时通信   Next.js
                                                    15、shadcn/ui、WebSocket/SSE

  后端开发          API设计、Agent编排、数据模型    FastAPI、LangGraph、PostgreSQL

  协作              API契约定义、每日站会、Code     前后端接口对齐
                    Review                          
  ----------------------------------------------------------------------------------

前端开发者的核心交付物包括：IM聊天界面（50%工作量）、产物预览组件（20%）、Agent管理界面（15%）、部署状态卡片（15%）。后端开发者的核心交付物包括：RESTful
API和WebSocket服务（30%）、Orchestrator引擎（30%）、统一适配器层（25%）、部署服务（15%）。

前后端通过API契约（OpenAPI/Swagger文档）对齐接口定义，在Phase
1期间完成所有API的契约定义，确保后续可以并行开发。每日15分钟站会同步进度和阻塞问题，每完成一个里程碑进行一次Code
Review。

[^1]:  DEV Community.
    https://dev.to/daniloab/how-to-integrate-multiple-llm-providers-without-turning-your-codebase-into-a-mess-provider-36g9

[^2]:  arXiv.org. https://arxiv.org/html/2604.09360v1

[^3]:  Github. https://github.com/WayneEcon/Antigravity-Manager_158

[^4]:  Github. https://github.com/Jint8888/Antigravity-Manager-JT

[^5]:  Github. https://github.com/chenjy16/go-springAi

[^6]:  Github. https://github.com/lbjlaq/Antigravity-Manager/tree/main

[^7]:  Hosted Deployment \| Server Compass.
    https://servercompass.app/blog/server-compass-vs-coolify-best-self-hosted-deployment-tools-in-2025

[^8]:  apiyi.com.
    https://help.apiyi.com/en/claude-code-goal-mode-keep-working-until-done-guide-en.html

[^9]:  DEV Community.
    https://dev.to/themachinepulse/do-you-need-state-management-in-2025-react-context-vs-zustand-vs-jotai-vs-redux-1ho

[^10]:  Tony Lee.
    https://tonylee.im/en/blog/three-spec-files-before-ai-agent-coding/

[^11]:  CSDN博客.
    https://blog.csdn.net/weixin_51960949/article/details/161024572

[^12]:  PkgPulse.
    https://www.pkgpulse.com/guides/tanstack-virtual-vs-react-window-vs-react-virtuoso-2026

[^13]:  新浪财经网.
    https://cj.sina.com.cn/articles/view/7879848900/1d5acf3c401902wu7u?froms=ggmp

[^14]:  CSDN博客.
    https://blog.csdn.net/qq_74421990/article/details/160191680

[^15]:  CSDN博客.
    https://blog.csdn.net/gitblog_00086/article/details/151088664

[^16]:  Tandem.
    https://usetandem.ai/blog/tandem-vs.-ai-sdk-vercel-which-should-product-teams-choose-for-2026

[^17]:  Github.
    https://github.com/TheDecipherist/claude-code-mastery-project-starter-kit

[^18]:  cnbugs.com. https://www.cnbugs.com/post-7091.html

[^19]:  火山引擎. https://www.volcengine.com/docs/82379/1399008

[^20]:  火山引擎. https://www.volcengine.com/docs/82379/1494384

[^21]:  arXiv.org. https://arxiv.org/html/2504.21030v1

[^22]:  lobehub.com.
    https://lobehub.com/zh/skills/serendipityoneinc-srp-claude-code-marketplace-cloudflare-pages

[^23]:  CSDN博客.
    https://blog.csdn.net/weixin_29012765/article/details/158295628

[^24]:  boxsoftware.net.
    https://www.boxsoftware.net/how-to-implement-cursor-based-pagination-in-a-rest-api-with-node-js/

[^25]:  DEV Community.
    https://dev.to/elasticpath/improving-paging-performance-with-large-data-exports-5ccb

[^26]:  portkey.ai.
    https://portkey.ai/blog/open-ai-responses-api-vs-chat-completions-vs-anthropic-anthropic-messages-api

[^27]:  DEV Community.
    https://dev.to/whoffagents/vercel-ai-sdk-usechat-in-production-lessons-from-30-days-of-real-traffic-4gbo

[^28]:  DEV Community.
    https://dev.to/whoffagents/vercel-ai-sdk-usechat-in-production-streaming-errors-and-the-patterns-nobody-writes-about-4ecf

[^29]:  Vercel. https://vercel.com/academy/ai-sdk/basic-chatbot

[^30]:  assistant-ui.com. https://www.assistant-ui.com/docs/ui/markdown

[^31]:  稀土掘金. https://juejin.cn/post/7626210940011790390

[^32]:  tencent.com.cn.
    https://cloud.tencent.com.cn/developer/article/2639437?policyId=1003

[^33]:  tianpan.co.
    https://tianpan.co/blog/2026-04-16-stateful-conversations-database-scale-session-store

[^34]:  Black Hills Information Security.
    https://www.blackhillsinfosec.com/model-context-protocol/

[^35]:  volcengine.com.
    https://developer.volcengine.com/articles/7617691521110376491

[^36]:  DEV Community.
    https://dev.to/polliog/server-sent-events-beat-websockets-for-95-of-real-time-apps-heres-why-a4l

[^37]:  稀土掘金. https://juejin.cn/post/7571475192489951242

[^38]:  Jimmy Song 的个人博客.
    https://jimmysong.io/zh/book/ai-handbook/agent/multi-agent/

[^39]:  Github. https://github.com/sanbuphy/learn-coding-agent

[^40]:  Github.
    https://github.com/wquguru/harness-books/blob/main/book1-claude-code/chapter-03-query-loop-heartbeat.md

[^41]:  byteplus.com. https://www.byteplus.com/en/topic/542166

[^42]:  DataCamp. https://www.datacamp.com/tutorial/openai-responses-api

[^43]:  eesel.ai. https://www.eesel.ai/blog/openai-api-vs-anthropic-api

[^44]:  LangChain Forum.
    https://forum.langchain.com/t/unable-to-distinguish-between-reasoning-text-and-final-response-in-streaming-mode-with-tool-calls/2803

[^45]:  Nuvox AI.
    https://nuvox-ai.com/anthropic-claude-complete-technical-architecture-guide-2025/

[^46]:  Github. https://github.com/openai/codex/discussions/7782

[^47]:  gekko.de.
    https://gpt.gekko.de/openai-api-comparison-chat-responses-assistants-2025/

[^48]:  openai.com. https://developers.openai.com/api/docs/guides/tools

[^49]:  DEV Community.
    https://dev.to/wonderlab/open-source-project-of-the-day-part-4-opencode-a-powerful-ai-coding-agent-built-for-the-g05

[^50]:  火山引擎. https://www.volcengine.com/docs/82379/1399008#fbb11c3e

[^51]:  coze.cn.
    https://www.coze.cn/open/docs/developer_guides/create_bot?lang=zh-CN&open_in_browser=true

[^52]:  coze.cn.
    https://www.coze.cn/api/open/docs/developer_guides/nodejs_getting_started

[^53]:  arXiv.org. https://arxiv.org/html/2511.20920v1

[^54]:  arXiv.org. https://arxiv.org/html/2605.11360v1

[^55]:  galileo.ai.
    https://galileo.ai/blog/google-agent2agent-a2a-protocol-guide

[^56]:  Useful Functions.
    https://www.usefulfunctions.co.uk/2025/11/08/state-management-2024-redux-zustand-context/

[^57]:  systemdesignhandbook.com.
    https://www.systemdesignhandbook.com/guides/design-a-chat-system/

[^58]:  TrueConf.
    https://trueconf.com/blog/reviews-comparisons/chat-app-system-design

[^59]:  arXiv.org. https://arxiv.org/abs/2505.02279

[^60]:  Pulse.
    https://pulse-in.com/en/guidances/react-state-management-2024-guide

[^61]:  martinfowler.com.
    https://martinfowler.com/articles/exploring-gen-ai/harness-engineering.html

[^62]:  hirefullstackdeveloperindia.com.
    https://hirefullstackdeveloperindia.com/react-vs-vuejs

[^63]:  CSDN博客.
    https://blog.csdn.net/u010554324/article/details/149661022

[^64]:  Agent Skills. https://agentskills.io/home

[^65]:  cursor.com.
    https://forum.cursor.com/t/how-can-i-apply-ai-generated-changes-only-to-specific-code-lines-ive-selected/20894

[^66]:  jiangren.com.au.
    https://jiangren.com.au/blog/cursor-guide-07-rules-mdc-deep

[^67]:  Vibe Coding Academy.
    https://www.vibecodingacademy.ai/blog/cursor-rules-complete-guide

[^68]:  lobehub.com.
    https://lobehub.com/skills/majesticlabs-dev-majestic-marketplace-hierarchical-agents

[^69]:  DeployHQ.
    https://www.deployhq.com/blog/ai-coding-config-files-guide

[^70]:  factory.ai. https://docs.factory.ai/cli/configuration/agents-md

[^71]:  in web search: no API keys, no setup.
    https://openwalrus.xyz/blog/agent-prompt-systems

[^72]:  腾讯云. https://cloud.tencent.com/developer/article/2639437

[^73]:  Vercel.
    https://vercel.com/kb/guide/how-do-i-generate-an-sha-for-uploading-a-file-to-the-vercel-api

[^74]:  One.
    https://www.withone.ai/knowledge/vercel/conn_mod_def%3A%3AGIi152aO03U%3A%3AKTvTF_0ZTaS3tObzavwy0g

[^75]:  Vercel. https://vercel.com/docs/deployments

[^76]:  Docusaurus. https://docusaurus.io/docs/markdown-features/react
