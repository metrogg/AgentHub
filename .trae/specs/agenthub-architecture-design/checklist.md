# Checklist

## 系统架构总览
- [x] 逻辑架构图包含完整分层（表现层/网关层/编排层/Harness层/适配器层/基础设施层）
- [x] 物理架构图明确服务器节点、数据库集群、缓存层、沙箱环境、网络策略
- [x] 核心数据流覆盖"用户消息→IM会话→Orchestrator→Agent→Diff→预览→部署"全链路
- [x] 层间接口契约明确定义（通信协议、数据格式、错误处理）

## 技术选型
- [x] 前端方案有 2-3 个选项对比，给出明确推荐和理由
- [x] 后端运行时方案有性能/生态/学习成本量化对比
- [x] 数据库方案包含向量检索能力选型（pgvector或其他）
- [x] Agent框架策略有"自研 vs 开源框架"的清晰论证
- [x] 沙箱方案有安全性和实现复杂度的平衡分析
- [x] 技术选型总览表覆盖所有技术栈层级
- [x] 实施路线图按 MVP→Hardening→Scale 三阶段规划

## 模块设计
- [x] IM会话模块包含：WebSocket管理、消息持久化、@指令解析、多会话隔离
- [x] Orchestrator模块包含：任务状态机、DAG计划生成、Agent路由、失败降级、硬终止条件
- [x] Harness引擎包含：AsyncGenerator Loop、Tool Registry(Fail-Closed)、四级压缩管道、预算熔断、三层Memory
- [x] 适配器层包含：IAgentAdapter接口、Claude Code适配器方案、Codex适配器方案、故障切换
- [x] 代码Diff模块包含：git worktree隔离、三路合并视图、冲突检测
- [x] 预览沙箱包含：iframe+srcdoc、多设备视口、HMR热更新、安全隔离
- [x] 部署流水线包含：Build/Test/Deploy/Verify四阶段、健康检查、回滚
- [x] 基础设施包含：DB Schema、Redis缓存策略、日志可观测性

## 集成与部署标准
- [x] REST API 规范：命名约定、请求/响应格式、错误码、分页
- [x] WebSocket 协议：消息类型、心跳、重连策略
- [x] 环境配置：开发/测试/生产环境变量、密钥管理
- [x] CI/CD 流水线：代码检查→测试→构建→部署自动化

## 需求回写
- [x] 适配器层定义已修正（明确为 Agent 平台适配器）
- [x] MVP 裁剪清单已补充（Demo 必须实现 vs 架构预留）
- [x] 命名规范已统一（驼峰命名 + 数据库映射规则）