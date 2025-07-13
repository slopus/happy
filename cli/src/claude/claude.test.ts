/**
 * Integration tests for Claude CLI
 * 
 * These tests verify that we can properly interact with Claude CLI,
 * send commands, and receive responses.
 */

import { Claude } from '#claude/claude'
import { ClaudeResponse } from '#claude/types'
import { logger } from '#utils/logger'
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

describe('Claude CLI Integration', () => {
  
  let claude: Claude
  const playgroundPath = resolve('./claude-cli-playground-project')
  
  beforeAll(() => {
    // Verify playground directory exists
    if (!existsSync(playgroundPath)) {
      throw new Error('Playground directory not found. Run from handy-cli root directory.')
    }
  })
  
  beforeEach(() => {
    // Create a new Claude instance for each test
    claude = new Claude()
  })
  
  afterEach(() => {
    // Clean up Claude process
    claude.kill()
  })
  
  it('should execute ls command and list files in playground directory', async () => {
    const responses: ClaudeResponse[] = []
    let hasListedFiles = false
    let sessionId: string | undefined
    let hasSeenToolUse = false
    let hasSeenToolResult = false
    
    // Create a promise that resolves when test completes
    const testPromise = new Promise<void>((resolve, reject) => {
      // Set a timeout to prevent infinite hanging
      const timeout = setTimeout(() => {
        claude.kill()
        reject(new Error('Test timeout: Claude did not respond within expected time'))
      }, 15_000) // 15 second timeout
      
      claude.on('response', (response: ClaudeResponse) => {
        responses.push(response)
        logger.info('Response type:', response.type, 'Session ID:', response.session_id)
        
        // Capture session ID
        if (response.session_id) {
          sessionId = response.session_id
          logger.info('Captured session ID:', sessionId)
        }
        
        // Check for tool use and tool results based on actual Claude output
        if (response.type === 'assistant' && response.data) {
          const content = JSON.stringify(response.data).toLowerCase()
          if (content.includes('tool_use') || content.includes('ls')) {
            hasSeenToolUse = true
            logger.info('Detected tool use in assistant response')
          }
        }
        
        if (response.type === 'user' && response.data) {
          const content = JSON.stringify(response.data).toLowerCase()
          if (content.includes('tool_result') || content.includes('hello-world.js')) {
            hasSeenToolResult = true
            hasListedFiles = true
            logger.info('Detected tool result with file listing')
          }
        }
        
        // Check various response types for file listing
        if (response.type === 'assistant' || response.type === 'user' || response.type === 'claude-response') {
          const content = JSON.stringify(response).toLowerCase()
          // Check for expected files in playground
          if (content.includes('hello-world.js')) {
            hasListedFiles = true
            logger.info('Found hello-world.js in response')
          }
        }
        
        // Complete test when we have seen both tool use and tool result
        if (hasSeenToolUse && hasSeenToolResult && hasListedFiles && sessionId) {
          clearTimeout(timeout)
          resolve()
        }
      })
      
      claude.on('error', (error: string) => {
        clearTimeout(timeout)
        reject(new Error(`Claude error: ${error}`))
      })
      
      claude.on('processError', (error: Error) => {
        clearTimeout(timeout)
        // Claude CLI might not be installed
        console.warn('Claude CLI not available:', error.message)
        resolve()
      })
      
      claude.on('exit', (exitInfo: { code: null | number, signal: null | string }) => {
        clearTimeout(timeout)
        logger.info(`Claude process exited with code ${exitInfo.code} and signal ${exitInfo.signal}`)
        
        // Check if we got the expected responses even though process exited
        if (sessionId && responses.length > 0 && (hasListedFiles || hasSeenToolResult)) {
          // Process exited but we got expected responses - this is normal
          resolve()
        } else {
          // Process exited without proper responses - this is an error
          reject(new Error(`Claude process exited with code ${exitInfo.code} and signal ${exitInfo.signal} without providing expected responses`))
        }
      })
    })
    
    // Start Claude with ls command  
    claude.runClaudeCodeTurn(
      'Use the LS tool to list files in the current directory and tell me the first 5 files or folders you see.',
      undefined,
      {
        model: 'sonnet',
        permissionMode: 'default',
        workingDirectory: playgroundPath
      }
    )
    
    // Wait for test to complete
    await testPromise
    
    // Assert after promise resolves
    expect(sessionId).toBeTypeOf('string')
    expect(sessionId!.length).toBeGreaterThan(0)
    expect(hasListedFiles).toBe(true)
    expect(responses.length).toBeGreaterThan(0)
  }, 60_000)
  
})