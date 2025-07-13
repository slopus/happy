/**
 * Socket message types for handy-cli
 * 
 * This module defines TypeScript interfaces for socket communication with the handy server.
 * These types mirror the server's message format for type-safe communication.
 * 
 * Key design decisions:
 * - All messages are strongly typed to prevent runtime errors
 * - Message content is encrypted using the session's encryption key
 * - Types match the server's Prisma JSON types exactly
 */

/**
 * Base message content structure for encrypted messages
 */
export interface SessionMessageContent {
  c: string // Base64 encoded encrypted content
  t: 'encrypted'
}

/**
 * Update body for new messages
 */
export interface UpdateBody {
  c: SessionMessageContent
  mid: string // Message ID
  sid: string // Session ID
  t: 'new-message'
}

/**
 * Update event from server
 */
export interface Update {
  id: string
  seq: number
  body: UpdateBody
  createdAt: number
}

/**
 * Socket events from server to client
 */
export interface ServerToClientEvents {
  update: (data: Update) => void
}

/**
 * Socket events from client to server
 */
export interface ClientToServerEvents {
  message: (data: { sid: string, message: any }) => void
}

/**
 * Session information
 */
export interface Session {
  createdAt: number
  id: string
  seq: number
  updatedAt: number
}

/**
 * Session message from API
 */
export interface SessionMessage {
  content: SessionMessageContent
  createdAt: number
  id: string
  seq: number
  updatedAt: number
}

/**
 * API response types
 */
export interface CreateSessionResponse {
  session: {
    id: string
    tag: string
    seq: number
    createdAt: number
    updatedAt: number
  }
}

export type UserMessage = {
  role: 'user',
  body: {
    type: 'text',
    text: string
  }
}

export type AgentMessage = {
  role: 'agent',
  body: any
}

export type MessageContent = UserMessage | AgentMessage;
