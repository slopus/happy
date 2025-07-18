/**
 * Watch for Claude session file changes
 * Used to snoop on claude's interactive session state.
 * 
 * - First watch for new session files
 * - Next watch for changes in the most recent session file and yield new messages as they appear
 * 
 * Session Resume Behavior:
 * When Claude resumes a session with --resume, it creates a NEW session file and copies history.
 * - User messages: Keep same UUID and timestamp
 * - Assistant messages: Get new UUID and timestamp, but message.id remains stable
 * 
 * To avoid duplicates, we track:
 * - Last known user message timestamp (doesn't change on resume)
 * - Last known assistant message.id (stable across resumes)
 */

import { watch, open, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { logger } from '@/ui/logger'
import { RawJSONLines, RawJSONLinesSchema } from './types'
import { mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'



export interface LastKnownMessage {
  userMessageTimestamp?: string;
  assistantMessageId?: string;
}

export async function* watchMostRecentSession(
  workingDirectory: string,
  watchForSessionId: string,
  abortController: AbortController,
  lastKnownMessage: LastKnownMessage = {}
): AsyncGenerator<RawJSONLines> {
  const projectName = resolve(workingDirectory).replace(/\//g, '-')
  const projectDir = join(homedir(), '.claude', 'projects', projectName)
  const expectedSessionFile = join(projectDir, `${watchForSessionId}.jsonl`)
  logger.debug(`[WATCHER] Starting session watcher for project: ${projectDir} Watching directory: ${projectDir}, watchForSessionId: ${watchForSessionId}, lastKnownMessage: ${JSON.stringify(lastKnownMessage)}`)
  
  if (!existsSync(projectDir)) {
    logger.debug('Project directory does not exist, creating it')
    await mkdir(projectDir, { recursive: true })
  }

  // Watch for new session files
  logger.debug('Starting directory watcher for new session files')
  const dirWatcher = watch(projectDir, { signal: abortController.signal })

  // Get existing session files
  const getSessionFiles = async () => {
    const files = await readdir(projectDir)
    return files
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        path: join(projectDir, f),
        sessionId: f.replace('.jsonl', '')
      }))
  }

  const initialFiles = await getSessionFiles()
  const knownFiles = new Set(initialFiles.map(f => f.name))
  logger.debug(`Found ${knownFiles.size} existing session files`)

  // Check if the session file already exists
  if (existsSync(expectedSessionFile)) {
    logger.debug(`Session file already exists, starting watch: ${expectedSessionFile}`)
    yield* watchSessionFile(expectedSessionFile, abortController, lastKnownMessage)
    return
  }
  
  // Wait for our session file to be created
  await (async (): Promise<string | undefined> => {
    logger.debug('Entering directory watcher loop')
    try {
      for await (const event of dirWatcher) {
        logger.debug(`Directory watcher event: ${event.eventType} - ${event.filename}`)
        if (event.eventType === 'rename' 
          && event.filename === `${watchForSessionId}.jsonl`
        ) {
          logger.debug(`Matching session file created by claude, will start watching`)
          return
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        logger.debug('[ERROR] Directory watcher unexpected error:', err)
      }
      logger.debug('Directory watcher aborted')
    }
    return
  })()

  // We aborted early
  if (abortController.signal.aborted) {
    logger.debug('No new session file path returned, exiting watcher')
    return
  }

  yield* watchSessionFile(expectedSessionFile, abortController, lastKnownMessage)
}


/* Emits raw, unvalidated json objects parsed from the session file */
export async function* watchSessionFile(
  sessionFile: string,
  abortController: AbortController,
  lastKnownMessage: LastKnownMessage = {}
): AsyncGenerator<RawJSONLines> {
  logger.debug(`Watching claude session file: ${sessionFile}`)
  let position = 0

  // Define line processing function
  const processLine = (line: string, lineBytes: number): { message?: RawJSONLines, bytesRead: number } => {
    try {
      const messageParsed = RawJSONLinesSchema.safeParse(JSON.parse(line))

      if (!messageParsed.success) {
        logger.debug('[ERROR] Skipping invalid JSON line', messageParsed.error.message)
        return { bytesRead: lineBytes }
      }

      const message = messageParsed.data

      // Skip messages we've already seen based on type
      if (message.type === 'user' && lastKnownMessage.userMessageTimestamp) {
        // For user messages, skip if timestamp is same or older
        if (new Date(message.timestamp).getTime() <= new Date(lastKnownMessage.userMessageTimestamp).getTime()) {
          logger.debug(`[WATCHER] Skipping user message with old timestamp: ${message.timestamp}`)
          return { bytesRead: lineBytes }
        }
      } else if (message.type === 'assistant' && lastKnownMessage.assistantMessageId) {
        // For assistant messages, skip if we've seen this message.id before
        if (message.message.id === lastKnownMessage.assistantMessageId) {
          logger.debug(`[WATCHER] Skipping assistant message with known id: ${message.message.id}`)
          return { bytesRead: lineBytes }
        }
      }

      logger.debug(`[WATCHER] New message from watched session file: ${message.type}`)
      logger.debugLargeJson('[WATCHER] Message:', message)
      return { message, bytesRead: lineBytes }
    } catch (err: any) {
      logger.debug('[ERROR] Skipping invalid JSON line', err)
      return { bytesRead: lineBytes }
    }
  }

  // First, read all existing lines
  logger.debug('Reading existing lines from session file')
  const initialHandle = await open(sessionFile, 'r')
  const initialStream = initialHandle.createReadStream()
  const initialRl = createInterface({ input: initialStream })
  
  // Watch for changes (before we start reading existing lines to avoid a race)
  const fileWatcher = watch(sessionFile, { signal: abortController.signal })

  // Read all existing lines
  for await (const line of initialRl) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1 // +1 for newline
    const result = processLine(line, lineBytes)
    position += result.bytesRead
    if (result.message) {
      yield result.message
    }
  }
  
  initialRl.close()
  await initialHandle.close()
  logger.debug(`Finished reading existing content, position: ${position}`)

  try {
    for await (const event of fileWatcher) {
      logger.debug(`File watcher event: ${event.eventType}`)
      if (event.eventType === 'change') {
        // Read new lines from last position
        logger.debug(`Reading new content from position: ${position}`)
        const handle = await open(sessionFile, 'r')
        const stream = handle.createReadStream({ start: position })
        const rl = createInterface({ input: stream })
        
        let bytesReadInThisChunk = 0
        for await (const line of rl) {
          const lineBytes = Buffer.byteLength(line, 'utf8') + 1 // +1 for newline
          const result = processLine(line, lineBytes)
          bytesReadInThisChunk += result.bytesRead
          if (result.message) {
            yield result.message
          }
        }
        
        // Close readline interface and handle
        rl.close()
        await handle.close()
        
        // Update position based on bytes read
        const oldPosition = position
        position += bytesReadInThisChunk
        logger.debug(`Updated file position: ${oldPosition} -> ${position} (read ${bytesReadInThisChunk} bytes)`)

        // Debug sanity check - verify our position tracking is correct
        // Racy, but its fine
        if (process.env.DEBUG) {
          try {
            const stats = await stat(sessionFile)
            const actualFileSize = stats.size
            if (actualFileSize !== position) {
              logger.debug(`[DEBUG][WARNING] Position mismatch! Expected: ${position}, Actual file size: ${actualFileSize}`)
            } else {
              logger.debug(`[DEBUG] Position tracking correct: ${position} bytes`)
            }
          } catch (statErr) {
            logger.debug(`[DEBUG] Could not stat file for sanity check:`, statErr)
          }
        }
      }
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      logger.debug('[ERROR] File watcher error in session file:', sessionFile, err)
      if (process.env.DEBUG) {
        throw err
      }
    }
    logger.debug('File watcher aborted')
  }
}