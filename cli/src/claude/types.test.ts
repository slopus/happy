import { describe, it, expect } from 'vitest'
import { parseClaudePersistedMessage, parseClaudeSdkMessage } from './types'

describe('Claude message type extraction', () => {
  describe('extractInteractiveMessageInfo', () => {
    it('extracts sessionId from camelCase format', () => {
      const message = {
        sessionId: 'test-session-123',
        type: 'user',
        content: 'hello'
      }
      
      const info = parseClaudePersistedMessage(message)
      expect(info).toBeDefined()
      expect(info?.sessionId).toBe('test-session-123')
      expect(info?.type).toBe('user')
      expect(info?.rawMessage).toEqual(message)
    })
    
    it('returns undefined for invalid message', () => {
      const message = {
        // Missing required sessionId
        type: 'user'
      }
      
      const info = parseClaudePersistedMessage(message)
      expect(info).toBeUndefined()
    })
  })
  
  describe('extractSDKMessageInfo', () => {
    it('extracts session_id from snake_case format', () => {
      const message = {
        session_id: 'sdk-session-456',
        type: 'assistant',
        subtype: 'init'
      }
      
      const info = parseClaudeSdkMessage(message)
      expect(info).toBeDefined()
      expect(info?.sessionId).toBe('sdk-session-456')
      expect(info?.type).toBe('assistant')
      expect(info?.rawMessage).toEqual(message)
    })
    
    it('handles optional session_id', () => {
      const message = {
        type: 'result',
        subtype: 'success'
      }
      
      const info = parseClaudeSdkMessage(message)
      expect(info).toBeDefined()
      expect(info?.sessionId).toBeUndefined()
      expect(info?.type).toBe('result')
    })
  })
})