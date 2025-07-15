/**
 * Types for Claude Code
 * 
 * Spawn options
 * Message type definitions for Claude messages
 * 
 * We parse messages from two sources:
 * 1. Interactive session files (camelCase) - from watcher/file system
 * 2. Claude SDK responses (snake_case) - from SDK direct calls
 * 
 * We only extract fields we care about (sessionId, type, etc.)
 * The full message content is passed through to the client
 */

import type { ChildProcess } from 'node:child_process'
import { z } from 'zod'
import { logger } from '@/ui/logger'

/**
 * Claude CLI spawn options
 */
export interface ClaudeSpawnOptions {
  allowedTools?: string[]
  disallowedTools?: string[]
  model?: string
  permissionMode?: 'auto' | 'default' | 'plan'
  sessionId?: string
  skipPermissions?: boolean
  workingDirectory: string
}

/**
 * Claude process state
 */
export interface ClaudeProcess {
  isRunning: boolean
  process: ChildProcess
  sessionId?: string
}

// Format of each line in ~/.claude/projects/<project-name>/<session-id>.jsonl
// For parsing session files
export const PersisstedMessageSchema = z.object({
  sessionId: z.string(),
  type: z.string(),
  subtype: z.string().optional(),
}).loose()

export type InteractiveMessage = z.infer<typeof PersisstedMessageSchema>

// Non-interactive sdk messages claude code will emit these to stdout
export const SDKMessageSchema = z.object({
  session_id: z.string().optional(),
  type: z.string(),
  subtype: z.string().optional(),
}).loose()

export type SDKMessage = z.infer<typeof SDKMessageSchema>

// Unified message info we extract
export interface ClaudeMessage {
  sessionId?: string
  type: string
  rawMessage: any
}

export function parseClaudePersistedMessage(message: any): ClaudeMessage | undefined {
  const result = PersisstedMessageSchema.safeParse(message)
  if (!result.success) {
    logger.debug('[ERROR] Failed to parse interactive message:', result.error)
    logger.debugLargeJson('[ERROR] Message:', message)
    return undefined
  }
  
  return {
    sessionId: result.data.sessionId,
    type: result.data.type,
    rawMessage: {
      ...message,
      // Lets patch the message with another type of id just in case
      session_id: result.data.sessionId,
    }
  }
}

export function parseClaudeSdkMessage(message: any): ClaudeMessage | undefined {
  const result = SDKMessageSchema.safeParse(message)
  if (!result.success) {
    logger.debug('[ERROR] Failed to parse SDK message:', result.error)
    return undefined
  }
  
  return {
    sessionId: result.data.session_id,
    type: result.data.type,
    rawMessage: {
      ...message,
      // Lets patch the message with another type of id just in case
      session_id: result.data.session_id,
    }
  }
}
