export interface Session {
  id: string
  title: string
  type: 'single' | 'group'
  owner_id: string
  created_at: string
  updated_at: string
  is_archived: boolean
}

export interface SessionMember {
  session_id: string
  member_id: string
  member_type: 'user' | 'agent'
  role: 'owner' | 'admin' | 'member'
  joined_at: string
}
