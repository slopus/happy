/**
 * Session types for handy-server integration
 */

export interface Session {
  createdAt: number
  id: string
  seq: number
  tag: string
  updatedAt: number
}

export interface SessionMessage {
  content: MessageContent
  createdAt: number
  id: string
  seq: number
  updatedAt: number
}

export interface MessageContent {
  c: string  // Base64 encoded encrypted content
  t: 'encrypted'
}

export interface CreateSessionResponse {
  session: Session
}

export interface SendMessageResponse {
  message: SessionMessage
}

export interface ListSessionsResponse {
  sessions: Session[]
}

export interface GetMessagesResponse {
  messages: SessionMessage[]
}

export interface SocketUpdate {
  content: {
    c: string    // Encrypted content
    mid: string  // Message ID
    sid: string  // Session ID
    t: 'new-message'
  }
  createdAt: number
  id: string
  seq: number
}