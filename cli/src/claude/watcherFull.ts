/**
 * Full file watcher for Claude session files
 * 
 * Unlike the position-based watcher, this reads the entire file each time
 * and uses message deduplication to avoid sending duplicates.
 * 
 * This approach is more reliable for handling session resume scenarios
 * where Claude duplicates the conversation history.
 */

import { watch, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { logger } from '@/ui/logger'

import { RawJSONLines, RawJSONLinesSchema } from './types'
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'

interface FileWatcherOptions {
  sessionFile: string
  abortController: AbortController
  seenSessionMessages?: RawJSONLines[]
}

export async function* watchMostRecentSessionFull(
  workingDirectory: string,
  watchForSessionId: string,
  abortController: AbortController,
  seenSessionMessages: RawJSONLines[] = []
): AsyncGenerator<RawJSONLines> {
  const projectName = resolve(workingDirectory).replace(/\//g, '-')
  const projectDir = join(homedir(), '.claude', 'projects', projectName)
  const expectedSessionFile = join(projectDir, `${watchForSessionId}.jsonl`)
  
  logger.debug(`[WATCHER_FULL] Starting session watcher for project: ${projectDir}`)
  logger.debug(`[WATCHER_FULL] Watching for session: ${watchForSessionId}`)
  logger.debug(`[WATCHER_FULL] Last known state has ${seenSessionMessages.length} messages`)
  
  if (!existsSync(projectDir)) {
    logger.debug('[WATCHER_FULL] Project directory does not exist, creating it')
    await mkdir(projectDir, { recursive: true })
  }

  // Check if the session file already exists
  if (existsSync(expectedSessionFile)) {
    logger.debug(`[WATCHER_FULL] Session file already exists, starting watch: ${expectedSessionFile}`)
    yield* watchSessionFileFull({
    sessionFile: expectedSessionFile,
    abortController,
    seenSessionMessages
  })
    return
  }
  
  // Watch for new session files
  logger.debug('[WATCHER_FULL] Starting directory watcher for new session files')
  const dirWatcher = watch(projectDir, { signal: abortController.signal })

  // Wait for our session file to be created
  await (async (): Promise<void> => {
    logger.debug('[WATCHER_FULL] Entering directory watcher loop')
    try {
      for await (const event of dirWatcher) {
        logger.debug(`[WATCHER_FULL] Directory watcher event: ${event.eventType} - ${event.filename}`)
        if (event.eventType === 'rename' && event.filename === `${watchForSessionId}.jsonl`) {
          logger.debug(`[WATCHER_FULL] Matching session file created, will start watching`)
          return
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        logger.debug('[WATCHER_FULL] Directory watcher unexpected error:', err)
      }
      logger.debug('[WATCHER_FULL] Directory watcher aborted')
    }
  })()

  // We aborted early
  if (abortController.signal.aborted) {
    logger.debug('[WATCHER_FULL] Aborted before session file was created')
    return
  }

  yield* watchSessionFileFull({
    sessionFile: expectedSessionFile,
    abortController,
    seenSessionMessages
  })
}

export async function* watchSessionFileFull({
  sessionFile,
  abortController,
  seenSessionMessages = []
}: FileWatcherOptions): AsyncGenerator<RawJSONLines> {
  logger.debug(`[WATCHER_FULL] Watching claude session file: ${sessionFile}`)
  
  // Keep track of all messages we've seen
  const seenMessages = new Set<string>()
  
  // Initialize with last known messages
  for (const msg of seenSessionMessages) {
    const key = getMessageKey(msg)
    seenMessages.add(key)
  }
  
  // Read file and yield new messages
  const readFileAndYieldNew = async function*(): AsyncGenerator<RawJSONLines> {
    const handle = await open(sessionFile, 'r')
    const stream = handle.createReadStream()
    const rl = createInterface({ input: stream })
    
    const newMessages: RawJSONLines[] = []
    
    for await (const line of rl) {
      if (!line.trim()) continue
      
      try {
        const rawJsonMessage = JSON.parse(line)
        const messageParsed = RawJSONLinesSchema.safeParse(rawJsonMessage)
        
        if (!messageParsed.success) {
          logger.debug('[WATCHER_FULL] Skipping invalid JSON line', messageParsed.error.errors)
          continue
        }
        
        const message = messageParsed.data
        const key = getMessageKey(message)
        
        if (!seenMessages.has(key)) {
          seenMessages.add(key)
          newMessages.push(message)
        }
      } catch (err: any) {
        logger.debug('[WATCHER_FULL] Error parsing JSON line:', err)
      }
    }
    
    rl.close()
    await handle.close()
    
    // Yield all new messages
    for (const msg of newMessages) {
      logger.debug(`[WATCHER_FULL] Yielding new message: ${msg.type}`)
      logger.debugLargeJson('[WATCHER_FULL] Message details:', msg)
      yield msg
    }
  }
  
  // Initial read
  logger.debug('[WATCHER_FULL] Performing initial file read')
  yield* readFileAndYieldNew()
  
  try {
     // Watch for changes
    const fileWatcher = watch(sessionFile, { signal: abortController.signal })
    for await (const event of fileWatcher) {
      if (event.eventType === 'change') {
        logger.debug('[WATCHER_FULL] File changed, reading for new messages')
        yield* readFileAndYieldNew()
      }
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      logger.debug('[WATCHER_FULL] File watcher error:', err)
    }
    logger.debug('[WATCHER_FULL] File watcher aborted')
  }
}

/**
 * Generate a unique key for a message to use for deduplication
 * Uses a combination of fields that should be stable across resumes
 * 
 * 
 */
function getMessageKey(message: RawJSONLines): string {
  if (message.type === 'user') {
    // For user messages: timestamp + content
    // Timestamp is stable across resumes
    const content = typeof message.message.content === 'string' 
      ? message.message.content 
      : JSON.stringify(message.message.content)
    return `user:${message.timestamp}:${content}`
  } else if (message.type === 'assistant') {
    // For assistant messages: use content for deduplication
    // This handles cases where the same message.id has different content
    // (e.g., text response followed by tool_use)
    const content = JSON.stringify(message.message.content)
    return `assistant:${message.message.id}:${content}`
  } else if (message.type === 'summary') {
    return `summary:${message.leafUuid}`
  } else if (message.type === 'system') {
    return `system:${message.content}`
  }

  return `unknown:<error, this should be unreachable>`
}
