/**
 * Tests for the session service module
 * 
 * This test verifies the complete session workflow: create session, send message, read message
 * using the real handy server API. No mocking is used as per project requirements.
 */

import { authGetToken, getOrCreateSecretKey } from '#auth/auth'
import { getConfig } from '#utils/config'
import { expect } from 'chai'

import type { CreateSessionResponse, GetMessagesResponse, SendMessageResponse } from './types.js'

import { SessionService } from './service.js'

describe('SessionService', () => {
  let sessionService: SessionService
  let authToken: string
  
  before(async () => {
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
    
    expect(sessionResponse).to.be.an('object')
    expect(sessionResponse.session).to.be.an('object')
    expect(sessionResponse.session.id).to.be.a('string')
    expect(sessionResponse.session.tag).to.equal(tag)
    expect(sessionResponse.session.seq).to.be.a('number')
    expect(sessionResponse.session.createdAt).to.be.a('number')
    expect(sessionResponse.session.updatedAt).to.be.a('number')
    
    const sessionId = sessionResponse.session.id
    
    // 2. Send a message to the session
    const messageContent = {
      content: 'Hello, this is a test message from the session service test',
      type: 'text-input'
    }
    
    const sendResponse: SendMessageResponse = await sessionService.sendMessage(sessionId, messageContent)
    
    expect(sendResponse).to.be.an('object')
    expect(sendResponse.message).to.be.an('object')
    expect(sendResponse.message.id).to.be.a('string')
    expect(sendResponse.message.seq).to.be.a('number')
    expect(sendResponse.message.content).to.be.an('object')
    expect(sendResponse.message.content.c).to.be.a('string')
    expect(sendResponse.message.content.t).to.equal('encrypted')
    expect(sendResponse.message.createdAt).to.be.a('number')
    expect(sendResponse.message.updatedAt).to.be.a('number')
    
    // 3. Read messages from the session
    const getResponse: GetMessagesResponse = await sessionService.getMessages(sessionId)
    
    expect(getResponse).to.be.an('object')
    expect(getResponse.messages).to.be.an('array')
    expect(getResponse.messages.length).to.be.greaterThan(0)
    
    // Find our message (should be the first one since it's ordered by createdAt desc)
    const retrievedMessage = getResponse.messages[0]
    expect(retrievedMessage).to.be.an('object')
    expect(retrievedMessage.id).to.equal(sendResponse.message.id)
    expect(retrievedMessage.seq).to.equal(sendResponse.message.seq)
    expect(retrievedMessage.content).to.be.an('object')
    expect(retrievedMessage.content.c).to.equal(sendResponse.message.content.c)
    expect(retrievedMessage.content.t).to.equal('encrypted')
    
    // 4. Decrypt the retrieved message and verify it matches what we sent
    const decryptedContent = sessionService.decryptContent(retrievedMessage.content.c)
    expect(decryptedContent).to.deep.equal(messageContent)
    
    console.log('✅ Complete workflow test passed:')
    console.log(`  - Created session: ${sessionId}`)
    console.log(`  - Sent message with seq: ${sendResponse.message.seq}`)
    console.log(`  - Retrieved ${getResponse.messages.length} messages`)
    console.log(`  - Decrypted content matches original: ${JSON.stringify(messageContent)}`)
  })
}) 