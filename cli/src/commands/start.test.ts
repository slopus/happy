/**
 * End-to-end integration test for handy-cli bin/dev.js
 * 
 * This test demonstrates how to properly spawn and control the CLI process
 * for integration testing using promise-based approach for deterministic results.
 */

import { authGetToken, getOrCreateSecretKey } from '#auth/auth'
import { SessionService } from '#session/service'
import { SocketClient } from '#socket/client'
import { getConfig } from '#utils/config'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ChildProcess, execSync, spawn } from 'node:child_process'
import { join } from 'node:path'

describe('CLI bin/dev.js Integration <-> server <-> mocked client', () => {
  
  let cliProcess: ChildProcess | null = null
  const projectRoot = process.cwd()
  const binPath = join(projectRoot, 'bin', 'dev.js')
  
  // Clean up Claude sessions before each test
  beforeEach(() => {
    // Remove any existing Claude sessions for the playground project
    const claudeProjectPath = process.env.HOME + '/.claude/projects/-Users-kirilldubovitskiy-projects-handy-cli-claude-cli-playground-project'
    try {
      execSync(`rm -rf "${claudeProjectPath}"`, { stdio: 'ignore' })
    } catch {
      // Ignore errors if directory doesn't exist
    }
  })
  
  afterEach(() => {
    // Clean up any running processes
    if (cliProcess && !cliProcess.killed) {
      cliProcess.kill('SIGINT')
      cliProcess = null
    }
  })

  it('Sanity check: should show version with --version flag', async () => {
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
    
    // Create a promise that resolves when process exits
    await new Promise<void>((resolve, reject) => {
      cliProcess!.on('exit', (code, _signal) => {
        processExited = true
        
        // Should exit successfully
        expect(code).toBe(0)
        
        // Should show version
        const output = outputs.join('')
        expect(output).toMatch(/\d+\.\d+\.\d+/) // Matches semantic version
        
        resolve()
      })
      
      cliProcess!.on('error', (error) => {
        reject(error)
      })
      
      // Set a timeout in case process doesn't exit
      setTimeout(() => {
        if (!processExited) {
          cliProcess?.kill('SIGTERM')
          reject(new Error('CLI process did not exit within timeout'))
        }
      }, 5000)
    })
  })
  
  /**
   * Run our bin/dev.js start command and respond to a single client messages 
   * that lists files in the directory of the playground project 
   * with a single file hello-world.js
   * 
   * This test is a bit more complex, because we need to:
   * 1. Spawn the CLI process in a playground directory with a single hello-world.js
   * 2. Wait for the CLI process to start
   * 3. We by default send a message to claude code to show current directory
   *      to make sure we are in the expected project + sanity check our system.
   * 4. Extract the session ID from the CLI process output
   * 5. Create a test client and connect to the server
   * 6. Assert client recieves current directory within 5 seconds
   * 7. The client sends a message asking to list files in the toy directory 
   * 8. Wait for the response to contain the hello-world.js file for 10 seconds
   * 9. Disconnect the test client
   * 8. Clean up the CLI process
   */
  it('should run start command and respond to client messages', async () => {
    console.log('=== Starting End-to-End Test ===')
    
    const playgroundPath = join(projectRoot, 'claude-cli-playground-project')
    
    // Create a promise-based test runner
    const testResult = await new Promise<void>((resolve, reject) => {
      let sessionId: null | string = null
      let testCompleted = false
      
      const cleanup = () => {
        if (cliProcess && !cliProcess.killed) {
          cliProcess.kill('SIGINT')
          cliProcess = null
        }
      }
      
      const completeTest = (error?: Error) => {
        if (testCompleted) return
        testCompleted = true
        cleanup()
        
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      
      // Overall test timeout
      const testTimeout = setTimeout(() => {
        completeTest(new Error('Test timeout: Did not complete within 30 seconds'))
      }, 30_000)
      
      console.log('Step 1: Spawning CLI process...')
      cliProcess = spawn('node', [binPath, 'start'], {
        cwd: playgroundPath,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      
      cliProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString()
        console.log('CLI stdout:', output)
        
        // Parse session ID from output
        const sessionMatch = output.match(/Session created: ([a-zA-Z0-9-]+)/)
        if (sessionMatch) {
          sessionId = sessionMatch[1]
          console.log('Step 2: Extracted session ID:', sessionId)
        }
        
        // Look for ready signal
        if (output.includes('Handy CLI is running') && sessionId) {
          console.log('Step 3: CLI is ready with session ID!')
          clearTimeout(testTimeout)
          createTestClient(sessionId)
            .then(() => completeTest())
            .catch(completeTest)
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
          completeTest(new Error(`CLI exited unexpectedly with code ${code}`))
        }
      })
      
      cliProcess.on('error', (error) => {
        console.log('CLI process error:', error)
        completeTest(error)
      })
    })
    
    async function createTestClient(sessionId: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const runTestClient = async () => {
          try {
            console.log('Step 4: Creating test client...')
            
            // Get auth token
            const config = getConfig()
            // This key would normally be read from the QR code from the terminal
            const secret = await getOrCreateSecretKey()
            const authToken = await authGetToken(config.serverUrl, secret)
            console.log('Auth token obtained')
            
            // Use the parsed session ID
            const session = { id: sessionId }
            const sessionService = new SessionService(config.serverUrl, authToken)
            console.log('Using session:', session.id)
            
            console.log('Step 5: Connecting test client...')
            const socketClient = new SocketClient({
              authToken,
              serverUrl: config.serverUrl,
              socketPath: config.socketPath,
            })
            
            let cwdResponseReceived = false
            let fileListResponseReceived = false
            let messageSent = false
            
            // Listen for updates
            // eslint-disable-next-line complexity
            socketClient.on('update', (update) => {
              console.log('Received update type:', update.content?.t, 'for session:', update.content?.sid)
              
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

                  console.log('Decrypted content type:', decryptedContent?.type, 'data type:', decryptedContent?.data?.type)
                  
                  // Check if it's a Claude response
                  if (typeof decryptedContent === 'object' && 
                      decryptedContent !== null && 
                      'type' in decryptedContent && 
                      decryptedContent.type === 'claude-response') {
                    
                    const responseData = JSON.stringify(decryptedContent).toLowerCase()
                    console.log('Checking response - cwdResponseReceived:', cwdResponseReceived, 'includes playground:', responseData.includes('claude-cli-playground-project'))
                    
                    // Step 6: Check for current working directory (initial command)
                    if (!cwdResponseReceived && responseData.includes('claude-cli-playground-project')) {
                      console.log('Step 6: Received current working directory response within 5 seconds!')
                      cwdResponseReceived = true
                      
                      // Now send the client message to list files
                      if (!messageSent) {
                        messageSent = true
                        console.log('Step 7: Sending client message to list files...')
                        sessionService.sendMessage(session.id, {
                          content: 'ls',
                          type: 'text-input'
                        }).then(() => {
                          console.log('Client message sent successfully')
                        }).catch((error) => {
                          console.error('Failed to send client message:', error)
                          reject(error)
                        })
                      }
                    }
                    
                    // Step 8: Check for hello-world.js in file listing
                    if (cwdResponseReceived && messageSent) {
                      // Log tool results to debug
                      if (decryptedContent.data?.type === 'user' && decryptedContent.data?.message?.content) {
                        // Check tool results in user messages
                        const toolResults = decryptedContent.data.message.content.filter((c: { type: string }) => c.type === 'tool_result')
                        // eslint-disable-next-line max-depth
                        if (toolResults.length > 0) {
                          console.log('Tool results found:', JSON.stringify(toolResults))
                          // Check if any tool result contains hello-world.js
                          const hasHelloWorld = toolResults.some((result: { content?: string }) => 
                            result.content && result.content.toLowerCase().includes('hello-world.js')
                          )
                          // eslint-disable-next-line max-depth
                          if (hasHelloWorld) {
                            console.log('Step 8: Found hello-world.js in tool results!')
                            fileListResponseReceived = true
                            socketClient.disconnect()
                            console.log('=== Test Completed Successfully ===')
                            // Give the CLI time to shut down gracefully
                            setTimeout(() => {
                              if (cliProcess && !cliProcess.killed) {
                                cliProcess.kill('SIGINT') // Use SIGINT for graceful shutdown
                              }
                            }, 100)
                            resolve()
                          }
                        }
                      }
                      
                      // Also check in the full response
                      if (responseData.includes('hello-world.js')) {
                        console.log('Step 8: Found hello-world.js in response!')
                        fileListResponseReceived = true
                        socketClient.disconnect()
                        console.log('=== Test Completed Successfully ===')
                        // Give the CLI time to shut down gracefully
                        setTimeout(() => {
                          if (cliProcess && !cliProcess.killed) {
                            cliProcess.kill('SIGINT') // Use SIGINT for graceful shutdown
                          }
                        }, 100)
                        resolve()
                      }
                    }
                  }
                } catch (decryptError) {
                  console.log('Failed to decrypt message:', decryptError)
                  reject(decryptError)
                }
              }
            })
            
            socketClient.connect()
            await socketClient.waitForAuth()
            console.log('Test client connected and authenticated')
            
            // Don't send any message here - we'll wait for CWD response first
            console.log('Waiting for initial current working directory response...')
            
            // Set timeouts for two-stage check
            setTimeout(() => {
              if (!cwdResponseReceived) {
                socketClient.disconnect()
                reject(new Error('Did not receive current working directory response within 5 seconds'))
              }
            }, 5000) // 5 second timeout for CWD response
            
            setTimeout(() => {
              if (cwdResponseReceived && !fileListResponseReceived) {
                socketClient.disconnect()
                reject(new Error('Did not receive hello-world.js in file listing response within 10 seconds'))
              }
            }, 15_000) // 15 second timeout for complete test
            
          } catch (error) {
            console.log('Error in createTestClient:', error)
            reject(error)
          }
        }
        
        runTestClient()
      })
    }
    
    return testResult
  }, 30_000)
})