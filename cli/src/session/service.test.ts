/**
 * Tests for the session service module
 * 
 * This test verifies the complete session workflow: create session, send message, read message
 * using the real handy server API. No mocking is used as per project requirements.
 */

import { authGetToken, getOrCreateSecretKey } from '#auth/auth'
import { getConfig } from '#utils/config'
import { describe, it, expect, beforeAll } from 'vitest'

import type { CreateSessionResponse, GetMessagesResponse, SendMessageResponse } from './types.js'

import { SessionService } from './service.js'

describe('SessionService', () => {
  let sessionService: SessionService
  let authToken: string
  
  beforeAll(async () => {
    // Get auth token for tests
    const config = getConfig()
    const secret = await getOrCreateSecretKey()
    authToken = await authGetToken(config.serverUrl, secret)
    
    // Create session service instance
    sessionService = new SessionService(config.serverUrl, authToken)
  })
  
  it('should create session, send message, and read message back', async () => {
    // 1. Create a session
    const tag = `test-session-${Date.now()}`
    const sessionResponse: CreateSessionResponse = await sessionService.createSession(tag)
    
    expect(sessionResponse).toBeTypeOf('object')
    expect(sessionResponse.session).toBeTypeOf('object')
    expect(sessionResponse.session.id).toBeTypeOf('string')
    expect(sessionResponse.session.tag).toBe(tag)
    expect(sessionResponse.session.seq).toBeTypeOf('number')
    expect(sessionResponse.session.createdAt).toBeTypeOf('number')
    expect(sessionResponse.session.updatedAt).toBeTypeOf('number')
    
    const sessionId = sessionResponse.session.id
    
    // 2. Send a message to the session
    const messageContent = {
      content: 'Hello, this is a test message from the session service test',
      type: 'text-input'
    }
    
    const sendResponse: SendMessageResponse = await sessionService.sendMessage(sessionId, messageContent)
    
    expect(sendResponse).toBeTypeOf('object')
    expect(sendResponse.message).toBeTypeOf('object')
    expect(sendResponse.message.id).toBeTypeOf('string')
    expect(sendResponse.message.seq).toBeTypeOf('number')
    expect(sendResponse.message.content).toBeTypeOf('object')
    expect(sendResponse.message.content.c).toBeTypeOf('string')
    expect(sendResponse.message.content.t).toBe('encrypted')
    expect(sendResponse.message.createdAt).toBeTypeOf('number')
    expect(sendResponse.message.updatedAt).toBeTypeOf('number')
    
    // 3. Read messages from the session
    const getResponse: GetMessagesResponse = await sessionService.getMessages(sessionId)
    
    expect(getResponse).toBeTypeOf('object')
    expect(Array.isArray(getResponse.messages)).toBe(true)
    expect(getResponse.messages.length).toBeGreaterThan(0)
    
    // Find our message (should be the first one since it's ordered by createdAt desc)
    const retrievedMessage = getResponse.messages[0]
    expect(retrievedMessage).toBeTypeOf('object')
    expect(retrievedMessage.id).toBe(sendResponse.message.id)
    expect(retrievedMessage.seq).toBe(sendResponse.message.seq)
    expect(retrievedMessage.content).toBeTypeOf('object')
    expect(retrievedMessage.content.c).toBe(sendResponse.message.content.c)
    expect(retrievedMessage.content.t).toBe('encrypted')
    
    // 4. Decrypt the retrieved message and verify it matches what we sent
    const decryptedContent = sessionService.decryptContent(retrievedMessage.content.c)
    expect(decryptedContent).toEqual(messageContent)
    
    console.log('✅ Complete workflow test passed:')
    console.log(`  - Created session: ${sessionId}`)
    console.log(`  - Sent message with seq: ${sendResponse.message.seq}`)
    console.log(`  - Retrieved ${getResponse.messages.length} messages`)
    console.log(`  - Decrypted content matches original: ${JSON.stringify(messageContent)}`)
  })
}) 