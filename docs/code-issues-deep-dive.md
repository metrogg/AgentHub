# 代码深度审查：具体问题清单

> 审查范围：`apps/server/src/` 核心服务层、`packages/db/`  Schema 层
> 审查维度：竞态条件、资源泄漏、类型安全、逻辑错误、边界条件、错误处理、性能隐患

---

## 1. 竞态条件与并发安全问题

### 1.1 `agent-runner.ts:107` — `cancelAgentReply` 与 `runAgentReply` 非原子操作

```typescript
// agent-runner.ts
export async function runAgentReply(sessionId: string, ...) {
  cancelAgentReply(sessionId)          // 第1步：删除旧 run
  const run = { cancelled: false, controller: new AbortController() }
  activeRuns.set(sessionId, run)       // 第2步：设置新 run
```

**问题**：两个操作之间没有锁。如果同一 session 收到两条消息，两个 `runAgentReply` 调用可能交错执行：
- 线程 A 执行 `cancelAgentReply` 删除旧 run
- 线程 B 执行 `cancelAgentReply` 发现没有 run，返回 false
- 线程 B 创建新 run 并写入 activeRuns
- 线程 A 创建新 run 并**覆盖**线程 B 的 run
- 结果：线程 B 的 AbortController 丢失，无法被取消，且其执行结果会写入 DB，但 WebSocket 广播可能被线程 A 的结果覆盖

**修复建议**：使用 `Map` + `Atomics` 或简单的互斥锁：

```typescript
const runLocks = new Map<string, Promise<void>>()

async function withRunLock(sessionId: string, fn: () => Promise<void>) {
  while (runLocks.has(sessionId)) await runLocks.get(sessionId)
  let release: () => void
  const lock = new Promise<void>((r) => { release = r })
  runLocks.set(sessionId, lock)
  try { await fn() } finally { runLocks.delete(sessionId); release!() }
}
```

---

### 1.2 `concurrency.ts:13` — Semaphore 超时后未从队列移除

```typescript
async acquire(timeoutMs = 30000): Promise<() => void> {
  if (this.permits > 0) { this.permits--; return () => this.release() }
  return new Promise((resolve, reject) => {
    const item = { resolve, reject }
    this.queue.push(item)
    if (timeoutMs > 0) {
      setTimeout(() => {
        const idx = this.queue.indexOf(item)
        if (idx >= 0) {
          this.queue.splice(idx, 1)
          reject(new Error(`Semaphore acquire timeout`))
        }
      }, timeoutMs)
    }
  })
}
```

**问题**：
1. 当 `permits === 0` 时，调用者进入队列等待。如果此时超时，`item` 从队列移除，但 **permits 没有增加**。这本身是对的（因为还没拿到许可），但如果队列中前面的人超时，后面的人永远不会被唤醒——因为 `release()` 只检查 `queue.length > 0`，然后 `shift()` 给下一个。实际上这个逻辑是对的...

等等，让我再仔细看。问题在于：如果 `permits > 0`，直接返回 release 函数，这个 release 函数调用时会 `permits++`。但如果 `permits === 0`，进入队列。当有人 release 时，队列中的第一个拿到 permit，但不会增加 permits（因为 permit 只是从释放者转移给等待者）。这个逻辑是正确的。

真正的问题是：**超时后如果刚好在 splice 之前被 resolve**，会出现双重释放。更关键的是：超时只从队列移除，但如果 permits 之前被减到负数（不应该），那就有问题。实际上 permits 初始为 Math.max(0, initialPermits)，所以不会负数。

真正的问题是：**没有处理 `this.permits === 0` 时并发 acquire 的 FIFO 顺序问题吗？** 不是，队列是 FIFO 的。

让我重新审视——实际上这段代码有一个微妙的竞态条件：
- 两个线程 A 和 B 同时进入 `acquire`，`permits === 1`
- A 检查 `permits > 0`，递减到 0，返回
- B 检查 `permits > 0`（此时是 0），进入等待队列
- A 调用 release，`permits++` 到 1，但 `queue.length === 0`，所以不会给 B
- B 在队列中永远等待，除非再来一次 release

不对，`queue.length` 是 1 啊。B 已经被 push 到队列了。A release 的时候 `queue.length > 0`，所以会把 permit 给 B。

哦，看错了。这个逻辑是对的。让我找真正的问题。

**真正的问题**：`TaskScheduler.runTask` 中 `release` 在 `finally` 中调用，但如果 `semaphore.acquire` 超时 reject，`runTask` 根本不会开始执行，但 `release` 变量还没有赋值，会导致 `finally` 中调用 undefined。等等，`acquire` 如果超时 reject，整个 `runTask` 就会抛出异常，不会进入 try 块，所以 `release` 不会调用。这没问题。

实际上 Semaphore 的问题是：**timeout 为 0 时不会超时**，但如果设置为正数，超时后从队列 splice，此时如果有并发的 release 正在执行，release 可能会拿到一个已经被 splice 掉的 item 并 resolve 它——不对，release 是 shift()，如果 item 已经被 splice 了，shift() 会拿到队列中的其他 item。但如果 item 刚好是队列第一个，被 splice 后 shift() 拿到第二个，这没问题。

让我换个思路。真正的问题是：超时后 reject 了 Promise，但如果有另一个 release 正在执行，release 中的 `next.resolve(() => this.release())` 会给已经 reject 的 Promise 也 resolve 一次。但 Promise 只能 settle 一次，所以第二个 resolve 会被忽略。这不是大问题。

**真正严重的问题**：`indexOf` + `splice` 的时间复杂度是 O(n)，如果队列很长会慢。但这不是竞态条件。

让我重新审视整个 Semaphore：实际上这个实现基本正确。问题在于 `ConcurrencyController.acquire`（line 177）：

```typescript
async acquire(provider?: string, timeoutMs = 30000): Promise<() => void> {
  const releaseSemaphore = await this.agentSemaphore.acquire(timeoutMs)
  let releaseToken: (() => void) | undefined
  if (provider) {
    const bucket = this.tokenBuckets.get(provider)
    if (bucket) { await bucket.consume(1) }
  }
  return () => { releaseSemaphore(); if (releaseToken) releaseToken() }
}
```

这里**没有 timeout 控制 TokenBucket 的 consume**！如果 TokenBucket 需要等待很长时间，`agentSemaphore` 已经被占用了，但返回的 release 函数还没返回给调用者。这意味着 agentSemaphore 被占用但 caller 还没拿到返回的 release 函数。如果 caller 在这之间被取消（比如 AbortSignal），agentSemaphore 永远不会被释放。

但这属于资源泄漏，我放在下面讲。

---

### 1.3 `orchestrator-engine.ts:95` — `activeEngines` 非线程安全的 Map 操作

```typescript
OrchestratorEngine.activeEngines.set(runId, this)
```

**问题**：`cancelActiveRun` 和 `startRun` 在不同 run 之间没有协调。虽然每个 runId 是唯一的，但如果同一个 runId 被重复使用（虽然 UUID 不太可能），或者 `cancelActiveRun` 在 `startRun` 设置之前被调用，engine 可能不会被正确取消。

更关键的是：**`retryTask` 方法创建新的 `OrchestratorEngine` 实例，但 `activeEngines` 中没有它的引用**：

```typescript
async retryTask(params: { ... }) {
  // 没有 this.activeEngines.set(...)
  const result = await this.executeTask(...)
}
```

如果用户在重试任务时点击取消，`cancelActiveRun(runId)` 只能取消 `scheduler`，但 `executeTask` 内部的 `runAgentReply` 使用的是新创建的 `AbortController`（line 77：`new AbortController().signal`），与 scheduler 的 signal 无关。这意味着**重试任务无法被取消**。

---

### 1.4 `task-scheduler.ts:41` — `runTask` 异常时 graph 状态不一致

```typescript
this.runTask(task, graph, results, executor, runController.signal).catch((err) => {
  logger.error({ err, taskId: task.id }, 'Task execution error')
})
```

**问题**：`runTask` 内部如果抛出异常（不是 executor 返回 failed），graph 状态已经被设为 'running'（line 40），但异常后 `runTask` 的 catch 会设为 'failed'（line 106）。然而，**如果异常发生在 `graph.setStatus(task.id, 'running')` 之后、`try` 块之前**，比如 `semaphore.acquire` 超时，graph 状态会一直是 'running'，导致整个 plan 永远无法完成。

实际上看代码：
```typescript
graph.setStatus(task.id, 'running')  // line 40
this.runTask(...).catch(...)          // line 41
```

`runTask` 内部有 `try...catch...finally`，所以异常会被捕获。但如果 `semaphore.acquire` 在 `runTask` 内部超时（line 90），异常会被 catch 并设为 'failed'。但如果 `graph.setStatus` 在 `runTask` 外部已经执行了，而 `runTask` 还没开始...不，`graph.setStatus` 是在 `runTask` 调用之前，所以如果 `runTask` 的 Promise 还没创建就抛异常...不会，`.catch()` 会捕获 reject。

**真正的问题**：`runTask` 的 catch 中标记为 'failed'，但 `runTask` 的 `try` 块中如果 `executor` 返回 `result.status === 'done'`，设为 'done'；否则设为 'failed'。但如果 `executor` 本身抛出异常，进入 catch，设为 'failed'。这看起来是对的。

但有一个边界情况：**如果 `runTask` 的 `semaphore.acquire` 成功，但 `executor` 执行期间 `runController.signal` 被 abort**，`combinedSignal` 会触发 abort，executor 应该处理这个。但问题在于：如果 executor 不响应 AbortSignal（比如 LLM 调用），`Promise.race` 或者 `signal` 只是提示作用，executor 可能还在运行。这属于 LLM 调用层的责任，不是 scheduler 的。

---

## 2. 资源泄漏

### 2.1 `agent-runner.ts:66` — WebSocket 错误静默吞掉

```typescript
for (const ws of room) {
  if (ws.readyState === 1) {
    try {
      ws.send(payload)
    } catch {
      // WebSocket may close between readyState check and send; ignore.
    }
  }
}
```

**问题**：虽然注释解释了原因，但**不记录任何日志**意味着如果 WebSocket 持续发送失败（比如某个客户端连接异常），开发者永远不会知道。更严重的是：**不清理失败的 WebSocket 连接**——如果 `ws.send` 持续失败，这个 ws 会一直在 room 中，每次广播都尝试发送，浪费 CPU。

**修复建议**：至少记录 debug 日志，并从 room 中移除持续失败的 ws。

---

### 2.2 `orchestrator-engine.ts:642-646` — 超时定时器事件监听器泄漏

```typescript
const TASK_TIMEOUT_MS = 300_000
const timeoutPromise = new Promise<never>((_, reject) => {
  const timer = setTimeout(() => reject(...), TASK_TIMEOUT_MS)
  signal.addEventListener('abort', () => {
    clearTimeout(timer)
    reject(new Error('任务已取消'))
  }, { once: true })
})
```

**问题**：如果任务在超时之前正常完成，`Promise.race` 会返回 `runAgentReply` 的结果，但 `timeoutPromise` 中的 `signal` 事件监听器**没有被移除**（虽然设置了 `{ once: true }`，但如果 signal 从未 abort，`AbortSignal` 内部仍然持有对这个监听器的引用，直到 signal 被 gc）。

对于 `AbortSignal`，如果它永远不会被 abort，设置 `{ once: true }` 的监听器确实不会被自动移除，但也不会被触发。这不是内存泄漏，因为 signal 被 gc 时监听器也会被释放。

**真正的问题**：如果 `runAgentReply` 完成但 signal 后来被 abort（比如用户点击取消），`timeoutPromise` 的 abort 监听器会执行 `reject`，但此时 `Promise.race` 已经 resolved 了，reject 会被忽略。这不是泄漏。

实际上这里的问题是：**timer 在任务正常完成后没有被清理**。如果 signal 不 abort，`timer` 会继续运行 5 分钟，然后 reject 一个已经 resolved 的 Promise（被忽略）。虽然这不是内存泄漏（timer 会触发然后被清理），但如果短时间内有大量任务完成，会有大量 pending timers，可能拖慢事件循环。

**修复建议**：用 `AbortSignal.timeout()` 或手动清理 timer。

---

### 2.3 `task-scheduler.ts:47` — 200ms 忙等轮询

```typescript
while (!graph.allDone() && !runController.signal.aborted) {
  const readyTasks = graph.getReadyTasks()
  // ...
  await sleep(200)
}
```

**问题**：每 200ms 检查一次任务状态，如果任务执行 5 分钟，会轮询 1500 次。这是一个**忙等**模式，虽然用了 sleep，但仍然浪费了事件循环资源。更好的方式是用事件驱动：每个任务完成时触发一个事件，唤醒调度器。

---

### 2.4 `blackboard.ts:40-41` — 内存缓存无 TTL/上限

```typescript
private cache = new Map<string, Map<string, BlackboardEntry[]>>()
private subscribers = new Map<string, Map<string, Set<Subscriber>>>()
```

**问题**：
1. `cache` 按 namespace 存储，每个 namespace 内按 key 存储最多 20 个版本。但 namespace 本身没有数量上限。如果有大量 orchestrator run，每个 run 创建一个 namespace，内存会持续增长。
2. `subscribers` 也没有清理机制。虽然 `clearNamespace` 会移除 subscribers，但如果 caller 忘记调用，`subscribers` 会永久保留。
3. 更严重的是：**`readVersionsFromDb`（line 289）实际上只读缓存，不读数据库**：

```typescript
private readVersionsFromDb(namespace: string, key: string): BlackboardEntry[] {
  const ns = this.cache.get(namespace)
  if (!ns) return []
  return ns.get(key) ?? []
}
```

这个方法名字说 `FromDb`，但实际只读缓存！`write` 方法用它来计算 version（line 60-61）：

```typescript
const existing = await this.readVersionsFromDb(namespace, key)
const version = existing.length > 0 ? existing[existing.length - 1]!.version + 1 : 1
```

**如果缓存被 clear（比如 `clearNamespace` 被调用），下一次写入会从 version 1 开始**，但数据库中可能已经有 version > 1 的记录。这会导致**version 冲突**——虽然 UUID 主键不会冲突，但 version 会重复。

---

## 3. 类型安全问题

### 3.1 `execution-tracer.ts:54` — 多处 `@ts-ignore`

```typescript
if (filters.runId) {
  // @ts-ignore drizzle dynamic query
  conditions.push(eq(executionLogs.runId, filters.runId))
}
```

**问题**：`@ts-ignore` 掩盖了真实的类型问题。Drizzle 的动态查询需要 `.$dynamic()` 后才能用 `.where()`，但这里 `q = db.select().from(executionLogs).$dynamic()` 已经调用了。问题在于 `and()` 的参数类型不匹配。这不是严重问题，但**如果 Drizzle 升级改变了 API，这些 @ts-ignore 会掩盖编译错误**。

---

### 3.2 `orchestrator-engine.ts` — 大量 `as` 类型断言

```typescript
const plan = (runRow?.plan as ExecutionPlan | undefined) ?? { ... }
const val = bbEntry.value as { output: string; artifacts: Array<Record<string, unknown>> }
const msgArtifacts = (lastAgentMsg[0]?.metadata as Record<string, unknown> | null)?.artifacts as Array<Record<string, unknown>> | undefined
```

**问题**：类型断言绕过了编译时检查。如果数据库中存储的 JSON 结构与预期不符（比如 schema 变更后旧数据），运行时会出现 `undefined` 访问错误。例如 `val.output` 如果 val 没有这个字段，会返回 undefined 而不是抛出错误，但后续如果假设它存在就会有问题。

---

### 3.3 `messages.ts:874` — `parsePlan` 类型断言过于宽松

```typescript
function parsePlan(metadata: unknown): OrchestratorPlan | null {
  const plan = (metadata as { plan?: unknown } | null)?.plan
  if (!plan || typeof plan !== 'object') return null
  const candidate = plan as OrchestratorPlan
  if (candidate.kind !== 'orchestrator_plan' || !Array.isArray(candidate.tasks)) return null
  return candidate
}
```

**问题**：`candidate` 被断言为 `OrchestratorPlan`，但只检查了 `kind` 和 `tasks` 两个字段。如果 `tasks` 数组中的元素不符合 `PlanTask` 类型（比如缺少 `id` 或 `agentKey`），后续使用时会出运行时错误。应该在解析时做完整的 Zod 校验。

---

## 4. 逻辑错误与边界条件

### 4.1 `group-session.ts:30-37` — 误删 workspaceAgents 而非 sessionMembers

```typescript
if (selectedAgentIds && selectedAgentIds.length > 0) {
  const toDelete = allAgents.filter((a) => !selectedAgentIds.includes(a.id))
  if (toDelete.length > 0) {
    for (const agent of toDelete) {
      await db.delete(workspaceAgents).where(eq(workspaceAgents.id, agent.id))
    }
  }
}
```

**问题**：`syncGroupMembers` 的职责是同步群聊成员（sessionMembers），但这里直接删除了 `workspaceAgents`（工作区中的 Agent 定义）。这意味着**从前端传入 selectedAgentIds 会永久删除工作区中未选中的 Agent**，而不仅仅是把它们从群聊中移除。

虽然注释说 "清理工作区中未选中的旧 agents，只保留选中的"，但这与函数名 `syncGroupMembers` 的职责不符。如果调用者只想调整群聊成员而不删除 Agent 定义，这个函数会造成数据丢失。

---

### 4.2 `group-session.ts:39-54` — 未指定 selectedAgentIds 时自动去重

```typescript
} else {
  // 未指定选中 agents 时，自动清理 name 完全相同的重复 agent（保留最新的）
  const seenNames = new Map<string, string>()
  const toDelete: string[] = []
  for (const agent of allAgents) {
    const key = agent.name.trim().toLowerCase()
    if (seenNames.has(key)) {
      toDelete.push(agent.id)
    } else {
      seenNames.set(key, agent.id)
    }
  }
```

**问题**：
1. `allAgents` 没有按时间排序，所以 "保留最新的" 不成立——保留的是遍历顺序中第一个出现的。
2. 自动删除 Agent 定义是一个**副作用过强**的操作。函数名是 `syncGroupMembers`，但它在默默删除工作区数据。
3. `agent.name.trim().toLowerCase()` 如果 name 是空字符串，所有空名 Agent 都会被去重。

---

### 4.3 `agent-runner.ts:362-369` — `checkIsGroupSession` 每次调用都查数据库

```typescript
async function checkIsGroupSession(sessionId: string): Promise<boolean> {
  const [session] = await db.select({ type: sessions.type }).from(sessions).where(...)
  return session?.type === 'group'
}
```

**问题**：`runAgentReply` 每次调用都会查一次 session 类型。虽然 SQLite 很快，但如果群聊中多个 Agent 同时回复，会并发执行多次相同的查询。可以在 `runAgentReply` 的参数中直接传入 `isGroupSession`，或者缓存结果。

---

### 4.4 `agent-runner.ts:375-410` — `trimHistoryForHandoff` 硬编码消息 ID

```typescript
const summaryMsg: MessageRow = {
  id: 'context-summary',
  sessionId: history[0]?.sessionId ?? '',
  senderId: 'system',
  senderType: 'system',
  type: 'text',
  content: `[上下文摘要] ...`,
  metadata: { contextTrimmed: true, originalCount: skipped.length },
  createdAt: new Date(),
}
```

**问题**：
1. `id: 'context-summary'` 是硬编码的。如果同一个 session 中多次触发 handoff（比如多个 Agent 同时回复），**消息 ID 会冲突**。虽然 `summaryMsg` 不会写入数据库（只是传给 LLM），但如果 caller 把它当作普通消息处理并尝试插入 DB，会违反主键唯一性约束。
2. `sessionId: history[0]?.sessionId ?? ''` 如果 history 为空，sessionId 是空字符串，可能导致后续处理出错。

---

### 4.5 `task-scheduler.ts:55` — `results.get(task.id)!` 非空断言

```typescript
return plan.tasks.map((task) => results.get(task.id)!).filter(Boolean)
```

**问题**：
1. `results.get(task.id)!` 使用非空断言，但如果 task 从未被调度（比如 cycle detection 前就返回了，或者任务被 blocked 但没有写入 results），这里会返回 `undefined`。
2. `filter(Boolean)` 会把 `status === 'failed'` 但其他字段为 falsy 的结果过滤掉吗？不会，`filter(Boolean)` 只是过滤 `undefined`。
3. 但如果某个 task 的 `output` 是空字符串 `''`，`artifacts` 是空数组，`filter(Boolean)` 不会过滤它——等等，`results.get(task.id)` 返回的是一个对象 `{ taskId, status, output, ... }`，这个对象本身永远 truthy。所以 `filter(Boolean)` 只是过滤 `undefined`。

**真正的问题**：如果 task.id 不在 results 中，`!` 断言会返回 undefined，然后 `filter(Boolean)` 会过滤掉它。这意味着**某些 task 的结果会莫名其妙地消失**，调用者拿到少了一个 task 的数组，但不知道为什么。

---

### 4.6 `workspaces.ts:175` — 不安全的 JSON 解析

```typescript
.post('/open-folder', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const input = openWorkspaceFolderSchema.parse(body)
```

**问题**：`c.req.json()` 可能返回非 JSON 数据（比如 HTML 错误页面），`.catch(() => ({}))` 会静默吞掉解析错误。然后 `openWorkspaceFolderSchema.parse({})` 如果 schema 中有 `.nullable().optional()` 的字段会 pass，但如果 body 是非法 JSON，应该返回 400 而不是默认空对象。

---

### 4.7 `messages.ts:705-706` — task.id 被就地修改

```typescript
let taskId = task.id
const existingTask = await db.select(...).from(workspaceTasks).where(eq(workspaceTasks.id, taskId)).limit(1)
if (existingTask.length > 0) {
  taskId = crypto.randomUUID()
  taskIdRemap.set(task.id, taskId)
  task.id = taskId    // <-- 就地修改入参
}
```

**问题**：`task.id = taskId` 直接修改了传入的 `parsed.tasks` 数组中的对象。这改变了 caller 的数据结构，可能导致后续依赖原始 `task.id` 的代码出错。虽然在这个函数内部后续代码都使用 `task.id`（已经是新值），但如果 `parsed` 对象在函数返回后还被其他地方使用（比如 `updatePlanCardDispatchResult`），ID 就不一致了。

---

## 5. 错误处理问题

### 5.1 `messages.ts:841-862` — `engine.startRun` 错误处理不完整

```typescript
const engine = new OrchestratorEngine()
engine.startRun({ ... }).catch(async (err: any) => {
  logger.error(...)
  await db.update(orchestratorRuns).set({ status: 'failed' })
  await emitRunEvent({ type: 'run.failed', ... })
  const failedPlan = { ... }
  await db.update(messages).set({ metadata: { ... } })
})
```

**问题**：
1. `engine.startRun` 的错误只被记录和更新 DB，但**HTTP 响应已经返回了**（line 867 `return c.json(result)`）。调用者收到 200 OK 和一个 running 状态的 result，但 engine 可能立刻就失败了。前端无法知道这个 run 实际上已经失败，除非通过 WebSocket 事件。
2. `catch` 块中的 DB 更新和事件发送如果也失败，错误会被吞掉（没有 `.catch` 链）。

---

### 5.2 `group-chat-manager.ts:90-93` — workspace 不存在时静默返回

```typescript
const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
if (!workspace) {
  logger.error({ workspaceId }, 'GroupChatManager: workspace not found')
  return
}
```

**问题**：群聊消息处理失败时**不向用户反馈任何错误**。用户发送消息后前端没有任何响应，不知道是成功了还是失败了。应该向 session 中插入一条系统消息告知用户。

---

### 5.3 `branch-manager.ts:309-324` — `execGit` 错误处理不完整

```typescript
private async execGit(projectPath: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { ... })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (exitCode !== 0 && stderr) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`)
  }
  return stdout
}
```

**问题**：
1. `exitCode !== 0 && stderr` — 如果 git 返回非零退出码但没有 stderr（某些 git 命令会这样），错误被忽略，返回 stdout。这可能隐藏失败。
2. `proc.stdout` 和 `proc.stderr` 作为 Response 被读取，但如果输出很大（比如 `git diff` 产生几 MB 的输出），会占用大量内存。
3. 没有超时控制。如果 git 命令挂起（比如等待输入），`proc.exited` 永远不会 resolve。

---

### 5.4 `planner.ts:42-50` — `harnessManager.loadFromWorkspace` 错误被吞

```typescript
try {
  await harnessManager.loadFromWorkspace(workspacePath)
  const spec = harnessManager.findBestSpec(goal)
  if (spec) { ... }
} catch (err: any) {
  logger.warn({ err: err?.message, workspacePath }, 'Planner failed to load Harness spec')
}
```

**问题**：如果 `loadFromWorkspace` 抛出异常，planner 回退到 LLM 生成。但如果异常是因为 workspacePath 无效（比如目录不存在），planner 仍然会继续执行，后面 `generateSpec` 或 `generateWithLlm` 可能也会失败，导致**双重失败**。而且 warn 级别日志可能不会被注意到。

---

## 6. 性能问题

### 6.1 `agent-runner.ts:115-128` — 两次查询消息历史

```typescript
const pinned = await db.select().from(messages).where(...).orderBy(asc(messages.createdAt))
const recent = await db.select().from(messages).where(...).orderBy(desc(messages.createdAt)).limit(50)
```

**问题**：同一个 session 的消息历史被查询了两次。可以用一次查询 + 内存过滤替代：

```typescript
const all = await db.select().from(messages).where(...).orderBy(asc(messages.createdAt))
const pinned = all.filter(m => m.isPinned)
const recent = all.slice(-50)
```

对于 SQLite 来说，两次查询和一次全查的权衡取决于消息数量。如果消息很多（>1000），两次查询可能更快；但如果消息在 50-200 条之间，一次查询更优。

---

### 6.2 `group-chat-manager.ts:454-460` — 每次 Agent 回复后都重新加载历史

实际上不是，历史是在 `conversationLoop` 开始时加载一次，然后在循环中通过 `history = [...history, agentGroupMsg]` 更新。这不是性能问题。

但 `getAgentReply`（line 476）在每次 Agent 回复后查询数据库：

```typescript
private async getAgentReply(sessionId: string, messageId?: string): Promise<...> {
  if (messageId) {
    const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    if (msg) return ...
  }
  const [msg] = await db.select().from(messages).where(and(...)).orderBy(desc(...)).limit(1)
```

如果 `messageId` 存在，先按 ID 查；如果不存在，按 sessionId + senderType 查。`runAgentReply` 返回 `result.messageId`，所以通常 messageId 存在。这不是大问题。

---

### 6.3 `blackboard.ts:152-188` — `query` 方法没有分页

```typescript
async query(query: BlackboardQuery): Promise<BlackboardEntry[]> {
  // ...
  if (query.limit) { q = q.limit(query.limit) }
  const rows = await q
```

**问题**：如果没有提供 `limit`，查询可能返回大量结果。对于一个 orchestrator run 产生的大量 blackboard 条目，无 limit 查询会加载所有数据到内存。

---

### 6.4 `orchestrator-engine.ts:692-713` — 逐个收集文件 diff

```typescript
for (const filePath of changedFiles) {
  const fileDiff = await gitBranchManager.collectFileDiff(branchCtx.projectPath, filePath, branchCtx.branch)
  const status = await gitBranchManager.getFileStatus(branchCtx.projectPath, filePath, branchCtx.branch)
  artifacts.push({ ... })
}
```

**问题**：每个文件执行两次 git 命令（`git diff` 和 `git diff --name-status`），如果有 50 个文件改变，就是 100 次 git spawn。可以合并为一次 `git diff --numstat` 或 `git diff --name-status` 获取所有文件状态，再按需获取单个文件的 diff。

---

## 7. 安全与权限问题

### 7.1 `auth.ts` — 完全无认证

```typescript
export const authMiddleware = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  c.set('user', DEFAULT_USER)
  await next()
})
```

**问题**：虽然项目是本地单用户模式，但如果服务器暴露在局域网中，任何人都可以调用 API 并以 `default-user` 身份操作。至少需要基本的 token 校验或本地回环地址限制。

---

### 7.2 `policy-guard.ts:96-108` — 敏感路径检测可绕过

```typescript
const sensitivePaths = ['.env', '.ssh', 'id_rsa', 'credentials', 'secret', 'token', 'password']
for (const path of targetPaths) {
  const lower = path.toLowerCase()
  if (sensitivePaths.some((s) => lower.includes(s))) {
    decision.allowed = false
    break
  }
}
```

**问题**：
1. `lower.includes(s)` 可轻易绕过。比如 `.env` 可以写成 `./config/.env.local`（会被检测到），但也可以写成 `./config/environment`（不会检测）。
2. 更关键的是：`targetPaths` 是由谁提供的？如果是 Agent 自己声明的，Agent 可以简单不声明敏感路径来绕过检测。这不是真正的沙箱，只是基于声明的静态检查。

---

### 7.3 `messages.ts:175` — `openWorkspaceFolderSchema.parse(body)` 绕过 zValidator

```typescript
.post('/open-folder', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const input = openWorkspaceFolderSchema.parse(body)
```

**问题**：没有使用 `zValidator('json', ...)`，而是手动 `parse`。如果 `parse` 失败会抛出 ZodError，但 Hono 的错误处理器可能不捕获 ZodError（`zValidator` 会统一处理为 400）。这会导致 500 内部错误而不是 400 校验失败。

---

## 8. 设计/架构问题

### 8.1 `messages.ts` — 1100+ 行的 God File

**问题**：一个文件包含了消息 CRUD、Agent Draft、Orchestrator Plan、Artifact Demo、Code Rollback、Plan Dispatch 等完全不相关的功能。这违反了单一职责原则，导致：
- 代码难以测试（需要 mock 大量依赖）
- 合并冲突频繁
- 新开发者难以定位代码

---

### 8.2 `orchestrator-engine.ts` — 1300+ 行的 God Class

**问题**：`OrchestratorEngine` 同时负责：
- 任务执行 (`executeTask`)
- 重试逻辑 (`retryTask`)
- 自动审查链 (`injectAutoReviewTasks`)
- 冲突解决后处理 (`startRun`)
- 结果汇总 (`synthesizeAndReport`)

每个职责都应该是一个独立的类/模块。

---

### 8.3 `agent-runner.ts` — WebSocket 和 Agent 执行耦合

**问题**：`runAgentReply` 既负责调用 LLM/Code Agent，又负责 WebSocket 广播，还负责数据库写入。这三个职责应该分离：
- Agent 执行层：只负责调用 runtime，返回结果
- 事件层：负责广播
- 持久化层：负责写入数据库

---

## 9. 数据库与持久化问题

### 9.1 `packages/db/src/schema.ts` — 缺少索引

**问题**：以下高频查询字段没有索引：
- `messages.sessionId`（每次加载聊天历史都查）
- `messages.isPinned`（与 sessionId 联合查询）
- `sessionMembers.sessionId`（群聊成员查询）
- `workspaceAgents.workspaceId`（工作区 Agent 列表）
- `workspaceTasks.workspaceId`（工作区任务列表）
- `blackboardEntries.namespace` + `key`（黑板读写）
- `executionLogs.runId`（执行日志查询）

SQLite 在小数据量时全表扫描很快，但当消息表增长到几万条时，缺少索引会导致明显的性能下降。

---

### 9.2 `agent-runner.ts:281-304` — 元数据字段与 schema 不同步

```typescript
metadata: profile ? {
  agentName, role, color, runtimeType, codeAgentType, modelId,
  sandboxPolicy, projectPath, codeAgentRun,
  artifacts: codeAgentRun?.artifacts ?? artifacts,
} : null
```

**问题**：`messages.metadata` 是 `json` 类型，没有任何 schema 约束。如果前端期望某些字段存在但后端没有提供，或者后端提供了前端不认识的新字段，两边会不同步。应该用 Zod schema 在写入和读取时都做校验。

---

## 10. 总结：优先级排序

| 优先级 | 问题 | 文件 | 影响 |
|--------|------|------|------|
| P0 | `syncGroupMembers` 误删 workspaceAgents | `group-session.ts` | 数据丢失 |
| P0 | `runAgentReply`/`cancelAgentReply` 竞态条件 | `agent-runner.ts` | 消息覆盖、无法取消 |
| P1 | `blackboard.readVersionsFromDb` 名不副实导致 version 冲突 | `blackboard.ts` | 数据不一致 |
| P1 | `retryTask` 无法被取消 | `orchestrator-engine.ts` | 资源泄漏 |
| P1 | `execGit` 超时控制缺失 | `branch-manager.ts` | 进程挂起 |
| P1 | 数据库缺少关键索引 | `schema.ts` | 性能退化 |
| P2 | `trimHistoryForHandoff` 硬编码 ID | `agent-runner.ts` | 主键冲突 |
| P2 | `parsePlan` 缺少完整校验 | `messages.ts` | 运行时错误 |
| P2 | `broadcast` 不清理失效 WS | `agent-runner.ts` | 内存/CPU 浪费 |
| P2 | `engine.startRun` 异步错误前端不可知 | `messages.ts` | 用户体验 |
| P3 | 1100+ 行 God File | `messages.ts` | 可维护性 |
| P3 | 1300+ 行 God Class | `orchestrator-engine.ts` | 可维护性 |
| P3 | 忙等轮询 | `task-scheduler.ts` | CPU 浪费 |
