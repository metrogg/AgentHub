import { randomUUID } from 'node:crypto'
import { and, db, desc, eq, taskClarifications, workspaceTasks } from '@agenthub/db'

export interface CreateTaskClarificationInput {
  runId?: string | null
  taskId?: string | null
  agentId?: string | null
  question: string
  options?: string[] | null
}

export interface AnswerTaskClarificationInput {
  clarificationId?: string | null
  runId?: string | null
  taskId?: string | null
  agentId?: string | null
  answer: string
}

export async function createTaskClarification(input: CreateTaskClarificationInput) {
  if (!input.runId || !input.taskId || !input.agentId) return null
  const [record] = await db
    .insert(taskClarifications)
    .values({
      id: randomUUID(),
      runId: input.runId,
      taskId: input.taskId,
      agentId: input.agentId,
      question: input.question,
      options: input.options ?? [],
      status: 'pending',
      createdAt: new Date(),
    })
    .returning()
  const countRows = await db
    .select({ id: taskClarifications.id })
    .from(taskClarifications)
    .where(eq(taskClarifications.taskId, input.taskId))
  await db
    .update(workspaceTasks)
    .set({
      clarificationCount: countRows.length,
      updatedAt: new Date(),
    })
    .where(eq(workspaceTasks.id, input.taskId))
  return record ?? null
}

export async function answerPendingTaskClarification(input: AnswerTaskClarificationInput) {
  const record =
    input.clarificationId
      ? await findClarificationById(input.clarificationId)
      : await findLatestPendingClarification(input)
  if (!record || record.status !== 'pending') return null
  const [updated] = await db
    .update(taskClarifications)
    .set({
      answer: input.answer,
      status: 'answered',
      answeredAt: new Date(),
    })
    .where(eq(taskClarifications.id, record.id))
    .returning()
  return updated ?? null
}

async function findClarificationById(id: string) {
  const [record] = await db
    .select()
    .from(taskClarifications)
    .where(eq(taskClarifications.id, id))
    .limit(1)
  return record ?? null
}

async function findLatestPendingClarification(input: AnswerTaskClarificationInput) {
  if (!input.runId || !input.taskId || !input.agentId) return null
  const [record] = await db
    .select()
    .from(taskClarifications)
    .where(
      and(
        eq(taskClarifications.runId, input.runId),
        eq(taskClarifications.taskId, input.taskId),
        eq(taskClarifications.agentId, input.agentId),
        eq(taskClarifications.status, 'pending'),
      ),
    )
    .orderBy(desc(taskClarifications.createdAt))
    .limit(1)
  return record ?? null
}
