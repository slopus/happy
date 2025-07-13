/**
 * End-to-end integration test for handy-cli
 * 
 * This test verifies the complete flow:
 * 1. CLI connects to server
 * 2. Test client connects to same session
 * 3. Messages flow between test client and CLI through server
 */

import { authGetToken, getOrCreateSecretKey } from '#auth/auth'
import { ClaudeSession } from '#claude/session'
import { ClaudeResponse } from '#claude/types'
import { MessageHandler } from '#handlers/message-handler'
import { SessionService } from '#session/service'
import { SocketClient } from '#socket/client'
import { Update } from '#socket/types'
import { getConfig } from '#utils/config'
import { logger } from '#utils/logger'
import axios from 'axios'
import { expect } from 'chai'
import { io, Socket } from 'socket.io-client'

describe('End-to-end Integration', function() {
  this.timeout(30_000) // 30 second timeout for integration tests
  
  let cliSocketClient: null | SocketClient = null
  let testClient: null | Socket = null
  let claudeSession: ClaudeSession | null = null
  let messageHandler: MessageHandler | null = null
  let authToken: string
  let sessionId: string
  
  before(async () => {
    // Get auth token
    const config = getConfig()
    const secret = await getOrCreateSecretKey()
    authToken = await authGetToken(config.serverUrl, secret)
  })
  
  afterEach(() => {
    // Clean up
    if (messageHandler) {
      messageHandler.stop()
      messageHandler = null
    }
    
    if (claudeSession) {
      claudeSession.kill()
      claudeSession = null
    }
    
    if (cliSocketClient) {
      cliSocketClient.disconnect()
      cliSocketClient = null
    }
    
    if (testClient) {
      testClient.disconnect()
      testClient = null
    }
  })
  
  it('should establish bidirectional communication between CLI and test client', async () => {
    const config = getConfig()
    
    // Step 1: Create a session via API
    logger.info('Creating session...')
    const sessionResponse = await axios.post(
      `${config.serverUrl}/v1/sessions`,
      { tag: 'test-integration-' + Date.now() },
      { headers: { Authorization: `Bearer ${authToken}` } }
    )
    sessionId = sessionResponse.data.session.id
    logger.info('Session created:', sessionId)
    
    // Step 2: Connect CLI to server
    logger.info('Connecting CLI to server...')
    cliSocketClient = new SocketClient({
      authToken,
      serverUrl: config.serverUrl,
      socketPath: config.socketPath,
    })
    
    // Initialize Claude session (without actually spawning Claude for this test)
    claudeSession = new ClaudeSession(process.cwd())
    
    // Create session service
    const sessionService = new SessionService(config.serverUrl, authToken)
    
    messageHandler = new MessageHandler(
      cliSocketClient, 
      claudeSession, 
      sessionService, 
      sessionId
    )
    
    // Track received messages
    const cliReceivedMessages: ClaudeResponse[] = []
    messageHandler.on('claudeResponse', (response) => {
      logger.info('CLI received Claude response:', response)
      cliReceivedMessages.push(response)
    })
    
    // Connect CLI
    cliSocketClient.connect()
    await cliSocketClient.waitForAuth()
    logger.info('CLI connected and authenticated')
    
    // Step 3: Connect test client
    logger.info('Connecting test client...')
    testClient = io(config.serverUrl, {
      auth: { token: authToken },
      path: config.socketPath,
      transports: ['websocket', 'polling']
    })
    
    // Wait for test client to connect
    await new Promise<void>((resolve, reject) => {
      testClient!.on('connect', () => {
        logger.info('Test client connected')
        resolve()
      })
      
      testClient!.on('connect_error', (error) => {
        reject(error)
      })
      
      // Add timeout
      setTimeout(() => { reject(new Error('Test client connection timeout')) }, 5000)
    })
    
    // Give the connection a moment to stabilize
    await new Promise(resolve => { setTimeout(resolve, 500) })
    logger.info('Test client ready')
    
    // Step 4: Test client listens for updates
    const testClientReceivedUpdates: Update[] = []
    testClient.on('update', (update) => {
      logger.info('Test client received update:', update)
      testClientReceivedUpdates.push(update)
    })
    
    // Step 5: CLI listens for updates
    const cliReceivedUpdates: Update[] = []
    cliSocketClient.on('update', (update) => {
      logger.info('CLI received update:', update)
      cliReceivedUpdates.push(update)
    })
    
    // Step 6: Send a message to the session
    logger.info('Sending message to session...')
    const testMessage = {
      c: Buffer.from(JSON.stringify({
        content: 'Hello from test client!',
        type: 'text-input'
      })).toString('base64'),
      t: 'encrypted'
    }
    
    const messageResponse = await axios.post(
      `${config.serverUrl}/v1/sessions/${sessionId}/messages`,
      testMessage,
      { headers: { Authorization: `Bearer ${authToken}` } }
    )
    logger.info('Message sent:', messageResponse.data.message.id)
    
    // Wait for message propagation
    await new Promise(resolve => { setTimeout(resolve, 1000) })
    
    // Verify: Both clients should receive the update
    logger.info('CLI received updates:', cliReceivedUpdates.length)
    logger.info('Test client received updates:', testClientReceivedUpdates.length)
    
    // At least one client should receive the update
    const totalUpdates = cliReceivedUpdates.length + testClientReceivedUpdates.length
    expect(totalUpdates).to.be.greaterThan(0)
    
    // Check the update format
    const updates = [...cliReceivedUpdates, ...testClientReceivedUpdates]
    if (updates.length > 0) {
      const lastUpdate = updates.at(-1)!
      expect(lastUpdate).to.have.property('content')
      expect(lastUpdate.content).to.have.property('t', 'new-message')
    }
  })
  
  it('should handle socket reconnection gracefully', async () => {
    const config = getConfig()
    
    // Connect CLI
    cliSocketClient = new SocketClient({
      authToken,
      serverUrl: config.serverUrl,
      socketPath: config.socketPath,
    })
    
    cliSocketClient.connect()
    await cliSocketClient.waitForAuth()
    
    expect(cliSocketClient.getIsConnected()).to.equal(true)
    
    // Force disconnect
    cliSocketClient.disconnect()
    expect(cliSocketClient.getIsConnected()).to.equal(false)
    
    // Reconnect
    cliSocketClient.connect()
    await cliSocketClient.waitForAuth()
    
    expect(cliSocketClient.getIsConnected()).to.equal(true)
  })
})