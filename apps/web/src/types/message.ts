export interface Message {
  id: string
  session_id: string
  sender_id: string
  sender_type: 'user' | 'agent' | 'system'
  content: string
  type: 'text' | 'code' | 'image' | 'file'
  status: 'sending' | 'sent' | 'error'
  metadata?: Record<string, unknown>
  created_at: string
}
