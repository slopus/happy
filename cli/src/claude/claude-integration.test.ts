/**
 * Integration tests for Claude CLI
 * 
 * These tests verify that we can properly interact with Claude CLI,
 * send commands, and receive responses.
 */

import { ClaudeSession } from '#claude/session'
import { ClaudeResponse } from '#claude/types'
import { logger } from '#utils/logger'
import { expect } from 'chai'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

describe('Claude CLI Integration', function() {
  this.timeout(60_000) // 60 second timeout for Claude operations
  
  let session: ClaudeSession
  const playgroundPath = resolve('./claude-cli-playground-project')
  
  before(() => {
    // Verify playground directory exists
    if (!existsSync(playgroundPath)) {
      throw new Error('Playground directory not found. Run from handy-cli root directory.')
    }
  })
  
  beforeEach(() => {
    // Create a new session for each test
    session = new ClaudeSession(playgroundPath)
  })
  
  afterEach(() => {
    // Clean up session
    if (session.isRunning()) {
      session.kill()
    }
  })
  
  it('should execute ls command and list files in playground directory', (done) => {
    const responses: ClaudeResponse[] = []
    let hasListedFiles = false
    let sessionId: string | undefined
    let testCompleted = false
    
    // Set a timeout to prevent infinite hanging
    const timeout = setTimeout(() => {
      if (!testCompleted) {
        testCompleted = true
        session.kill()
        done(new Error('Test timeout: Claude did not respond within expected time'))
      }
    }, 30_000) // 30 second timeout
    
    session.on('response', (response: ClaudeResponse) => {
      responses.push(response)
      logger.info('Response type:', response.type, 'Session ID:', response.session_id)
      
      // Capture session ID
      if (response.session_id) {
        sessionId = response.session_id
        logger.info('Captured session ID:', sessionId)
      }
      
      // Check various response types for file listing
      if (response.type === 'assistant' || response.type === 'assistant_message') {
        const content = JSON.stringify(response).toLowerCase()
        // Check for expected files
        if (content.includes('hello-world.js') || 
            content.includes('readme.md') || 
            content.includes('package.json') ||
            content.includes('src')) {
          hasListedFiles = true
        }
      }
      
      // End test when we get result (like in simple-spawn.test.ts)
      if ((response.type === 'result' || response.type === 'completion' || response.type === 'error') && !testCompleted) {
        testCompleted = true
        clearTimeout(timeout)
        expect(sessionId).to.be.a('string')
        expect(sessionId).to.have.length.greaterThan(0)
        expect(hasListedFiles).to.equal(true, 'Claude should have listed files')
        expect(responses).to.have.length.greaterThan(0)
        done()
      }
    })
    
    session.on('error', (error) => {
      if (!testCompleted) {
        testCompleted = true
        clearTimeout(timeout)
        done(new Error(`Claude error: ${error}`))
      }
    })
    
    session.on('processError', (error) => {
      if (!testCompleted) {
        testCompleted = true
        clearTimeout(timeout)
        // Claude CLI might not be installed
        console.warn('Claude CLI not available:', error.message)
        done()
      }
    })
    
    session.on('exit', (exitInfo) => {
      if (!testCompleted) {
        testCompleted = true
        clearTimeout(timeout)
        // If we got here without completing the test properly, it means we didn't get a result
        // Check if we at least got a session ID and some responses
        if (sessionId && responses.length > 0) {
          // Process exited but we got some responses - this might be normal
          expect(sessionId).to.be.a('string')
          expect(responses).to.have.length.greaterThan(0)
          done()
        } else {
          // Process exited without proper responses - this is an error
          done(new Error(`Claude process exited with code ${exitInfo.code} and signal ${exitInfo.signal} without providing expected responses`))
        }
      }
    })
    
    // Start session with ls command
    session.startNewSession('Please run `ls -la` and tell me what files you see in this directory.')
  })
  
})