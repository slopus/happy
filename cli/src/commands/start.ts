/**
 * Start command for handy-cli
 * 
 * This is the main command that starts a Claude Code session and connects
 * it to the handy server for remote access.
 * 
 * Key responsibilities:
 * - Initialize authentication
 * - Establish socket connection
 * - Start Claude session
 * - Handle message routing
 * - Graceful shutdown
 * 
 * Design decisions:
 * - Uses oclif command framework as requested
 * - Handles all initialization in sequence
 * - Provides clear error messages
 * - Supports graceful shutdown on SIGINT/SIGTERM
 */

import { authGetToken, generateHandyUrl, getOrCreateSecretKey } from '#auth/auth'
import { MessageHandler } from '#handlers/message-handler'
import { SessionService } from '#session/service'
import { SocketClient } from '#socket/client'
import { getConfig } from '#utils/config'
import { logger } from '#utils/logger'
import { displayQRCode } from '#utils/qrcode'
import { Command, Flags } from '@oclif/core'
import { basename } from 'node:path'

export default class Start extends Command {
  static description = 'Start a Claude Code session connected to the handy server'
static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --model sonnet',
    '<%= config.bin %> <%= command.id %> --skip-permissions',
  ]
static flags = {
    model: Flags.string({
      char: 'm',
      default: 'sonnet',
      description: 'Claude model to use',
      options: ['sonnet', 'opus', 'haiku'],
    }),
    'permission-mode': Flags.string({
      default: 'auto',
      description: 'Permission mode for Claude',
      options: ['plan', 'auto', 'default'],
    }),
    'skip-permissions': Flags.boolean({
      default: true,
      description: 'Skip permission prompts (dangerous)',
    }),
    'test-session': Flags.string({
      description: 'Use a specific session ID for testing (internal use)',
      hidden: true,
    }),
  }
private messageHandler?: MessageHandler
  private sessionId?: string
  private sessionService?: SessionService
  private socketClient?: SocketClient
  
  async run(): Promise<void> {
    const { flags } = await this.parse(Start)
    
    try {
      // Load configuration
      const config = getConfig()
      logger.info('Starting handy-cli...')
      
      // Step 1: Authentication
      logger.info('Authenticating with server...')
      const secret = await getOrCreateSecretKey()
      const authToken = await authGetToken(config.serverUrl, secret)
      logger.info('Authentication successful')
      
      // Step 1.5: Display QR code for mobile connection
      const handyUrl = generateHandyUrl(secret)
      displayQRCode(handyUrl)
      
      // Step 2: Connect to socket server
      logger.info('Connecting to socket server...')
      this.socketClient = new SocketClient({
        authToken,
        serverUrl: config.serverUrl,
        socketPath: config.socketPath,
      })
      
      this.socketClient.connect()
      
      // Wait for authentication
      const user = await this.socketClient.waitForAuth()
      logger.info(`Connected as user: ${user}`)
      
      // Step 3: Create server session
      const workingDirectory = process.cwd()
      const sessionTag = basename(workingDirectory)
      logger.info(`Creating server session with tag: ${sessionTag}`)
      
      this.sessionService = new SessionService(config.serverUrl, authToken)
      const { session } = await this.sessionService.createSession(sessionTag)
      this.sessionId = session.id
      logger.info(`Session created: ${this.sessionId}`)
      
      // Step 4: Initialize Claude
      logger.info(`Initializing Claude in: ${workingDirectory}`)
      
      // Step 4: Set up message handler with session ID
      this.messageHandler = new MessageHandler({
        claudeOptions: {
          model: flags.model,
          permissionMode: flags['permission-mode'] as 'auto' | 'default' | 'plan',
          skipPermissions: flags['skip-permissions']
        },
        sessionId: this.sessionId,
        sessionService: this.sessionService,
        socketClient: this.socketClient,
        workingDirectory
      })
      this.messageHandler.start()
      
      // Set up event handlers for logging
      this.messageHandler.on('claudeResponse', (response) => {
        logger.info('Claude response:', JSON.stringify(response, null, 2))
      })
      
      this.messageHandler.on('error', (error) => {
        logger.error('Handler error:', error)
      })
      
      this.messageHandler.on('claudeExit', (exitInfo) => {
        logger.info('Claude process exited:', exitInfo)
      })
      
      // Step 5: Start initial Claude session
      logger.info('Starting Claude Code session...')
      logger.info('Model:', flags.model)
      logger.info('Permission mode:', flags['permission-mode'])
      logger.info('Skip permissions:', flags['skip-permissions'])
      
      // Start with a command to show current working directory to ensure we
      // are in the correct project
      const initialCommand = 'Show current working directory'
      logger.info('Sending initial command to Claude:', initialCommand)
      
      // Send the initial command through the message handler to ensure it's properly captured
      this.messageHandler.handleInitialCommand(initialCommand)
      
      // Set up graceful shutdown
      this.setupShutdownHandlers()
      
      logger.info('Handy CLI is running. Press Ctrl+C to stop.')
      logger.info('Waiting for commands from connected clients...')
      
      // Keep the process running
      await new Promise(() => {})
    } catch (error) {
      logger.error('Failed to start:', error)
      this.cleanup()
      this.exit(1)
    }
  }
  
  private cleanup(): void {
    if (this.messageHandler) {
      this.messageHandler.stop()
    }
    
    if (this.socketClient) {
      this.socketClient.disconnect()
    }
  }
  
  private setupShutdownHandlers(): void {
    process.on('SIGINT', () => this.shutdown())
    process.on('SIGTERM', () => this.shutdown())
  }
  
  private shutdown(): void {
    logger.info('Shutting down...')
    this.cleanup()
    
    // Use OCLIF's exit method for proper shutdown
    this.exit(0)
  }
}