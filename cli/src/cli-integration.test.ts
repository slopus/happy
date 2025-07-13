/**
 * End-to-end integration test for handy-cli bin/dev.js
 * 
 * This test demonstrates how to properly spawn and control the CLI process
 * for integration testing.
 */

import { authGetToken, getOrCreateSecretKey } from '#auth/auth'
import { SessionService } from '#session/service'
import { SocketClient } from '#socket/client'
import { getConfig } from '#utils/config'
import { expect } from 'chai'
import { ChildProcess, spawn } from 'node:child_process'
import { join } from 'node:path'

describe('CLI bin/dev.js Integration', function() {
  this.timeout(10_000) // 10 second timeout for integration tests
  
  let cliProcess: ChildProcess | null = null
  const projectRoot = process.cwd()
  const binPath = join(projectRoot, 'bin', 'dev.js')
  
  afterEach(() => {
    // Clean up any running processes
    if (cliProcess && !cliProcess.killed) {
      cliProcess.kill('SIGTERM')
      cliProcess = null
    }
  })

  it('should show version with --version flag', (done) => {
    const outputs: string[] = []
    let processExited = false
    
    cliProcess = spawn('node', [binPath, '--version'], {
      cwd: projectRoot,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    
    cliProcess.stdout?.on('data', (data: Buffer) => {
      outputs.push(data.toString())
    })
    
    cliProcess.on('exit', (code, _signal) => {
      processExited = true
      
      // Should exit successfully
      expect(code).to.equal(0)
      
      // Should show version
      const output = outputs.join('')
      expect(output).to.match(/\d+\.\d+\.\d+/) // Matches semantic version
      
      done()
    })
    
    cliProcess.on('error', (error) => {
      done(error)
    })
    
    // Set a timeout in case process doesn't exit
    setTimeout(() => {
      if (!processExited) {
        cliProcess?.kill('SIGTERM')
        done(new Error('CLI process did not exit within timeout'))
      }
    }, 5000)
  })
  
  it('should run start command and respond to client messages', (done) => {
    console.log('=== Starting End-to-End Test ===')
    
    const playgroundPath = '/Users/kirilldubovitskiy/projects/handy-cli/claude-cli-playground-project'
    const cliOutputs: string[] = []
    let testCompleted = false
    
    // Timeout after 10 seconds
    const testTimeout = setTimeout(() => {
      if (!testCompleted) {
        testCompleted = true
        cliProcess?.kill('SIGTERM')
        done(new Error('Test timeout: Did not complete within 10 seconds'))
      }
    }, 10_000)
    
    console.log('Step 1: Spawning CLI process...')
    cliProcess = spawn('node', [binPath, 'start'], {
      cwd: playgroundPath,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    
    cliProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString()
      cliOutputs.push(output)
      console.log('CLI stdout:', output)
      
      // Look for ready signal
      if (output.includes('Handy CLI is running')) {
        console.log('Step 2: CLI is ready!')
        createTestClient()
      }
    })
    
    cliProcess.stderr?.on('data', (data: Buffer) => {
      const error = data.toString()
      // Only log real errors, not warnings
      if (!error.includes('ExperimentalWarning') && !error.includes('DeprecationWarning')) {
        console.log('CLI stderr:', error)
      }
    })
    
    cliProcess.on('exit', (code, signal) => {
      console.log(`CLI process exited with code ${code} and signal ${signal}`)
      if (!testCompleted) {
        testCompleted = true
        clearTimeout(testTimeout)
        // If CLI exits unexpectedly, that's an error
        done(new Error(`CLI exited unexpectedly with code ${code}`))
      }
    })
    
    cliProcess.on('error', (error) => {
      console.log('CLI process error:', error)
      if (!testCompleted) {
        testCompleted = true
        clearTimeout(testTimeout)
        done(error)
      }
    })
    
    async function createTestClient() {
      try {
        console.log('Step 3: Creating test client...')
        
        // Get auth token
        const config = getConfig()
        const secret = await getOrCreateSecretKey()
        const authToken = await authGetToken(config.serverUrl, secret)
        console.log('Auth token obtained')
        
        // Create session using playground directory name as tag
        const sessionService = new SessionService(config.serverUrl, authToken)
        const { session } = await sessionService.createSession('claude-cli-playground-project')
        console.log('Session created:', session.id)
        
        console.log('Step 4: Connecting test client...')
        const socketClient = new SocketClient({
          authToken,
          serverUrl: config.serverUrl,
          socketPath: config.socketPath,
        })
        
        let foundResponse = false
        
        // Listen for updates
        socketClient.on('update', (update) => {
          console.log('Received update:', update)
          
          // Check if this is for our session
          if (update.content.t === 'new-message' && update.content.sid === session.id) {
            try {
              // Handle nested decryption structure
              let decryptedContent
              if (typeof update.content.c === 'object' && update.content.c.c && update.content.c.t === 'encrypted') {
                // Nested encrypted structure
                decryptedContent = sessionService.decryptContent(update.content.c.c)
              } else if (typeof update.content.c === 'string') {
                decryptedContent = sessionService.decryptContent(update.content.c)
              } else {
                // Already decrypted object
                decryptedContent = update.content.c
              }

              console.log('Decrypted content:', decryptedContent)
              
              // Check if it's a Claude response
              if (typeof decryptedContent === 'object' && 
                  decryptedContent !== null && 
                  'type' in decryptedContent && 
                  decryptedContent.type === 'claude-response') {
                
                const responseData = JSON.stringify(decryptedContent).toLowerCase()
                console.log('Checking response for hello-world.js...')
                
                // Check if response contains hello-world.js
                if (responseData.includes('hello-world.js')) {
                  console.log('Step 6: Found hello-world.js in response!')
                  foundResponse = true
                  
                  if (!testCompleted) {
                    testCompleted = true
                    clearTimeout(testTimeout)
                    socketClient.disconnect()
                    cliProcess?.kill('SIGTERM')
                    
                    console.log('=== Test Completed Successfully ===')
                    done()
                  }
                }
              }
            } catch (decryptError) {
              console.log('Failed to decrypt message:', decryptError)
            }
          }
        })
        
        socketClient.connect()
        await socketClient.waitForAuth()
        console.log('Test client connected and authenticated')
        
        console.log('Step 5: Sending message to Claude...')
        // Send message asking to list directory (using LS tool which shouldn't need permissions)
        await sessionService.sendMessage(session.id, {
          content: 'Use the LS tool to list files in the current directory. Show me what files are here.',
          type: 'text-input'
        })
        console.log('Message sent to session')
        
        // Set a fallback timeout in case we don't get the expected response
        setTimeout(() => {
          if (!testCompleted && !foundResponse) {
            testCompleted = true
            clearTimeout(testTimeout)
            socketClient.disconnect()
            cliProcess?.kill('SIGTERM')
            done(new Error('Did not receive expected response containing hello-world.js'))
          }
        }, 8000) // 8 second fallback
        
      } catch (error) {
        console.log('Error in createTestClient:', error)
        if (!testCompleted) {
          testCompleted = true
          clearTimeout(testTimeout)
          cliProcess?.kill('SIGTERM')
          done(error)
        }
      }
    }
  })
})