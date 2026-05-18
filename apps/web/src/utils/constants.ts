export const APP_NAME = 'AgentHub'
export const APP_VERSION = '0.1.0'

export const WS_EVENTS = {
  MESSAGE_SEND: 'message:send',
  MESSAGE_TYPING: 'message:typing',
  AGENT_INVOKE: 'agent:invoke',
  TASK_APPROVE: 'task:approve',
  SESSION_JOIN: 'session:join',
  SESSION_LEAVE: 'session:leave',
  PING: 'ping',
} as const

export const MAX_MESSAGE_LENGTH = 4000
export const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
