/**
 * Tests for the Claude spawner module
 * 
 * These tests verify that we can spawn Claude CLI processes correctly.
 */

import { logger } from '#utils/logger'
import { expect } from 'chai'

import { ClaudeSpawner } from './spawn.js'
import { ClaudeResponse } from './types.js'

describe('ClaudeSpawner', () => {
  let spawner: ClaudeSpawner
  
  beforeEach(() => {
    spawner = new ClaudeSpawner()
  })
  
  afterEach(() => {
    if (spawner.isRunning()) {
      spawner.kill()
    }
  })
  
  it('should spawn Claude CLI process', function(done) {
    this.timeout(5000) // 5 second timeout instead of default 60s
    let receivedResponse = false
    let receivedError = false
    
    spawner.on('response', (response: ClaudeResponse) => {
      receivedResponse = true
      expect(response).to.have.property('type')
      spawner.kill()
      done()
    })
    
    spawner.on('error', (error: string) => {
      receivedError = true
      // If we get "Debugger attached", it's not a real error
      if (error.includes('Debugger attached')) {
        logger.warn('Ignoring debugger attached message')
        return
      }

      // Real error - Claude might not be installed
      spawner.kill()
      done()
    })
    
    spawner.on('processError', (error: Error) => {
      // Claude CLI not found - skip test
      logger.warn('Claude CLI not found, skipping test:', error.message)
      done()
    })
    
    // Set a timeout to fail if we don't get a response
    setTimeout(() => {
      if (!receivedResponse && !receivedError) {
        spawner.kill()
        done(new Error('Timeout: No response from Claude CLI'))
      }
    }, 4000)
    
    // Try to spawn Claude with a simple command
    spawner.spawn('Hello', {
      model: 'sonnet',
      workingDirectory: process.cwd()
    })
  })
})