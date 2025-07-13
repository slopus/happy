/**
 * Types for Claude CLI interaction
 * 
 * This module defines types for the JSON line output from Claude CLI
 * and configuration options for spawning Claude processes.
 */

import type { ChildProcess } from 'node:child_process'

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
 * Claude CLI JSON output types
 */
export interface ClaudeResponse {
  data?: unknown
  error?: string
  message?: string
  session_id?: string
  type: string
}

/**
 * Claude process state
 */
export interface ClaudeProcess {
  isRunning: boolean
  process: ChildProcess
  sessionId?: string
}