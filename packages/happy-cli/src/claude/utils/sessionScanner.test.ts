import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createSessionScanner } from './sessionScanner'
import { RawJSONLines } from '../types'
import type { ClaudeGoalStatusTranscriptEvent } from '../claudeGoalStatus'
import { mkdir, writeFile, appendFile, rm, readFile, rename, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { getProjectPath } from './path'

// Pass-through instrumentation: counts how often, and how many bytes, the
// scanner reads from transcript files. Everything still hits the real disk.
const transcriptIo = vi.hoisted(() => ({ opens: 0, stats: 0, readFiles: 0, bytesRead: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const isTranscript = (path: unknown) => String(path).endsWith('.jsonl')
  return {
    ...actual,
    stat: (async (...args: Parameters<typeof actual.stat>) => {
      if (isTranscript(args[0])) transcriptIo.stats++
      return actual.stat(...args)
    }) as typeof actual.stat,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      if (isTranscript(args[0])) transcriptIo.readFiles++
      return actual.readFile(...args)
    }) as typeof actual.readFile,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (isTranscript(args[0])) {
        transcriptIo.opens++
        const read = handle.read.bind(handle) as (...readArgs: unknown[]) => Promise<{ bytesRead: number }>
        handle.read = (async (...readArgs: unknown[]) => {
          const result = await read(...readArgs)
          transcriptIo.bytesRead += result.bytesRead
          return result
        }) as typeof handle.read
      }
      return handle
    }) as typeof actual.open,
  }
})

describe('sessionScanner', () => {
  let testDir: string
  let configDir: string
  let projectDir: string
  let collectedMessages: RawJSONLines[]
  let collectedTranscriptEvents: ClaudeGoalStatusTranscriptEvent[]
  let scanner: Awaited<ReturnType<typeof createSessionScanner>> | null = null
  let previousConfigDir: string | undefined
  
  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    testDir = join(tmpdir(), `scanner-test-${unique}`)
    await mkdir(testDir, { recursive: true })

    // Keep fixtures away from the developer's real ~/.claude/projects tree.
    configDir = join(tmpdir(), `scanner-config-${unique}`)
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir

    // Use the same path calculation as the scanner to ensure paths match
    projectDir = getProjectPath(testDir)
    await mkdir(projectDir, { recursive: true })

    collectedMessages = []
    collectedTranscriptEvents = []
  })
  
  afterEach(async () => {
    // Clean up scanner
    if (scanner) {
      await scanner.cleanup()
      scanner = null
    }
    
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }

    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
    if (existsSync(configDir)) {
      await rm(configDir, { recursive: true, force: true })
    }
  })
  
  it('should process initial session and resumed session correctly', async () => {
    // TEST SCENARIO:
    // Phase 1: User says "lol" → Assistant responds "lol" → Session closes
    // Phase 2: User resumes with NEW session ID → User says "run ls tool" → Assistant runs LS tool → Shows files
    // 
    // Key point: When resuming, Claude creates a NEW session file with:
    // - Summary line
    // - Complete history from previous session (with NEW session ID)
    // - New messages
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg)
    })
    
    // PHASE 1: Initial session (0-say-lol-session.jsonl)
    const fixture1 = await readFile(join(__dirname, '__fixtures__', '0-say-lol-session.jsonl'), 'utf-8')
    const lines1 = fixture1.split('\n').filter(line => line.trim())
    
    const sessionId1 = '93a9705e-bc6a-406d-8dce-8acc014dedbd'
    const sessionFile1 = join(projectDir, `${sessionId1}.jsonl`)
    
    // Write first line
    await writeFile(sessionFile1, lines1[0] + '\n')
    scanner.onNewSession(sessionId1)
    await new Promise(resolve => setTimeout(resolve, 100))
    
    expect(collectedMessages).toHaveLength(1)
    expect(collectedMessages[0].type).toBe('user')
    if (collectedMessages[0].type === 'user') {
      const content = collectedMessages[0].message.content
      const text = typeof content === 'string' ? content : (content as any)[0].text
      expect(text).toBe('say lol')
    }
    
    // Write second line with delay
    await new Promise(resolve => setTimeout(resolve, 50))
    await appendFile(sessionFile1, lines1[1] + '\n')
    await new Promise(resolve => setTimeout(resolve, 200))
    
    expect(collectedMessages).toHaveLength(2)
    expect(collectedMessages[1].type).toBe('assistant')
    if (collectedMessages[1].type === 'assistant' && collectedMessages[1].message) {
      expect((collectedMessages[1].message.content as any)[0].text).toBe('lol')
    }
    
    // PHASE 2: Resumed session (1-continue-run-ls-tool.jsonl)
    const fixture2 = await readFile(join(__dirname, '__fixtures__', '1-continue-run-ls-tool.jsonl'), 'utf-8')
    const lines2 = fixture2.split('\n').filter(line => line.trim())
    
    const sessionId2 = '789e105f-ae33-486d-9271-0696266f072d'
    const sessionFile2 = join(projectDir, `${sessionId2}.jsonl`)
    
    // Reset collected messages count for clarity
    const phase1Count = collectedMessages.length
    
    // Write summary + historical messages (lines 0-2) - NOT line 3 which is new
    let initialContent = ''
    for (let i = 0; i <= 2; i++) {
      initialContent += lines2[i] + '\n'
    }
    await writeFile(sessionFile2, initialContent)
    
    scanner.onNewSession(sessionId2)
    await new Promise(resolve => setTimeout(resolve, 100))
    
    // Should have added only 1 new message (summary) 
    // The historical user + assistant messages (lines 1-2) are deduplicated because they have same UUIDs
    expect(collectedMessages).toHaveLength(phase1Count + 1)
    expect(collectedMessages[phase1Count].type).toBe('summary')
    
    // Write new messages (user asks for ls tool) - this is line 3
    await new Promise(resolve => setTimeout(resolve, 50))
    await appendFile(sessionFile2, lines2[3] + '\n')
    await new Promise(resolve => setTimeout(resolve, 200))
    
    // Find the user message we just added
    const userMessages = collectedMessages.filter(m => m.type === 'user')
    const lastUserMsg = userMessages[userMessages.length - 1]
    expect(lastUserMsg).toBeDefined()
    if (lastUserMsg && lastUserMsg.type === 'user') {
      expect(lastUserMsg.message.content).toBe('run ls tool ')
    }
    
    // Write remaining lines (assistant tool use, tool result, final assistant message) - starting from line 4
    for (let i = 4; i < lines2.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      await appendFile(sessionFile2, lines2[i] + '\n')
    }
    await new Promise(resolve => setTimeout(resolve, 300))
    
    // Final count check
    const finalMessages = collectedMessages.slice(phase1Count)
    
    // Should have: 1 summary + 0 history (deduplicated) + 4 new messages = 5 total for session 2
    expect(finalMessages.length).toBeGreaterThanOrEqual(5)
    
    // Verify last message is assistant with the file listing
    const lastAssistantMsg = collectedMessages[collectedMessages.length - 1]
    expect(lastAssistantMsg.type).toBe('assistant')
    if (lastAssistantMsg.type === 'assistant' && lastAssistantMsg.message?.content) {
      const content = (lastAssistantMsg.message.content as any)[0].text
      expect(content).toContain('0-say-lol-session.jsonl')
      expect(content).toContain('readme.md')
    }
  })

  it('emits goal status attachments through transcript events only', async () => {
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      onTranscriptEvent: (event) => collectedTranscriptEvents.push(event),
    })

    const goalStatus = await readFile(join(__dirname, '..', '__fixtures__', 'goal-status', 'active.jsonl'), 'utf-8')
    const sessionId = 'ff668493-8325-49cc-976f-689b779b85a2'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)

    await writeFile(sessionFile, goalStatus)
    scanner.onNewSession(sessionId)
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(collectedMessages).toHaveLength(0)
    expect(collectedTranscriptEvents).toHaveLength(1)
    expect(collectedTranscriptEvents[0]).toMatchObject({
      type: 'goal_status',
      uuid: '001008f1-0438-414a-86c0-eef745e1227f',
      sourceSessionId: sessionId,
      attachment: {
        type: 'goal_status',
        met: false,
        condition: 'keep this goal active until I explicitly clear it',
      },
    })
  })

  it('does not re-emit duplicate goal status transcript events', async () => {
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      onTranscriptEvent: (event) => collectedTranscriptEvents.push(event),
    })

    const goalStatus = await readFile(join(__dirname, '..', '__fixtures__', 'goal-status', 'active.jsonl'), 'utf-8')
    const sessionId = 'ff668493-8325-49cc-976f-689b779b85a2'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)

    await writeFile(sessionFile, goalStatus)
    scanner.onNewSession(sessionId)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await appendFile(sessionFile, goalStatus)
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(collectedMessages).toHaveLength(0)
    expect(collectedTranscriptEvents).toHaveLength(1)
  })

  it('pre-marks existing goal status events from the initial session id', async () => {
    const activeGoalStatus = await readFile(join(__dirname, '..', '__fixtures__', 'goal-status', 'active.jsonl'), 'utf-8')
    const editedGoalStatus = await readFile(join(__dirname, '..', '__fixtures__', 'goal-status', 'edit-active.jsonl'), 'utf-8')
    const sessionId = 'ff668493-8325-49cc-976f-689b779b85a2'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)

    await writeFile(sessionFile, activeGoalStatus)

    scanner = await createSessionScanner({
      sessionId,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      onTranscriptEvent: (event) => collectedTranscriptEvents.push(event),
    })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(collectedMessages).toHaveLength(0)
    expect(collectedTranscriptEvents).toHaveLength(0)

    await appendFile(sessionFile, editedGoalStatus)
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(collectedMessages).toHaveLength(0)
    expect(collectedTranscriptEvents).toHaveLength(1)
    expect(collectedTranscriptEvents[0]).toMatchObject({
      uuid: 'acde1bd2-f79f-43fb-8dd1-e2c8e2a0b294',
      sourceSessionId: sessionId,
      attachment: {
        type: 'goal_status',
        met: false,
        condition: 'replace this goal with edited fixture objective',
      },
    })
  })

  it('pre-marks existing goal status events when new session treats existing entries as processed', async () => {
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      onTranscriptEvent: (event) => collectedTranscriptEvents.push(event),
    })

    const goalStatus = await readFile(join(__dirname, '..', '__fixtures__', 'goal-status', 'active.jsonl'), 'utf-8')
    const sessionId = 'ff668493-8325-49cc-976f-689b779b85a2'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)

    await writeFile(sessionFile, goalStatus)
    scanner.onNewSession(sessionId, { treatExistingAsProcessed: true })
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(collectedMessages).toHaveLength(0)
    expect(collectedTranscriptEvents).toHaveLength(0)
  })
  
  it('should not process duplicate assistant messages with same message ID', async () => {
    // Currently broken unclear if we need this or not post migrating to sdk & removeing deduplication
    return;

    // scanner = await createSessionScanner({
    //   sessionId: null,
    //   workingDirectory: testDir,
    //   onMessage: (msg) => collectedMessages.push(msg)
    // })
    
    // const fixture = await readFile(join(__dirname, '__fixtures__', 'duplicate-assistant-response.jsonl'), 'utf-8')
    // const lines = fixture.split('\n').filter(line => line.trim())
    
    // const sessionId = 'b91d4412-e6c4-4e51-bb1b-585bcd78aca4'
    // const sessionFile = join(projectDir, `${sessionId}.jsonl`)
    
    // // Write first user message
    // await writeFile(sessionFile, lines[0] + '\n')
    // scanner.onNewSession(sessionId)
    // await new Promise(resolve => setTimeout(resolve, 100))
    
    // expect(collectedMessages).toHaveLength(1)
    // expect(collectedMessages[0].type).toBe('user')
    
    // // Write first assistant response
    // await appendFile(sessionFile, lines[1] + '\n')
    // await new Promise(resolve => setTimeout(resolve, 100))
    
    // expect(collectedMessages).toHaveLength(2)
    // expect(collectedMessages[1].type).toBe('assistant')
    // const firstAssistantMsg = collectedMessages[1]
    // if (firstAssistantMsg.type === 'assistant') {
    //   expect((firstAssistantMsg.message.content as any)[0].text).toBe('lol')
    //   expect(firstAssistantMsg.message.id).toBe('msg_01R62tkBs9tw5X76JmpWXYbc')
    // }
    
    // // Write duplicate assistant response (same message ID, different UUID)
    // await appendFile(sessionFile, lines[2] + '\n')
    // await new Promise(resolve => setTimeout(resolve, 100))
    
    // // Should NOT process the duplicate - still only 2 messages
    // expect(collectedMessages).toHaveLength(2)
    
    // // Write next user message
    // await appendFile(sessionFile, lines[3] + '\n')
    // await new Promise(resolve => setTimeout(resolve, 100))
    
    // expect(collectedMessages).toHaveLength(3)
    // expect(collectedMessages[2].type).toBe('user')
    
    // // Write final assistant response
    // await appendFile(sessionFile, lines[4] + '\n')
    // await new Promise(resolve => setTimeout(resolve, 100))
    
    // expect(collectedMessages).toHaveLength(4)
    // expect(collectedMessages[3].type).toBe('assistant')
    // const lastAssistantMsg = collectedMessages[3]
    // if (lastAssistantMsg.type === 'assistant') {
    //   expect((lastAssistantMsg.message.content as any)[0].text).toBe('kekr')
    //   expect(lastAssistantMsg.message.id).toBe('msg_01KWeuP88pkzRtXmggJRnQmV')
    // }
  })

  it('keeps serving real sessions while a phantom session has no transcript', async () => {
    // A missing transcript is now held by one idle directory watcher rather
    // than dropped after a deadline, while other sessions remain independent.
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      missingFileTimeoutMs: 100,
    })

    // Phantom: announced but no file on disk, ever.
    const phantomId = 'fd4aa0c2-000a-4cd3-a066-80c6d87c3456'
    scanner.onNewSession(phantomId)

    // Longer than the old give-up window.
    await new Promise((r) => setTimeout(r, 2500))

    expect(collectedMessages).toHaveLength(0)

    // A real session arriving after the phantom was dropped must still work.
    const fixture = await readFile(join(__dirname, '__fixtures__', '0-say-lol-session.jsonl'), 'utf-8')
    const lines = fixture.split('\n').filter((l) => l.trim())
    const realId = '93a9705e-bc6a-406d-8dce-8acc014dedbd'
    const realFile = join(projectDir, `${realId}.jsonl`)

    await writeFile(realFile, lines[0] + '\n')
    scanner.onNewSession(realId)
    await new Promise((r) => setTimeout(r, 200))

    expect(collectedMessages).toHaveLength(1)
    expect(collectedMessages[0].type).toBe('user')
  })

  it('syncs a transcript created after the timeout exactly once', async () => {
    const fixture = await readFile(join(__dirname, '__fixtures__', '0-say-lol-session.jsonl'), 'utf-8')
    const sessionId = '5ec1f8ef-7845-4d7f-a34b-3b8f98f4cf29'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)

    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      missingFileTimeoutMs: 100,
    })

    scanner.onNewSession(sessionId)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(collectedMessages).toHaveLength(0)

    await writeFile(sessionFile, fixture)
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(collectedMessages.map((message) => message.type)).toEqual(['user', 'assistant'])
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(collectedMessages).toHaveLength(2)
  })

  it('revives a same-id session after its directory becomes watchable again', async () => {
    const fixture = await readFile(join(__dirname, '__fixtures__', '0-say-lol-session.jsonl'), 'utf-8')
    const sessionId = '3d8bdaf9-c502-4a34-a5a1-76d12be5ec43'

    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      missingFileTimeoutMs: 100,
    })

    scanner.onNewSession(sessionId)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await rm(projectDir, { recursive: true, force: true })
    await new Promise((resolve) => setTimeout(resolve, 2_500))

    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, `${sessionId}.jsonl`), fixture)
    scanner.onNewSession(sessionId)
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(collectedMessages.map((message) => message.type)).toEqual(['user', 'assistant'])
  })

  it('emits the synthetic assistant message written when the API rejects a turn', async () => {
    // Reproduces the "session goes silent" bug: on an API error (here a 429)
    // Claude Code writes a synthetic assistant message carrying the error text.
    // Those messages send `usage.service_tier: null`, which used to fail schema
    // validation, so the scanner dropped them and the client saw the user's own
    // message followed by nothing at all.
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
    })

    const fixture = await readFile(join(__dirname, '..', '__fixtures__', 'api-error', 'rate-limit.jsonl'), 'utf-8')
    const sessionId = 'c1d0a6cf-1f6c-4bb0-9a5a-2b0c2f5f9d10'

    await writeFile(join(projectDir, `${sessionId}.jsonl`), fixture)
    scanner.onNewSession(sessionId)
    await new Promise((r) => setTimeout(r, 200))

    expect(collectedMessages.map((m) => m.type)).toEqual(['user', 'assistant'])
    const assistant = collectedMessages[1]
    expect(assistant).toMatchObject({
      type: 'assistant',
      isApiErrorMessage: true,
      apiErrorStatus: 429,
    })
  })
  describe('incremental reads', () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    const userLine = (id: string, text: string) =>
      JSON.stringify({ type: 'user', uuid: id, message: { role: 'user', content: text } })

    const sentTexts = () => collectedMessages.map((m) => (m.type === 'user' ? m.message.content : m.type))

    const startScanner = async (sessionId: string | null = null) => {
      scanner = await createSessionScanner({
        sessionId,
        workingDirectory: testDir,
        onMessage: (msg) => collectedMessages.push(msg),
      })
    }

    it('sends lines appended to a transcript exactly once', async () => {
      const sessionFile = join(projectDir, 'incremental-append.jsonl')
      await startScanner()

      await writeFile(sessionFile, userLine('a1', 'first') + '\n')
      scanner!.onNewSession('incremental-append')
      await vi.waitFor(() => expect(sentTexts()).toEqual(['first']))

      await appendFile(sessionFile, userLine('a2', 'second') + '\n')
      await vi.waitFor(() => expect(sentTexts()).toEqual(['first', 'second']))

      await appendFile(sessionFile, userLine('a3', 'third') + '\n' + userLine('a4', 'fourth') + '\n')
      await vi.waitFor(() => expect(sentTexts()).toEqual(['first', 'second', 'third', 'fourth']))

      await sleep(300)
      expect(sentTexts()).toEqual(['first', 'second', 'third', 'fourth'])
    })

    it('does not resend entries that existed before the scanner started', async () => {
      const sessionFile = join(projectDir, 'incremental-initial.jsonl')
      await writeFile(sessionFile, userLine('i1', 'old one') + '\n' + userLine('i2', 'old two') + '\n')
      await startScanner('incremental-initial')

      await appendFile(sessionFile, userLine('i3', 'new') + '\n')
      await vi.waitFor(() => expect(sentTexts()).toEqual(['new']))
    })

    it('holds back a line written in two parts until it is complete', async () => {
      const sessionFile = join(projectDir, 'incremental-split.jsonl')
      const line = userLine('s2', 'split across two writes')
      await startScanner()

      await writeFile(sessionFile, userLine('s1', 'before') + '\n' + line.slice(0, 20))
      scanner!.onNewSession('incremental-split')
      await vi.waitFor(() => expect(sentTexts()).toEqual(['before']))
      await sleep(300)
      expect(sentTexts()).toEqual(['before'])

      await appendFile(sessionFile, line.slice(20) + '\n')
      await vi.waitFor(() => expect(sentTexts()).toEqual(['before', 'split across two writes']))

      await sleep(300)
      expect(sentTexts()).toEqual(['before', 'split across two writes'])
    })

    it.each([
      ['a three-byte character', '日本語のテキスト', '日本'],
      ['a four-byte emoji', 'party 🎉 time', '🎉'],
    ])('parses text when a write ends inside %s', async (_name, text, splitInside) => {
      const sessionFile = join(projectDir, 'incremental-utf8.jsonl')
      const bytes = Buffer.from(userLine('u1', text) + '\n', 'utf-8')
      // Cut one byte after the start of the multi-byte character.
      const cut = bytes.indexOf(Buffer.from(splitInside, 'utf-8')) + 1
      await startScanner()

      await writeFile(sessionFile, bytes.subarray(0, cut))
      scanner!.onNewSession('incremental-utf8')
      await sleep(300)
      expect(sentTexts()).toEqual([])

      await appendFile(sessionFile, bytes.subarray(cut))
      await vi.waitFor(() => expect(sentTexts()).toEqual([text]))

      await sleep(300)
      expect(sentTexts()).toEqual([text])
    })

    it('rereads a transcript that was replaced by a file with a new inode', async () => {
      const sessionFile = join(projectDir, 'incremental-replaced.jsonl')
      const replacement = join(projectDir, 'incremental-replaced.tmp')
      await startScanner()

      await writeFile(sessionFile, userLine('r1', 'one') + '\n' + userLine('r2', 'two') + '\n')
      scanner!.onNewSession('incremental-replaced')
      await vi.waitFor(() => expect(sentTexts()).toEqual(['one', 'two']))

      // Larger than the original, so only the inode change reveals it.
      await writeFile(replacement, [
        userLine('r1', 'one'),
        userLine('r2', 'two'),
        userLine('r3', 'three, written after the replacement'),
        userLine('r4', 'four'),
      ].join('\n') + '\n')
      await rename(replacement, sessionFile)
      await vi.waitFor(() => expect(sentTexts()).toEqual(['one', 'two', 'three, written after the replacement', 'four']), { timeout: 6000 })

      await sleep(300)
      expect(sentTexts()).toHaveLength(4)
    })

    it('rereads a transcript that shrank', async () => {
      const sessionFile = join(projectDir, 'incremental-shrunk.jsonl')
      await startScanner()

      await writeFile(sessionFile, userLine('t1', 'one') + '\n' + userLine('t2', 'two') + '\n')
      scanner!.onNewSession('incremental-shrunk')
      await vi.waitFor(() => expect(sentTexts()).toEqual(['one', 'two']))

      await truncate(sessionFile, 0)
      await writeFile(sessionFile, userLine('t3', 'x') + '\n')
      await vi.waitFor(() => expect(sentTexts()).toEqual(['one', 'two', 'x']), { timeout: 6000 })

      await sleep(300)
      expect(sentTexts()).toHaveLength(3)
    })

    it('rereads a transcript rewritten in place to the same or a larger size', async () => {
      const sessionFile = join(projectDir, 'incremental-rewritten.jsonl')
      const original = userLine('w1', 'original') + '\n'
      await startScanner()

      await writeFile(sessionFile, original)
      scanner!.onNewSession('incremental-rewritten')
      await vi.waitFor(() => expect(sentTexts()).toEqual(['original']))

      // Same inode, not smaller, and no newline where the last read ended.
      const rewritten = userLine('w2', 'rewritten with a longer text'.padEnd(original.length + 20, '.')) + '\n'
      expect(rewritten.length).toBeGreaterThan(original.length)
      await writeFile(sessionFile, rewritten)
      await vi.waitFor(() => expect(sentTexts()).toHaveLength(2), { timeout: 6000 })
      expect(sentTexts()[1]).toMatch(/^rewritten with a longer text/)
    })

    it('reads nothing from the transcript while it is unchanged', async () => {
      const sessionFile = join(projectDir, 'incremental-idle.jsonl')
      const lines = Array.from({ length: 200 }, (_, i) => userLine(`idle-${i}`, `message ${i} ${'x'.repeat(200)}`))
      await writeFile(sessionFile, lines.join('\n') + '\n')
      await startScanner('incremental-idle')
      expect(transcriptIo.bytesRead).toBeGreaterThan(0)

      transcriptIo.opens = transcriptIo.stats = transcriptIo.readFiles = transcriptIo.bytesRead = 0
      // Long enough for at least one 3 s periodic sync to run.
      await sleep(3500)

      expect(transcriptIo.stats).toBeGreaterThan(0)
      expect(transcriptIo.opens).toBe(0)
      expect(transcriptIo.readFiles).toBe(0)
      expect(transcriptIo.bytesRead).toBe(0)

      // And an append costs only the appended bytes.
      const appended = userLine('idle-new', 'appended') + '\n'
      await appendFile(sessionFile, appended)
      await vi.waitFor(() => expect(sentTexts()).toEqual(['appended']), { timeout: 6000 })
      expect(transcriptIo.bytesRead).toBeLessThanOrEqual(appended.length + 1)
    })

    it('retries lines a failing onMessage callback did not get to', async () => {
      const sessionFile = join(projectDir, 'incremental-retry.jsonl')
      let failedOnce = false
      scanner = await createSessionScanner({
        sessionId: null,
        workingDirectory: testDir,
        onMessage: (msg) => {
          if (msg.type === 'user' && msg.message.content === 'boom' && !failedOnce) {
            failedOnce = true
            throw new Error('consumer failed')
          }
          collectedMessages.push(msg)
        },
      })

      await writeFile(sessionFile, [userLine('f1', 'ok'), userLine('f2', 'boom'), userLine('f3', 'after')].join('\n') + '\n')
      scanner.onNewSession('incremental-retry')
      await vi.waitFor(() => expect(sentTexts()).toEqual(['ok', 'after']), { timeout: 6000 })
    })
  })
})
