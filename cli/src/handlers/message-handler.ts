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

import { ClaudeSession } from '#claude/session'
import { ClaudeResponse } from '#claude/types'
import { SessionService } from '#session/service'
import { SocketClient } from '#socket/client'
import { TextInputMessage, Update } from '#socket/types'
import { logger } from '#utils/logger'
import { EventEmitter } from 'node:events'

// eslint-disable-next-line unicorn/prefer-event-target
export class MessageHandler extends EventEmitter {
  private claudeSession: ClaudeSession
  private sessionId: string
  private sessionService: SessionService
  private socketClient: SocketClient
  
  constructor(
    socketClient: SocketClient, 
    claudeSession: ClaudeSession,
    sessionService: SessionService,
    sessionId: string
  ) {
    super()
    this.socketClient = socketClient
    this.claudeSession = claudeSession
    this.sessionService = sessionService
    this.sessionId = sessionId
    this.setupHandlers()
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
    if (this.claudeSession.isRunning()) {
      this.claudeSession.kill()
    }
  }
  
  /**
   * Handle Claude responses
   */
  private async handleClaudeResponse(response: ClaudeResponse): Promise<void> {
    logger.debug('Claude response:', response)
    
    try {
      // Send the response to the server session
      await this.sessionService.sendMessage(this.sessionId, {
        data: response,
        type: 'claude-response'
      })
      
      // Emit for local handling
      this.emit('claudeResponse', response)
    } catch (error) {
      logger.error('Failed to send Claude response to server:', error)
      this.emit('error', error)
    }
  }
  
  /**
   * Handle text input messages
   */
  private handleTextInput(message: TextInputMessage): void {
    logger.info('Received text input:', message.content)
    
    // Forward to Claude
    if (this.claudeSession.isRunning()) {
      // If Claude is running, send as input
      this.claudeSession.sendInput(message.content)
    } else {
      // If Claude is not running, start a new command
      this.claudeSession.execute(message.content)
    }
  }
  
  /**
   * Handle update messages from the server
   */
  private handleUpdate(update: Update): void {
    logger.debug('Received update:', update)
    
    // Check if this is a new message for our session
    if (update.content.t === 'new-message') {
      const { c, sid } = update.content
      
      // Verify this message is for our session
      if (sid !== this.sessionId) {
        logger.debug('Message for different session, ignoring')
        return
      }
      
      try {
        // Decrypt the content
        const decryptedContent = this.sessionService.decryptContent(c)
        
        // Type guard for the decrypted content
        if (typeof decryptedContent === 'object' && 
            decryptedContent !== null && 
            'type' in decryptedContent) {
          const message = decryptedContent as { type: string }
          
          // Handle the message based on type
          if (message.type === 'text-input') {
            this.handleTextInput(decryptedContent as TextInputMessage)
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
    this.claudeSession.on('response', (response: ClaudeResponse) => {
      this.handleClaudeResponse(response)
    })
    
    // Handle Claude output (non-JSON)
    this.claudeSession.on('output', (output: string) => {
      logger.debug('Claude output:', output)
      // For now, we'll log non-JSON output
      // In the future, we might want to send this to the client
    })
    
    // Handle Claude errors
    this.claudeSession.on('error', (error: string) => {
      logger.error('Claude error:', error)
      this.emit('error', error)
    })
    
    // Handle Claude exit
    this.claudeSession.on('exit', (exitInfo) => {
      logger.info('Claude exited:', exitInfo)
      this.emit('claudeExit', exitInfo)
    })
  }
}