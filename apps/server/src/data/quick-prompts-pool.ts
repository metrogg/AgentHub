/**
 * 预生成的快速对话气泡池（100 条）。
 * 启动时加载，不依赖 LLM，前端始终有内容可展示。
 */

export interface QuickPromptItem {
  id: string
  label: string
  prompt: string
}

const RAW: Array<[string, string]> = [
  ['帮我写一个 TODO 应用', '帮我用 React + TypeScript 写一个功能完整的 TODO 应用，支持增删改查和本地持久化'],
  ['解释 Git rebase', '用通俗易懂的方式解释 Git rebase 和 Git merge 的区别，各适合什么场景'],
  ['Python 爬虫入门', '教我用 Python 写一个简单的网页爬虫，从零开始，包含完整代码和注释'],
  ['设计 RESTful API', '帮我设计一个博客系统的 RESTful API，包含用户、文章、评论模块'],
  ['Docker 部署指南', '手把手教我把一个 Node.js 项目用 Docker 容器化并部署到服务器'],
  ['SQL 查询优化', '我有一个慢查询，帮我分析 SQL 执行计划并给出优化建议'],
  ['写一份技术简历', '帮我写一份前端工程师的技术简历，突出项目经验和技术栈'],
  ['解释 React Hooks', '详细解释 React useEffect 的工作原理和常见陷阱'],
  ['搭建 CI/CD 流水线', '帮我用 GitHub Actions 搭建一个完整的 CI/CD 流水线'],
  ['代码审查建议', '请审查我最近提交的代码，指出潜在问题和改进空间'],
  ['TypeScript 类型体操', '帮我实现几个实用的 TypeScript 高级类型工具'],
  ['设计数据库表结构', '帮我设计一个电商系统的数据库表结构，考虑扩展性和性能'],
  ['WebSocket 实时通信', '教我用 WebSocket 实现一个实时聊天功能'],
  ['前端性能优化', '分析我的前端项目，给出首屏加载性能优化方案'],
  ['写单元测试', '帮我为这个函数编写完整的单元测试用例，覆盖边界情况'],
  ['算法题讲解', '用动画思路讲解动态规划的核心思想和解题模板'],
  ['Linux 运维命令', '整理一份常用的 Linux 服务器运维命令速查表'],
  ['CSS 布局技巧', '用 Flexbox 和 Grid 实现一个复杂的响应式页面布局'],
  ['正则表达式入门', '用实际例子教我正则表达式，从基础语法到高级用法'],
  ['安全防护清单', '帮我检查项目的安全漏洞，生成一份安全加固清单'],
  ['Redis 缓存策略', '帮我设计一个合理的 Redis 缓存策略，包含过期和淘汰机制'],
  ['微服务架构设计', '帮我把单体应用拆分成微服务架构，给出拆分策略和通信方案'],
  ['写一个 CLI 工具', '用 Node.js 写一个命令行工具，支持参数解析和交互式提示'],
  ['Prometheus 监控', '帮我搭建 Prometheus + Grafana 监控系统，监控 Node.js 服务'],
  ['JWT 认证实现', '帮我实现基于 JWT 的用户认证系统，包含登录、刷新和权限校验'],
  ['GraphQL 入门', '用一个实际项目教我 GraphQL 的基本用法和最佳实践'],
  ['Nginx 配置指南', '帮我配置 Nginx 反向代理、负载均衡和 HTTPS'],
  ['Rust 入门教程', '用实际例子教我 Rust 的所有权和借用机制'],
  ['Monorepo 工程化', '帮我搭建一个 pnpm workspace 的 Monorepo 项目结构'],
  ['消息队列选型', '帮我对比 Kafka、RabbitMQ、Redis Stream 的适用场景并给出选型建议'],
  ['前端状态管理', '帮我对比 Zustand、Jotai、Redux 的优劣并推荐适合的方案'],
  ['写一个爬虫框架', '用 Python 写一个可配置的异步爬虫框架，支持并发和重试'],
  ['PostgreSQL 进阶', '教我 PostgreSQL 的窗口函数、CTE 和 JSONB 高级用法'],
  ['移动端适配方案', '帮我实现一个移动端 H5 页面的响应式适配方案'],
  ['日志系统设计', '帮我设计一个结构化日志系统，支持级别过滤和远程收集'],
  ['OAuth 2.0 接入', '帮我接入 GitHub OAuth 2.0 登录，包含完整流程和代码'],
  ['Vue 3 组合式 API', '用组合式 API 重构一个选项式 Vue 组件，展示最佳实践'],
  ['Kubernetes 入门', '教我 Kubernetes 的核心概念和基本操作，从 Pod 到 Deployment'],
  ['Sentry 错误监控', '帮我接入 Sentry 实现前端错误监控和性能追踪'],
  ['设计模式实战', '用 TypeScript 实现几个常用的设计模式并解释适用场景'],
  ['Elasticsearch 搜索', '帮我搭建一个全文搜索功能，用 Elasticsearch 实现'],
  ['自动化测试策略', '帮我制定一个项目的自动化测试策略，包含单元、集成和 E2E 测试'],
  ['Go 语言入门', '用实际项目教我 Go 语言的基础语法和并发编程'],
  ['前端国际化方案', '帮我实现 React 应用的多语言国际化方案'],
  ['定时任务系统', '帮我设计一个可靠的定时任务调度系统'],
  ['代码规范配置', '帮我配置 ESLint + Prettier + Husky 的完整代码规范工具链'],
  ['WebSocket 断线重连', '帮我实现 WebSocket 的心跳检测和断线自动重连机制'],
  ['文件上传服务', '帮我实现一个支持大文件分片上传和断点续传的服务'],
  ['数据可视化方案', '帮我用 ECharts 或 D3.js 实现一个交互式数据看板'],
  ['Python 数据分析', '教我用 Pandas 做数据清洗和分析，用实际数据集演示'],
  ['SSE 服务端推送', '帮我用 Server-Sent Events 实现服务端实时推送功能'],
  ['Vite 插件开发', '教我开发一个自定义的 Vite 插件，解决实际构建问题'],
  ['Terraform 基础设施', '帮我用 Terraform 管理云服务器基础设施，实现 IaC'],
  ['前端路由原理', '手写一个简化版的前端路由器，理解 Hash 和 History 模式'],
  ['缓存策略设计', '帮我设计 HTTP 缓存策略，合理使用强缓存和协商缓存'],
  ['C++ 智能指针', '解释 C++ 智能指针的原理和使用场景，避免内存泄漏'],
  ['API 网关设计', '帮我设计一个 API 网关，实现限流、鉴权和路由转发'],
  ['前端构建优化', '帮我优化 Vite/Webpack 构建速度，减少打包体积'],
  ['异步编程模式', '对比 Promise、async/await 和 RxJS 的异步编程模式'],
  ['设计系统搭建', '帮我搭建一个可复用的 UI 组件设计系统'],
  ['Playwright E2E 测试', '帮我用 Playwright 编写端到端自动化测试'],
  ['BFF 层设计', '帮我设计一个 BFF 层，聚合多个微服务的数据给前端使用'],
  ['WebAssembly 入门', '教我 WebAssembly 的基本原理和实际应用场景'],
  ['Deno vs Node.js', '对比 Deno 和 Node.js 的优劣，适合什么项目使用'],
  ['前端安全实践', '帮我检查并修复 XSS、CSRF、点击劫持等前端安全问题'],
  ['分布式系统基础', '解释分布式系统中的 CAP 定理和一致性模型'],
  ['代码重构指南', '帮我重构这个函数，提升可读性和可维护性'],
  ['MongoDB 实战', '教我 MongoDB 的聚合管道和索引优化'],
  ['前端动画方案', '帮我实现流畅的页面过渡动画和微交互效果'],
  ['Kafka 消息消费', '帮我实现一个可靠的 Kafka 消费者，处理消息确认和重试'],
  ['Python 异步编程', '教我 Python asyncio 的核心概念和实际应用'],
  ['Chrome 扩展开发', '帮我开发一个实用的 Chrome 浏览器扩展'],
  ['低代码平台设计', '帮我设计一个简单的低代码表单搭建平台'],
  ['JWT vs Session', '对比 JWT 和 Session 认证方案的优劣和适用场景'],
  ['前端监控体系', '帮我搭建前端性能监控和用户行为分析系统'],
  ['Swift iOS 入门', '用 SwiftUI 写一个简单的 iOS 应用入门项目'],
  ['gRPC 通信', '帮我用 gRPC 实现服务间的高效通信'],
  ['前端工程化清单', '帮我整理一份前端项目的工程化配置清单'],
  ['Kotlin Android', '用 Kotlin 写一个 Jetpack Compose 的 Android 应用'],
  ['数据库迁移方案', '帮我制定一个安全的数据库迁移和版本管理方案'],
  ['Serverless 实战', '帮我用云函数实现一个 Serverless 后端服务'],
  ['React Native 入门', '用 React Native 写一个跨平台的移动应用'],
  ['中间件设计模式', '帮我实现一个洋葱模型的中间件系统'],
  ['前端 A/B 测试', '帮我实现前端 A/B 测试框架，支持灰度发布'],
  ['CORS 跨域解决', '帮我彻底搞懂 CORS 跨域问题并给出各种解决方案'],
  ['WASM 图像处理', '用 WebAssembly 加速前端图像处理任务'],
  ['AI Agent 开发', '帮我设计和实现一个简单的 AI Agent 框架'],
  ['流式输出实现', '帮我实现类似 ChatGPT 的流式打字机效果'],
  ['向量数据库入门', '教我向量数据库的基本概念和在 RAG 中的应用'],
  ['RAG 应用搭建', '帮我搭建一个基于 RAG 的知识库问答系统'],
  ['Prompt Engineering', '帮我优化这个 AI Prompt，提升输出质量和稳定性'],
  ['MCP 协议理解', '帮我理解 Model Context Protocol 的工作原理和使用方式'],
  ['多 Agent 协作', '帮我设计一个多 Agent 协作系统的架构方案'],
  ['Function Calling', '帮我实现 LLM 的 Function Calling 功能'],
  ['Embedding 实战', '教我文本 Embedding 的原理和实际应用场景'],
  ['AI 代码审查', '帮我用 AI 辅助进行代码审查，发现潜在问题'],
  ['Token 计费优化', '帮我优化 LLM 调用的 Token 消耗，降低 API 成本'],
  ['知识图谱入门', '教我知识图谱的基本概念和构建方法'],
  ['AI 对话记忆', '帮我设计一个 AI 对话系统的上下文记忆管理方案'],
  ['向量检索优化', '帮我优化向量检索的准确率和召回率'],
]

function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function buildId(label: string): string {
  return `quick-${stableHash(label).toString(36)}`
}

export const QUICK_PROMPT_POOL: QuickPromptItem[] = RAW.map(([label, prompt]) => ({
  id: buildId(label),
  label,
  prompt,
}))
