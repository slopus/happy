/**
 * Watch for Claude session file changes
 * Used to snoop on claude's interactive session state.
 * 
 * - First watch for new session files
 * - Next watch for changes in the most recent session file and yield new messages as they appear
 */

import { watch, readdir, stat, open, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { logger } from '@/ui/logger'

export async function* watchMostRecentSession(
  workingDirectory: string,
  abortController: AbortController
): AsyncGenerator<{ sessionId?: string, message?: any }> {
  const projectName = resolve(workingDirectory).replace(/\//g, '-')
  const projectDir = join(homedir(), '.claude', 'projects', projectName)
  logger.debug(`Starting session watcher for project: ${projectName}`)
  logger.debug(`Watching directory: ${projectDir}`)
  
  if (!existsSync(projectDir)) {
    logger.debug('Project directory does not exist, creating it')
    await mkdir(projectDir, { recursive: true })
  }

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

  // Watch for new session files
  logger.debug('Starting directory watcher for new session files')
  const dirWatcher = watch(projectDir, { signal: abortController.signal })
  
  const newSessionFilePath = await (async (): Promise<string | undefined> => {
    logger.debug('Entering directory watcher loop')
    try {
      for await (const event of dirWatcher) {
        logger.debug(`Directory watcher event: ${event.eventType} - ${event.filename}`)
        if (event.filename && event.filename.endsWith('.jsonl')) {
          const files = await getSessionFiles()
          
          for (const file of files) {
            if (!knownFiles.has(file.name)) {
              logger.debug(`New session file detected: ${file.name}`)
              knownFiles.add(file.name)
              logger.debug(`Returning file path: ${file.path}`)
              
              return file.path
            }
          }
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
  if (!newSessionFilePath) {
    logger.debug('No new session file path returned, exiting watcher')
    return
  }

  logger.debug(`Got session file path: ${newSessionFilePath}, now starting file watcher`)

  yield* watchSessionFile(newSessionFilePath, abortController)
}

async function* watchSessionFile(
  filePath: string,
  abortController: AbortController
): AsyncGenerator<{ message: any }> {
  logger.debug(`Watching session file: ${filePath}`)
  let position = 0
  
  // Read existing content to get to end
  const handle = await open(filePath, 'r')
  const stats = await handle.stat()
  position = stats.size
  await handle.close()
  logger.debug(`Starting file watch from position: ${position}`)

  // Watch for changes
  const fileWatcher = watch(filePath, { signal: abortController.signal })
  
  try {
    for await (const event of fileWatcher) {
      logger.debug(`File watcher event: ${event.eventType}`)
      if (event.eventType === 'change') {
        // Read new lines from last position
        logger.debug(`Reading new content from position: ${position}`)
        const handle = await open(filePath, 'r')
        const stream = handle.createReadStream({ start: position })
        const rl = createInterface({ input: stream })
        
        for await (const line of rl) {
          try {
            const data = JSON.parse(line)
            logger.debug(`New message from watched session file: ${data.type}`)
            logger.debugLargeJson('Message:', data)
            yield { message: data }
          } catch {
            logger.debug('Skipping invalid JSON line')
            // Ignore invalid JSON
          }
        }
        
        // Close readline interface and handle
        rl.close()
        await handle.close()
        
        // Open new handle just to get file size
        const newHandle = await open(filePath, 'r')
        const stats = await newHandle.stat()
        const oldPosition = position
        position = stats.size
        logger.debug(`Updated file position: ${oldPosition} -> ${position}`)
        await newHandle.close()
      }
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      logger.debug('[ERROR] File watcher error:', err)
      throw err
    }
    logger.debug('File watcher aborted')
  }
}