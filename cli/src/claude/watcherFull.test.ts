import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { watchSessionFileFull } from './watcherFull'
import { RawJSONLines } from './types'
import { mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'

describe('watcherFull', () => {
  let testDir: string
  let testFile: string
  
  beforeEach(async () => {
    // Create a temporary directory for testing
    testDir = join(tmpdir(), `watcher-test-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
    testFile = join(testDir, 'test-session.jsonl')
  })
  
  afterEach(async () => {
    // Clean up
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
  })
  
  it('should yield all messages from a simple session', async () => {
    // Write initial session data
    const sessionData = `{"cwd":"/test","sessionId":"test-123","version":"1.0.51","type":"user","message":{"role":"user","content":"say hello"},"uuid":"uuid-1","timestamp":"2025-01-01T00:00:00.000Z"}
{"cwd":"/test","sessionId":"test-123","version":"1.0.51","message":{"id":"msg_001","type":"message","role":"assistant","model":"claude-3","content":[{"type":"text","text":"hello"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":5}},"requestId":"req_001","type":"assistant","uuid":"uuid-2","timestamp":"2025-01-01T00:00:01.000Z"}`
    
    await writeFile(testFile, sessionData)
    
    const abortController = new AbortController()
    const messages: RawJSONLines[] = []
    
    try {
      for await (const msg of watchSessionFileFull({ 
        sessionFile: testFile, 
        abortController, 
        seenSessionMessages: [] 
      })) {
        messages.push(msg)
        if (messages.length === 2) {
          abortController.abort()
          break
        }
      }
    } catch (err: any) {
      // Ignore abort error
      if (err.name !== 'AbortError') throw err
    }
    expect(messages).toHaveLength(2)
    expect(messages[0].type).toBe('user')
    if (messages[0].type === 'user') {
      expect(messages[0].message.content).toBe('say hello')
    }
    expect(messages[1].type).toBe('assistant')
    if (messages[1].type === 'assistant') {
      expect((messages[1].message.content as any)[0].text).toBe('hello')
    }
  })
  
  it('should not yield duplicate messages when file is appended', async () => {
    // Write initial message
    const firstMessage = `{"cwd":"/test","sessionId":"test-123","version":"1.0.51","type":"user","message":{"role":"user","content":"first"},"uuid":"uuid-1","timestamp":"2025-01-01T00:00:00.000Z"}
`
    await writeFile(testFile, firstMessage)
    
    const abortController = new AbortController()
    const messages: RawJSONLines[] = []
    
    // Start watching
    const watchPromise = (async () => {
      for await (const msg of watchSessionFileFull({ 
        sessionFile: testFile, 
        abortController, 
        seenSessionMessages: [] 
      })) {
        messages.push(msg)
      }
    })()
    
    // Wait a bit for initial read
    await new Promise(resolve => setTimeout(resolve, 100))
    
    // Append second message
    const secondMessage = `{"cwd":"/test","sessionId":"test-123","version":"1.0.51","message":{"id":"msg_001","type":"message","role":"assistant","model":"claude-3","content":[{"type":"text","text":"response"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":5}},"requestId":"req_001","type":"assistant","uuid":"uuid-2","timestamp":"2025-01-01T00:00:01.000Z"}
`
    await appendFile(testFile, secondMessage)
    
    // Wait for change to be detected
    await new Promise(resolve => setTimeout(resolve, 200))
    
    abortController.abort()
    await watchPromise.catch(() => {}) // Ignore abort error
    
    expect(messages).toHaveLength(2)
    if (messages[0].type === 'user') {
      expect(messages[0].message.content).toBe('first')
    }
    if (messages[1].type === 'assistant') {
      expect((messages[1].message.content as any)[0].text).toBe('response')
    }
  })
  
  it('should handle resumed session with duplicates correctly', async () => {
    // Simulate a resumed session where messages are duplicated
    const sessionData = `{"cwd":"/test","sessionId":"test-123","version":"1.0.51","type":"user","message":{"role":"user","content":"first message"},"uuid":"uuid-1","timestamp":"2025-01-01T00:00:00.000Z"}
{"cwd":"/test","sessionId":"test-123","version":"1.0.51","message":{"id":"msg_001","type":"message","role":"assistant","model":"claude-3","content":[{"type":"text","text":"first response"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":5}},"requestId":"req_001","type":"assistant","uuid":"uuid-2","timestamp":"2025-01-01T00:00:01.000Z"}
{"cwd":"/test","sessionId":"test-123","version":"1.0.51","type":"user","message":{"role":"user","content":"first message"},"uuid":"uuid-3","timestamp":"2025-01-01T00:00:00.000Z"}
{"cwd":"/test","sessionId":"test-123","version":"1.0.51","message":{"id":"msg_001","type":"message","role":"assistant","model":"claude-3","content":[{"type":"text","text":"first response"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":5}},"requestId":"req_002","type":"assistant","uuid":"uuid-4","timestamp":"2025-01-01T00:00:02.000Z"}
{"cwd":"/test","sessionId":"test-123","version":"1.0.51","type":"user","message":{"role":"user","content":"second message"},"uuid":"uuid-5","timestamp":"2025-01-01T00:00:03.000Z"}
{"cwd":"/test","sessionId":"test-123","version":"1.0.51","message":{"id":"msg_002","type":"message","role":"assistant","model":"claude-3","content":[{"type":"text","text":"second response"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":5}},"requestId":"req_003","type":"assistant","uuid":"uuid-6","timestamp":"2025-01-01T00:00:04.000Z"}`
    
    await writeFile(testFile, sessionData)
    
    const abortController = new AbortController()
    const messages: RawJSONLines[] = []
    
    // Collect messages with a timeout
    const watchPromise = (async () => {
      for await (const msg of watchSessionFileFull({ 
        sessionFile: testFile, 
        abortController, 
        seenSessionMessages: [] 
      })) {
        messages.push(msg)
      }
    })()
    
    // Give it time to read all messages
    await new Promise(resolve => setTimeout(resolve, 100))
    abortController.abort()
    
    try {
      await watchPromise
    } catch (err: any) {
      if (err.name !== 'AbortError') throw err
    }
    
    
    // Should get 4 unique messages (2 user, 2 assistant)
    expect(messages).toHaveLength(4)
    
    // Check content
    const userMessages = messages.filter(m => m.type === 'user')
    const assistantMessages = messages.filter(m => m.type === 'assistant')
    
    expect(userMessages).toHaveLength(2)
    if (userMessages[0].type === 'user' && userMessages[1].type === 'user') {
      expect(userMessages[0].message.content).toBe('first message')
      expect(userMessages[1].message.content).toBe('second message')
    }
    
    expect(assistantMessages).toHaveLength(2)
    if (assistantMessages[0].type === 'assistant' && assistantMessages[1].type === 'assistant') {
      expect(assistantMessages[0].message.id).toBe('msg_001')
      expect(assistantMessages[1].message.id).toBe('msg_002')
    }
  })
  
  it('should respect seenSessionMessages and only yield new messages', async () => {
    // Full session data
    const sessionData = `{"cwd":"/test","sessionId":"test-123","version":"1.0.51","type":"user","message":{"role":"user","content":"first"},"uuid":"uuid-1","timestamp":"2025-01-01T00:00:00.000Z"}
{"cwd":"/test","sessionId":"test-123","version":"1.0.51","message":{"id":"msg_001","type":"message","role":"assistant","model":"claude-3","content":[{"type":"text","text":"response1"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":5}},"requestId":"req_001","type":"assistant","uuid":"uuid-2","timestamp":"2025-01-01T00:00:01.000Z"}
{"cwd":"/test","sessionId":"test-123","version":"1.0.51","type":"user","message":{"role":"user","content":"second"},"uuid":"uuid-3","timestamp":"2025-01-01T00:00:02.000Z"}
{"cwd":"/test","sessionId":"test-123","version":"1.0.51","message":{"id":"msg_002","type":"message","role":"assistant","model":"claude-3","content":[{"type":"text","text":"response2"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":5}},"requestId":"req_002","type":"assistant","uuid":"uuid-4","timestamp":"2025-01-01T00:00:03.000Z"}`
    
    await writeFile(testFile, sessionData)
    
    // Create seen messages with first 2 messages
    const seenMessages: RawJSONLines[] = [
      {
        cwd: "/test",
        sessionId: "test-123",
        version: "1.0.51",
        type: "user",
        message: { role: "user", content: "first" },
        uuid: "uuid-1",
        timestamp: "2025-01-01T00:00:00.000Z"
      },
      {
        cwd: "/test",
        sessionId: "test-123",
        version: "1.0.51",
        message: {
          id: "msg_001",
          type: "message",
          role: "assistant",
          model: "claude-3",
          content: [{ type: "text", text: "response1" }],
          stop_reason: null,
          stop_sequence: null,
          usage: {"input_tokens":10,"output_tokens":5}
        } as any,
        requestId: "req_001",
        type: "assistant",
        uuid: "uuid-2",
        timestamp: "2025-01-01T00:00:01.000Z"
      }
    ]
    
    const abortController = new AbortController()
    const messages: RawJSONLines[] = []
    
    try {
      for await (const msg of watchSessionFileFull({ 
        sessionFile: testFile, 
        abortController, 
        seenSessionMessages: seenMessages 
      })) {
        messages.push(msg)
        if (messages.length === 2) {
          abortController.abort()
          break
        }
      }
    } catch (err: any) {
      // Ignore abort error
      if (err.name !== 'AbortError') throw err
    }
    
    // Should only get the last 2 messages
    expect(messages).toHaveLength(2)
    if (messages[0].type === 'user') {
      expect(messages[0].message.content).toBe('second')
    }
    if (messages[1].type === 'assistant') {
      expect((messages[1].message.content as any)[0].text).toBe('response2')
    }
  })
})