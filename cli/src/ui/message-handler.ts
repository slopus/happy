/**
 * Message handler for handy-cli
 * 
 * This module handles incoming messages from the socket server
 * and coordinates between the socket client and Claude CLI.
 * 
 * Key responsibilities:
 * - Process incoming text-input messages
 * - Forward messages to Claude CLI
 * - Send Claude responses back through socket
 * - Handle message encryption/decryption (future)
 * 
 * Design decisions:
 * - Uses event-driven architecture for loose coupling
 * - Handles only text-input messages initially
 * - Prepared for future encryption support
 */

import { Claude, ClaudeOptions } from '@/claude/claude'
import { ClaudeResponse } from '@/claude/types'
import { SessionService } from '@/api/api'
import { SocketClient } from '@/api/apiSession'
import { SessionMessageContent, TextInputMessage, Update } from '@/api/types'
import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'

export interface MessageHandlerOptions {
  claudeOptions?: Partial<ClaudeOptions>
  sessionId: string
  sessionService: SessionService
  socketClient: SocketClient
  workingDirectory: string
}

// eslint-disable-next-line unicorn/prefer-event-target
export class MessageHandler extends EventEmitter {
  private claude: Claude
  private claudeOptions: Partial<ClaudeOptions>
  private sessionId: string
  private sessionService: SessionService
  private socketClient: SocketClient
  private workingDirectory: string
  
  constructor(options: MessageHandlerOptions) {
    super()
    this.socketClient = options.socketClient
    this.claude = new Claude()
    this.sessionService = options.sessionService
    this.sessionId = options.sessionId
    this.workingDirectory = options.workingDirectory
    this.claudeOptions = options.claudeOptions || {}
    this.setupHandlers()
  }
  
  /**
   * Handle initial command directly (for startup)
   */
  handleInitialCommand(command: string): void {
    logger.info('Handling initial command:', command)
    
    // Run Claude command
    this.claude.runClaudeCodeTurn(
      command,
      undefined, // No session ID for initial command
      {
        workingDirectory: this.workingDirectory,
        ...this.claudeOptions
      }
    )
  }
  
  /**
   * Start handling messages
   */
  start(): void {
    logger.info('Message handler started')
    // Any initialization logic can go here
  }
  
  /**
   * Stop handling messages
   */
  stop(): void {
    logger.info('Message handler stopped')
    this.claude.kill()
  }
  
  /**
   * Handle Claude responses
   */
  private async handleClaudeResponse(response: ClaudeResponse): Promise<void> {
    logger.info('Claude response:', JSON.stringify(response, null, 2))
    
    try {
      // Send the response to the server session
      await this.sessionService.sendMessage(this.sessionId, {
        data: response,
        type: 'claude-response'
      });
      
      // Emit for local handling
      this.emit('claudeResponse', response);
    } catch (error) {
      logger.error('Failed to send Claude response to server:', error);
      this.emit('error', error);
    }
  }
  
  /**
   * Handle text input messages
   */
  private handleTextInput(message: TextInputMessage): void {
    logger.info('Received text input:', message.content)
    
    // Run Claude command (kills any existing process automatically)
    this.claude.runClaudeCodeTurn(
      message.content,
      undefined, // No session resuming for now
      {
        workingDirectory: this.workingDirectory,
        ...this.claudeOptions
      }
    )
  }
  
  /**
   * Handle update messages from the server
   */
  private handleUpdate(update: Update): void {
    logger.debug('Received update:', JSON.stringify(update, null, 2))
    
    // Check if this is a new message for our session
    if (update.content.t === 'new-message') {
      const { c, sid } = update.content
      
      // Verify this message is for our session
      if (sid !== this.sessionId) {
        logger.debug('Message for different session, ignoring')
        return
      }
      
      try {
        // Log the raw content structure for debugging
        logger.debug('Raw content (c):', JSON.stringify(c))
        logger.debug('Content type:', typeof c)
        
        // Check if content is already a string or needs extraction
        let encryptedContent: string
        if (typeof c === 'string') {
          // Direct string content
          encryptedContent = c
        } else if (typeof c === 'object' && c !== null && 'c' in c && typeof (c as SessionMessageContent).c === 'string') {
          // Nested structure: { c: 'base64string', t: 'encrypted' }
          logger.debug('Extracting from nested structure')
          encryptedContent = (c as SessionMessageContent).c
        } else {
          logger.error('Invalid content structure:', c)
          return
        }
        
        // Decrypt the content
        const decryptedContent = this.sessionService.decryptContent(encryptedContent)
        logger.debug('Decrypted content:', decryptedContent)
        
        // Type guard for the decrypted content
        if (typeof decryptedContent === 'object' && 
            decryptedContent !== null && 
            'type' in decryptedContent) {
          const message = decryptedContent as { type: string }
          
          // Handle the message based on type
          if (message.type === 'text-input') {
            this.handleTextInput(decryptedContent as TextInputMessage)
          } else if (message.type === 'claude-response') {
            // This is our own claude-response being echoed back from the server
            // We can safely ignore it or log it for debugging
            logger.debug('Received claude-response echo from server:', message)
          } else {
            logger.warn('Unknown message type:', message.type)
          }
        } else {
          logger.error('Invalid message format')
        }
      } catch (error) {
        logger.error('Failed to process message:', error)
      }
    }
  }
  
  /**
   * Set up event handlers
   */
  private setupHandlers(): void {
    // Handle updates from socket server
    this.socketClient.on('update', (update: Update) => {
      this.handleUpdate(update)
    })
    
    // Handle Claude responses
    this.claude.on('response', (response: ClaudeResponse) => {
      this.handleClaudeResponse(response)
    })
    
    // Handle Claude output (non-JSON)
    this.claude.on('output', (output: string) => {
      logger.debug('Claude output:', output)
      // For now, we'll log non-JSON output
      // In the future, we might want to send this to the client
    })
    
    // Handle Claude errors
    this.claude.on('error', (error: string) => {
      logger.error('Claude error:', error)
      this.emit('error', error)
    })
    
    // Handle Claude exit
    this.claude.on('exit', (exitInfo: { code: number | null; signal: string | null }) => {
      logger.info('Claude exited:', exitInfo)
      this.emit('claudeExit', exitInfo)
    })
  }
}