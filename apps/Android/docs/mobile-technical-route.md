# AgentHub 移动端技术路线

## 产品定位

移动端不是一个完整 IDE，也不承担代码执行。它是 AgentHub 的轻量 IM 入口：

- 像飞书/微信一样新建对话、选择 Agent、发送消息。
- 查看历史会话、流式输出、任务状态、Agent 产物。
- 对高风险操作做审批确认，例如写文件、执行命令、部署。
- 向电脑端发送命令，由电脑端或服务器上的 AgentHub Runtime 执行。
- 通过扫码连接网页端或客户端，共享会话、流式事件和运行状态。

## 推荐移动端架构

第一阶段建议使用原生 Android：

- UI：Kotlin + Jetpack Compose。
- 状态：ViewModel + StateFlow，按 MVI 思路维护单向数据流。
- 数据层：Repository 封装 REST、WebSocket、连接凭据、离线缓存。
- 本地存储：DataStore 保存连接信息和设备 token；Room 用于后续离线消息缓存。
- 后台能力：前台服务或 WorkManager 用于长任务状态保活；生产通知走 FCM。
- 扫码：下一步接入 CameraX + ML Kit Barcode Scanner。

不建议移动端直接复用现有 React Web UI。移动端后续需要深度接入扫码、推送、后台保活、系统分享、文件预览和安全权限，原生路线的长期摩擦更小。

## 通信架构

推荐采用“REST 快照 + WebSocket 事件流 + HTTP 命令”的结构。

### REST 快照

移动端启动、切换会话、网络重连时使用 REST 拉取权威状态：

- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/messages/:sessionId`
- `POST /api/messages/:sessionId`
- `POST /api/messages/:sessionId/cancel`

REST 适合做幂等重试、分页、离线恢复和冷启动同步。

### WebSocket 事件流

移动端连接 `/ws` 后订阅会话：

```json
{ "type": "session:join", "payload": { "sessionId": "..." } }
```

沿用当前 Web 端事件：

- `agent:typing`
- `message:stream`
- `message:completed`
- `message:metadata`
- `message:cancelled`
- `task:update`
- `preview:ready`
- `diff:ready`

移动端应该把 WebSocket 当作增量事件流，而不是唯一数据源；断线后重新 REST 拉快照。

### 命令发送

移动端发送的消息本质是远程命令：

```json
{
  "sessionId": "...",
  "content": "@coder 修复这个按钮样式",
  "clientMessageId": "mobile-generated-id",
  "requiresApproval": false
}
```

服务器需要支持 `clientMessageId` 去重，避免弱网重试导致重复执行。

## 是否需要服务器

需要“AgentHub Server”作为移动端和电脑端之间的控制面，但不一定第一天就需要云服务器。

### P0：局域网直连，不需要云服务器

电脑端或网页端启动现有 Hono/Bun Server。手机通过同一 Wi-Fi 访问电脑 IP：

```text
http://192.168.x.x:8000
```

优点：

- 开发最快，直接复用现有 REST 和 WebSocket。
- 运行凭据、工作区、CLI 权限都留在电脑端。
- 非常适合 MVP、内测、演示。

限制：

- 手机和电脑必须互通。
- 跨公网、NAT、公司网络、睡眠唤醒都不稳定。
- 没有系统级离线推送。

### P1：扫码配对 + 桌面本地网关

电脑端生成二维码：

```json
{
  "version": 1,
  "baseUrl": "http://192.168.1.20:8000",
  "pairingCode": "one-time-code",
  "expiresAt": "2026-05-25T12:00:00Z"
}
```

手机扫码后调用：

- `POST /api/mobile/pairings/claim`
- 服务端返回 `deviceToken`、`deviceId`、权限范围。
- 后续 REST/WS 都带 `Authorization: Bearer <deviceToken>`。

配对 token 必须一次性、短 TTL、可撤销。

### P2：云端中继，需要服务器

如果目标是“手机在外网也能看流式输出、审批、下发命令”，就需要云端 Relay/Sync Server：

- 手机与电脑都连云端 WebSocket。
- 云端只做鉴权、设备在线、消息中继、事件缓冲、推送触发。
- 代码执行仍由电脑端 AgentHub Runtime 完成。
- 手机离线时通过 FCM 发送通知，点击后再拉 REST 快照。

云端中继应该避免保存敏感项目文件和模型 Key。需要保存的最小数据是设备、会话索引、事件游标和通知摘要。

### P3：云端会话同步

如果需要多电脑、多手机共享完整历史，就把 SQLite 本地库抽象为可同步存储：

- 本地 SQLite 继续作为桌面缓存。
- 云端 PostgreSQL/Supabase/自建服务保存用户、设备、会话、消息、审计事件。
- Web/Desktop/Android 都走同一认证和事件协议。

这一步会显著增加账号体系、隐私、安全和运维成本，不建议作为 MVP 起点。

## 安全边界

移动端发出的任何“执行类消息”都应视为远程控制命令：

- 设备配对必须显示设备名、时间、IP，可随时撤销。
- Token 分为 read、chat、approve、execute scopes。
- 高风险操作仍需要二次确认，移动端只能 approve/reject。
- WebSocket 连接需要鉴权，不能继续沿用当前单用户无鉴权模式。
- 所有命令写入审计事件：设备、会话、命令、时间、结果。
- 二维码不能直接暴露长期 token，只能暴露短期 pairing code。

## 当前服务端需要补的能力

现有服务端已经有会话、消息、WebSocket 房间和流式事件。移动端化需要新增：

1. `mobile_devices` 表：设备 ID、名称、token hash、scopes、lastSeen、revokedAt。
2. `mobile_pairings` 表：一次性配对码、过期时间、claimedAt。
3. `POST /api/mobile/pairings`：电脑端生成二维码 payload。
4. `POST /api/mobile/pairings/claim`：手机认领并换取 device token。
5. REST/WS 鉴权中间件：支持移动端 Bearer token。
6. WebSocket 多订阅：支持订阅多个会话或 workspace，而不是只 join 一个 session。
7. `clientMessageId` 去重：移动端弱网重试时不重复执行命令。
8. 通知事件摘要：供 FCM 或本地通知使用。

## 开发分期

### Milestone 1：Android 本地直连骨架

- Kotlin + Compose 工程。
- 手动输入 `baseUrl` 连接电脑端 Server。
- 拉取会话列表和消息。
- 发送消息到当前会话。
- 接收 WebSocket 流式输出。

### Milestone 2：扫码配对

- 桌面端设置页显示二维码。
- Android 端 CameraX 扫码。
- 服务端签发 device token。
- 连接信息存入 DataStore。

### Milestone 3：审批和产物预览

- 移动端渲染 approval card。
- 支持 approve/reject。
- diff、preview、deploy artifact 移动端只读预览。

### Milestone 4：外网中继和通知

- Relay server。
- 设备在线状态。
- FCM 推送。
- 事件游标和断线补偿。
