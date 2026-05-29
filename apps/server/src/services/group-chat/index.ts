/**
 * @deprecated GroupChatManager 已弃用，群聊消息现在走 messages.ts 中的统一路由。
 * 此导出仅保留用于兼容性，不建议新代码依赖。
 */
export { GroupChatManager } from './group-chat-manager'
export type {
  GroupChatAgent,
  GroupChatConfig,
  GroupChatMessage,
  GroupChatState,
} from './types'
export { DEFAULT_GROUP_CHAT_CONFIG } from './types'
