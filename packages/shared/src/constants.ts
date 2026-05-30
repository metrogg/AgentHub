export const APP_NAME = 'AgentHub'
export const APP_VERSION = '0.1.0'

export const API_BASE_PATH = '/api'
export const WS_BASE_PATH = '/ws'

export const SenderType = {
  User: 'user',
  Agent: 'agent',
  System: 'system',
} as const
export type SenderType = (typeof SenderType)[keyof typeof SenderType]

export const MessageType = {
  Text: 'text',
  Markdown: 'markdown',
  Code: 'code',
  Diff: 'diff',
  Image: 'image',
  File: 'file',
  TaskCard: 'task_card',
  TaskBoard: 'task_board',
} as const
export type MessageType = (typeof MessageType)[keyof typeof MessageType]

export const TaskStatus = {
  Pending: 'pending',
  Running: 'running',
  Done: 'done',
  Failed: 'failed',
  Cancelled: 'cancelled',
  Blocked: 'blocked',
  Skipped: 'skipped',
} as const
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus]

export const SessionType = {
  Direct: 'direct',
  Group: 'group',
} as const
export type SessionType = (typeof SessionType)[keyof typeof SessionType]

export const WsEvent = {
  MessageNew: 'message:new',
  MessageStream: 'message:stream',
  MessageCompleted: 'message:completed',
  MessageMetadata: 'message:metadata',
  MessageCancelled: 'message:cancelled',
  MessagePartUpdated: 'message.part.updated',
  MessagePartDelta: 'message.part.delta',
  TaskUpdate: 'task:update',
  BlackboardUpdate: 'blackboard:update',
  RunEvent: 'run:event',
  AgentTyping: 'agent:typing',
  PreviewReady: 'preview:ready',
  DiffReady: 'diff:ready',
  SessionJoin: 'session:join',
  SessionJoined: 'session:joined',
  TaskBoardPlanReady: 'task_board:plan_ready',
  TaskBoardTaskProgress: 'task_board:task_progress',
  TaskBoardRunCompleted: 'task_board:run_completed',
  TaskBoardClarificationNeeded: 'task_board:clarification_needed',
} as const
export type WsEvent = (typeof WsEvent)[keyof typeof WsEvent]

export const MAX_MESSAGE_LENGTH = 10000
