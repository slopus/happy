/**
 * Watch for Claude session file changes
 * Used to snoop on claude's interactive session state.
 * 
 * - First watch for new session files
 * - Next watch for changes in the most recent session file and yield new messages as they appear
 */

import { watch, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { logger } from '@/ui/logger'
import { RawJSONLines, RawJSONLinesSchema } from './types'
import { mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'



export async function* watchMostRecentSession(
  workingDirectory: string,
  watchForSessionId: string,
  abortController: AbortController,
  lastKnownMessageTimestamp: string | undefined = undefined
): AsyncGenerator<RawJSONLines> {
  const projectName = resolve(workingDirectory).replace(/\//g, '-')
  const projectDir = join(homedir(), '.claude', 'projects', projectName)
  const expectedSessionFile = join(projectDir, `${watchForSessionId}.jsonl`)
  logger.debug(`Starting session watcher for project: ${projectDir}`)
  logger.debug(`Watching directory: ${projectDir}`)
  
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

  // Check if the session file already exists (unlikely to happen)
  if (existsSync(expectedSessionFile)) {
    logger.debug(`Session file already exists, starting watch: ${expectedSessionFile}`)
    yield* watchSessionFile(expectedSessionFile, abortController, lastKnownMessageTimestamp)
    return
  }
  
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

  yield* watchSessionFile(expectedSessionFile, abortController, lastKnownMessageTimestamp)
}


/* Emits raw, unvalidated json objects parsed from the session file */
export async function* watchSessionFile(
  sessionFile: string,
  abortController: AbortController,
  lastKnownMessageTimestamp: string | undefined = undefined
): AsyncGenerator<RawJSONLines> {
  logger.debug(`Watching claude session file: ${sessionFile}`)
  let position = 0

  // Watch for changes
  const fileWatcher = watch(sessionFile, { signal: abortController.signal })
  
  try {
    for await (const event of fileWatcher) {
      logger.debug(`File watcher event: ${event.eventType}`)
      if (event.eventType === 'change') {
        // Read new lines from last position
        logger.debug(`Reading new content from position: ${position}`)
        const handle = await open(sessionFile, 'r')
        const stream = handle.createReadStream({ start: position })
        const rl = createInterface({ input: stream })
        
        for await (const line of rl) {
          try {
            const messageParsed = RawJSONLinesSchema.safeParse(JSON.parse(line))

            if (!messageParsed.success) {
              logger.debug('[ERROR] Skipping invalid JSON line')
              continue
            }

            const message = messageParsed.data

            // Skip all messages until we see a message with a timestamp greater than the last known message
            if (lastKnownMessageTimestamp && message.timestamp <= lastKnownMessageTimestamp) {
              logger.debug(`[WATCHER] Skipping message before last known message with type: ${message.type}`)
              continue
            }

            logger.debug(`[WATCHER] New message from watched session file: ${message.type}`)
            logger.debugLargeJson('[WATCHER] Message:', message)
            yield message
          } catch (err: any) {
            logger.debug('[ERROR] Skipping invalid JSON line', err)
            // Ignore invalid JSON
          }
        }
        
        // Close readline interface and handle
        rl.close()
        await handle.close()
        
        // Open new handle just to get file size
        const newHandle = await open(sessionFile, 'r')
        const stats = await newHandle.stat()
        const oldPosition = position
        position = stats.size
        logger.debug(`Updated file position: ${oldPosition} -> ${position}`)
        await newHandle.close()
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