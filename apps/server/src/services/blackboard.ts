import { eq, and, desc, asc, like } from 'drizzle-orm'
import { db, blackboardEntries } from '@agenthub/db'
import type { ZodSchema } from 'zod'
import { logger } from '../lib/logger'
import { parseTypedBlackboardValue, type BlackboardSchemaType } from './blackboard-schemas'

export interface BlackboardEntry<T = unknown> {
  id: string
  namespace: string
  key: string
  value: T
  schemaVersion: number
  agentId: string | null
  taskId: string | null
  version: number
  tags: string[]
  createdAt: Date
}

export interface BlackboardRef {
  namespace: string
  key: string
  version: number
}

export interface BlackboardQuery {
  namespace?: string
  keyPattern?: string
  agentId?: string
  taskId?: string
  schemaType?: BlackboardSchemaType
  tags?: string[]
  limit?: number
  orderBy?: 'asc' | 'desc'
}

type Subscriber = (entry: BlackboardEntry) => void

export class Blackboard {
  private cache = new Map<string, Map<string, BlackboardEntry[]>>()
  private subscribers = new Map<string, Map<string, Set<Subscriber>>>()

  static namespace(workspaceId: string, runId: string): string {
    return `workspace/${workspaceId}/run/${runId}`
  }

  async write<T>(params: {
    namespace: string
    key: string
    value: T
    schemaVersion?: number
    agentId?: string
    taskId?: string
    tags?: string[]
  }): Promise<BlackboardRef> {
    const { namespace, key, value, schemaVersion = 1, agentId, taskId, tags = [] } = params
    const parsedTypedValue = parseTypedBlackboardValue(value)
    const valueToStore = (parsedTypedValue ?? value) as T

    const existing = await this.readVersionsFromDb(namespace, key)
    const version = existing.length > 0 ? existing[existing.length - 1]!.version + 1 : 1

    const entry: BlackboardEntry = {
      id: crypto.randomUUID(),
      namespace,
      key,
      value: valueToStore as unknown,
      schemaVersion,
      agentId: agentId ?? null,
      taskId: taskId ?? null,
      version,
      tags,
      createdAt: new Date(),
    }

    await db.insert(blackboardEntries).values({
      id: entry.id,
      namespace,
      key,
      value: valueToStore as Record<string, unknown>,
      schemaVersion,
      agentId: entry.agentId,
      taskId: entry.taskId,
      version,
      tags,
      createdAt: entry.createdAt,
    })

    this.setCache(namespace, key, entry)
    this.notify(namespace, key, entry)

    logger.debug({ namespace, key, version, agentId, taskId }, 'Blackboard write')
    return { namespace, key, version }
  }

  async read<T>(namespace: string, key: string, _schema?: ZodSchema<T>): Promise<T | undefined> {
    const cached = this.getCacheLatest(namespace, key)
    if (cached) {
      return cached.value as T
    }

    const rows = await db
      .select()
      .from(blackboardEntries)
      .where(and(eq(blackboardEntries.namespace, namespace), eq(blackboardEntries.key, key)))
      .orderBy(desc(blackboardEntries.version))
      .limit(1)

    if (rows.length === 0) return undefined

    const row = rows[0]!
    const entry = this.rowToEntry(row)
    this.setCache(namespace, key, entry)
    return entry.value as T
  }

  async readRef<T>(ref: BlackboardRef, _schema?: ZodSchema<T>): Promise<T | undefined> {
    const rows = await db
      .select()
      .from(blackboardEntries)
      .where(
        and(
          eq(blackboardEntries.namespace, ref.namespace),
          eq(blackboardEntries.key, ref.key),
          eq(blackboardEntries.version, ref.version)
        )
      )
      .limit(1)

    if (rows.length === 0) return undefined
    return this.rowToEntry(rows[0]!).value as T
  }

  async update<T>(
    namespace: string,
    key: string,
    updater: (prev: T | undefined) => T,
    meta?: { agentId?: string; taskId?: string; tags?: string[] }
  ): Promise<BlackboardRef> {
    const prev = await this.read<T>(namespace, key)
    const next = updater(prev)
    return this.write({
      namespace,
      key,
      value: next,
      agentId: meta?.agentId,
      taskId: meta?.taskId,
      tags: meta?.tags,
    })
  }

  async query(query: BlackboardQuery): Promise<BlackboardEntry[]> {
    let q = db.select().from(blackboardEntries).$dynamic()
    const conditions = []

    if (query.namespace) {
      conditions.push(eq(blackboardEntries.namespace, query.namespace))
    }
    if (query.agentId) {
      conditions.push(eq(blackboardEntries.agentId, query.agentId))
    }
    if (query.taskId) {
      conditions.push(eq(blackboardEntries.taskId, query.taskId))
    }

    if (conditions.length > 0) {
      q = q.where(and(...conditions))
    }

    if (query.keyPattern) {
      const patternCondition = like(blackboardEntries.key, query.keyPattern)
      q = conditions.length > 0 ? q.where(and(...conditions, patternCondition)) : q.where(patternCondition)
    }

    q = q.orderBy(query.orderBy === 'asc' ? asc(blackboardEntries.createdAt) : desc(blackboardEntries.createdAt))

    if (query.limit) {
      q = q.limit(query.limit)
    }

    const rows = await q
    const entries = rows.map((r) => this.rowToEntry(r))
    if (!query.schemaType) return entries
    return entries.filter((entry) => {
      const value = entry.value as { schemaType?: unknown } | null
      return value?.schemaType === query.schemaType
    })
  }

  async readVersions(namespace: string, key: string): Promise<BlackboardEntry[]> {
    const rows = await db
      .select()
      .from(blackboardEntries)
      .where(and(eq(blackboardEntries.namespace, namespace), eq(blackboardEntries.key, key)))
      .orderBy(asc(blackboardEntries.version))

    return rows.map((r) => this.rowToEntry(r))
  }

  async getVersion(namespace: string, key: string, version: number): Promise<BlackboardEntry | undefined> {
    const rows = await db
      .select()
      .from(blackboardEntries)
      .where(
        and(
          eq(blackboardEntries.namespace, namespace),
          eq(blackboardEntries.key, key),
          eq(blackboardEntries.version, version)
        )
      )
      .limit(1)

    if (rows.length === 0) return undefined
    return this.rowToEntry(rows[0]!)
  }

  subscribe(namespace: string, keyPattern: string, callback: Subscriber): () => void {
    if (!this.subscribers.has(namespace)) {
      this.subscribers.set(namespace, new Map())
    }
    const nsSubs = this.subscribers.get(namespace)!
    if (!nsSubs.has(keyPattern)) {
      nsSubs.set(keyPattern, new Set())
    }
    nsSubs.get(keyPattern)!.add(callback)

    return () => {
      nsSubs.get(keyPattern)?.delete(callback)
    }
  }

  clearNamespace(namespace: string): void {
    this.cache.delete(namespace)
    this.subscribers.delete(namespace)
    logger.debug({ namespace }, 'Blackboard namespace cleared from memory')
  }

  // ─── 内部 ───────────────────────────────

  private notify(namespace: string, key: string, entry: BlackboardEntry): void {
    const nsSubs = this.subscribers.get(namespace)
    if (!nsSubs) return

    for (const [pattern, callbacks] of nsSubs) {
      if (this.matchPattern(key, pattern)) {
        for (const cb of callbacks) {
          try {
            cb(entry)
          } catch (err) {
            logger.error({ err, namespace, key, pattern }, 'Blackboard subscriber error')
          }
        }
      }
    }
  }

  private matchPattern(key: string, pattern: string): boolean {
    if (pattern === '*') return true
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1)
      return key.startsWith(prefix)
    }
    return key === pattern
  }

  private getCacheLatest(namespace: string, key: string): BlackboardEntry | undefined {
    const ns = this.cache.get(namespace)
    if (!ns) return undefined
    const versions = ns.get(key)
    if (!versions || versions.length === 0) return undefined
    return versions[versions.length - 1]
  }

  private setCache(namespace: string, key: string, entry: BlackboardEntry): void {
    if (!this.cache.has(namespace)) {
      this.cache.set(namespace, new Map())
    }
    const ns = this.cache.get(namespace)!
    if (!ns.has(key)) {
      ns.set(key, [])
    }
    ns.get(key)!.push(entry)
    const versions = ns.get(key)!
    if (versions.length > 20) {
      ns.set(key, versions.slice(-20))
    }
  }

  private async readVersionsFromDb(namespace: string, key: string): Promise<BlackboardEntry[]> {
    const rows = await db
      .select()
      .from(blackboardEntries)
      .where(and(eq(blackboardEntries.namespace, namespace), eq(blackboardEntries.key, key)))
      .orderBy(asc(blackboardEntries.version))

    return rows.map((r) => this.rowToEntry(r))
  }

  private rowToEntry(row: typeof blackboardEntries.$inferSelect): BlackboardEntry {
    return {
      id: row.id,
      namespace: row.namespace,
      key: row.key,
      value: row.value as unknown,
      schemaVersion: row.schemaVersion,
      agentId: row.agentId,
      taskId: row.taskId,
      version: row.version,
      tags: (row.tags as string[]) ?? [],
      createdAt: row.createdAt,
    }
  }
}

export const blackboard = new Blackboard()
