/**
 * Claude SDK integration - uses claude-code SDK directly
 * 
 * This module provides the same interface as claude.ts but uses
 * the claude-code SDK directly instead of spawning a process.
 */

import { logger } from '@/ui/logger'
import { query, type SDKMessage, type Options, type PermissionMode } from '@anthropic-ai/claude-code'

export interface ClaudeProcessOptions {
  command: string  // Natural language prompt for Claude
  sessionId?: string
  workingDirectory: string
  model?: string
  permissionMode?: 'auto' | 'default' | 'plan'
  skipPermissions?: boolean
  mcpServers?: Record<string, any>
  permissionPromptToolName?: string
  abort: AbortController
}

export interface ClaudeOutput {
  type: 'json' | 'text' | 'error' | 'exit'
  data?: any
  error?: string
  code?: number | null
  signal?: string | null
}

/**
 * Use Claude SDK to process commands
 */
export async function* claude(options: ClaudeProcessOptions): AsyncGenerator<ClaudeOutput> {
  try {
    // Prepare SDK options
    const sdkOptions: Options = {
      cwd: options.workingDirectory,
      model: options.model,
      permissionMode: mapPermissionMode(options.permissionMode),
      resume: options.sessionId,
      // Add MCP servers if provided
      mcpServers: options.mcpServers,
      // Add permission prompt tool name if provided
      permissionPromptToolName: options.permissionPromptToolName,
    }

    // Query Claude
    const response = query({
      prompt: options.command,
      abortController: options.abort,
      options: sdkOptions
    })
    
    let sessionId: string | undefined
    
    // Process SDK messages
    for await (const message of response) {
      logger.debugLargeJson('[CLAUDE SDK] Message:', message)
      
      // Convert SDK messages to our output format
      switch (message.type) {
        case 'system':
          if (message.subtype === 'init') {
            sessionId = message.session_id
            // Yield system init as JSON
            yield { type: 'json', data: message }
          }
          break
          
        case 'assistant':
          // Yield assistant messages as JSON
          yield { type: 'json', data: message }
          break
          
        case 'user':
          // User messages are inputs, not outputs
          break
          
        case 'result':
          // Result message indicates completion
          if (message.is_error) {
            yield { type: 'error', error: `Claude execution error: ${message.subtype}` }
            yield { type: 'exit', code: 1, signal: null }
          } else {
            // Yield result as JSON
            yield { type: 'json', data: message }
            yield { type: 'exit', code: 0, signal: null }
          }
          break
          
        default:
          // Unknown message type
          yield { type: 'json', data: message }
      }
    }
    
  } catch (error) {
    logger.debug('[CLAUDE SDK] [ERROR] SDK error:', error)
    yield { type: 'error', error: error instanceof Error ? error.message : String(error) }
    yield { type: 'exit', code: 1, signal: null }
  }
}

/**
 * Map permission mode to SDK format
 */
function mapPermissionMode(mode?: 'auto' | 'default' | 'plan'): PermissionMode | undefined {
  if (!mode) return undefined
  
  const modeMap: Record<string, PermissionMode> = {
    'auto': 'acceptEdits',
    'default': 'default',
    'plan': 'bypassPermissions'
  }
  
  return modeMap[mode] as PermissionMode
}