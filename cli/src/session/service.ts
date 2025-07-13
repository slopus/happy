/**
 * Session service for managing handy-server sessions
 */

import type { CreateSessionResponse, GetMessagesResponse, MessageContent, SendMessageResponse } from '#session/types'

import { logger } from '#utils/logger'
import axios from 'axios'

export class SessionService {
  constructor(
    private readonly serverUrl: string,
    private readonly authToken: string
  ) {}
  
  /**
   * Create a new session or load existing one with the given tag
   */
  async createSession(tag: string): Promise<CreateSessionResponse> {
    try {
      const response = await axios.post<CreateSessionResponse>(
        `${this.serverUrl}/v1/sessions`,
        { tag },
        {
          headers: {
            'Authorization': `Bearer ${this.authToken}`,
            'Content-Type': 'application/json'
          }
        }
      )
      
      logger.info(`Session created/loaded: ${response.data.session.id} (tag: ${tag})`)
      return response.data
    } catch (error) {
      logger.error('Failed to create session:', error)
      throw new Error(`Failed to create session: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }
  
  /**
   * Decrypt a message content
   * Note: In real implementation, this would use proper decryption
   */
  decryptContent(encryptedContent: string): unknown {
    try {
      const jsonContent = Buffer.from(encryptedContent, 'base64').toString('utf8')
      return JSON.parse(jsonContent)
    } catch (error) {
      logger.error('Failed to decrypt content:', error)
      throw new Error('Failed to decrypt message content')
    }
  }
  
  /**
   * Get messages from a session
   */
  async getMessages(sessionId: string): Promise<GetMessagesResponse> {
    try {
      const response = await axios.get<GetMessagesResponse>(
        `${this.serverUrl}/v1/sessions/${sessionId}/messages`,
        {
          headers: {
            'Authorization': `Bearer ${this.authToken}`,
            'Content-Type': 'application/json'
          }
        }
      )
      
      logger.debug(`Retrieved ${response.data.messages.length} messages from session ${sessionId}`)
      return response.data
    } catch (error) {
      logger.error('Failed to get messages:', error)
      throw new Error(`Failed to get messages: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Send a message to a session
   * Note: In real implementation, we'd encrypt the content before sending
   */
  async sendMessage(sessionId: string, content: unknown): Promise<SendMessageResponse> {
    try {
      // For now, we'll just base64 encode the JSON content
      // In production, this should use proper encryption
      const jsonContent = JSON.stringify(content)
      const base64Content = Buffer.from(jsonContent).toString('base64')
      
      const messageContent: MessageContent = {
        c: base64Content,
        t: 'encrypted'
      }
      
      const response = await axios.post<SendMessageResponse>(
        `${this.serverUrl}/v1/sessions/${sessionId}/messages`,
        messageContent,
        {
          headers: {
            'Authorization': `Bearer ${this.authToken}`,
            'Content-Type': 'application/json'
          }
        }
      )
      
      logger.debug(`Message sent to session ${sessionId}, seq: ${response.data.message.seq}`)
      return response.data
    } catch (error) {
      logger.error('Failed to send message:', error)
      throw new Error(`Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }
}