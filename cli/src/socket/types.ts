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
  c: SessionMessageContent | string   // The encrypted content (nested object or string)
  mid: string // Message ID
  sid: string // Session ID
  t: 'new-message'
}

/**
 * Update event from server
 */
export interface Update {
  content: UpdateBody
  createdAt: number
  id: string
  seq: number
}

/**
 * Socket events from server to client
 */
export interface ServerToClientEvents {
  auth: (data: { success: boolean; user: string }) => void
  error: (data: { message: string }) => void
  update: (data: Update) => void
}

/**
 * Socket events from client to server
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ClientToServerEvents {
  // Currently no client-to-server events defined in the server
}

/**
 * Client message types that we'll handle locally
 */
export interface TextInputMessage {
  content: string
  type: 'text-input'
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