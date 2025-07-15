/**
 * Claude loop - handles both interactive and remote modes
 * 
 * This is the main control flow for handling:
 * 1. Interactive mode - user types in terminal, Claude runs as child process
 * 2. Remote mode - messages come from mobile app, we use SDK
 */

import { ApiSessionClient } from "@/api/apiSession"
import { UserMessage } from "@/api/types"
import { claude } from "./claudeSdk"
import { spawnInteractiveClaude } from "./interactive"
import { watchMostRecentSession } from "./watcher"
import { logger } from "@/ui/logger"
import chalk from "chalk"

interface LoopOptions {
  path: string
  model?: string
  permissionMode?: 'auto' | 'default' | 'plan'
  mcpServers?: Record<string, any>
  permissionPromptToolName?: string
  onThinking?: (thinking: boolean) => void
}

export function startClaudeLoop(opts: LoopOptions, session: ApiSessionClient) {
  let mode: 'interactive' | 'remote' = 'interactive'
  let exiting = false
  let currentSessionId: string | undefined
  let interactiveProcess: ReturnType<typeof spawnInteractiveClaude> | null = null
  let watcherAbortController: AbortController | null = null

  // Message queue for remote messages
  const messageQueue: UserMessage[] = []
  let messageResolve: (() => void) | null = null
  let abortController: AbortController | null = null

  // Start interactive mode
  const startInteractive = () => {
    logger.debug('Starting interactive mode')
    mode = 'interactive'

    // Clear and show interactive UI
    console.clear()
    logger.info(chalk.bold.blue('📱 Happy CLI - Interactive Mode'))
    logger.info('Your session is accessible from your mobile app\n')

    // Spawn Claude
    logger.debug(`Spawning interactive Claude process (sessionId: ${currentSessionId})`)
    interactiveProcess = spawnInteractiveClaude({
      workingDirectory: opts.path,
      sessionId: currentSessionId,
      model: opts.model,
      permissionMode: opts.permissionMode
    })

    // Handle exit in background
    interactiveProcess.waitForExit().then((code) => {
      if (!exiting) {
        logger.info(`\nClaude exited with code ${code}`)
        cleanup()
      }
    })
  }

  // Request switch to remote mode
  const requestSwitchToRemote = () => {
    logger.debug('Switching from interactive to remote mode')
    // TODO: Check if terminal is still doing stuff - let it stabilize before switching
    mode = 'remote'

    // Kill interactive process
    if (interactiveProcess) {
      logger.debug('Killing interactive process')
      interactiveProcess.kill()
      interactiveProcess = null
    }

    // Show remote UI
    console.clear()
    logger.info(chalk.bold.green('📱 Happy CLI - Remote Control Mode'))
    logger.info(chalk.gray('─'.repeat(50)))
    logger.info('\nYour session is being controlled from the mobile app.')
    logger.info('\n' + chalk.yellow('Press any key to return to interactive mode...'))
  }

  session.addHandler('abort', () => {
    abortController?.abort()
  });

  // Process remote message with SDK
  const processRemoteMessage = async (message: UserMessage) => {
    logger.debug('Processing remote message:', message.content.text)
    opts.onThinking?.(true)
    abortController = new AbortController()
    for await (const output of claude({
      command: message.content.text,
      workingDirectory: opts.path,
      model: opts.model,
      permissionMode: opts.permissionMode,
      mcpServers: opts.mcpServers,
      permissionPromptToolName: opts.permissionPromptToolName,
      sessionId: currentSessionId,
      abort: abortController,
    })) {
      // Handle exit
      if (output.type === 'exit') {
        if (output.code !== 0 || output.code === undefined) {
          session.sendMessage({
            content: {
              type: 'error',
              error: output.error,
              code: output.code,
            },
            role: 'assistant',
          })
        }
        break
      }

      // Handle JSON output
      if (output.type === 'json') {
        session.sendMessage({
          data: output.data,
          type: 'output',
        })

        // Update session ID
        if (output.data.type === 'system' && output.data.subtype === 'init') {
          currentSessionId = output.data.sessionId
          logger.debug(`Updated session ID from SDK: ${currentSessionId}`)
        }
      }
    }

    opts.onThinking?.(false)
  }

  // Main control flow
  const run = async () => {
    // Set up file watcher
    watcherAbortController = new AbortController()
    const watcherPromise = (async () => {
      for await (const event of watchMostRecentSession(opts.path, watcherAbortController)) {
        if (event.sessionId) {
          logger.debug(`New session detected: ${event.sessionId}`)
          currentSessionId = event.sessionId
        }

        if (event.message) {
          // Send to remote as passive observer
          session.sendMessage({
            data: event.message,
            type: 'output',
            // TODO: Use a differnt type
            // type: 'output-passive-observer',
          })

          // Update session ID if needed
          if (event.message.type === 'system' && event.message.subtype === 'init') {
            currentSessionId = event.message.sessionId
          }
        }
      }
    })()

    // Handle incoming remote messages
    session.onUserMessage((message) => {
      logger.debug('Received remote message, adding to queue')
      messageQueue.push(message)

      // If in interactive mode, switch to remote
      if (mode === 'interactive') {
        requestSwitchToRemote()
      }

      // Wake up the message processing loop
      if (messageResolve) {
        logger.debug('Waking up message processing loop')
        messageResolve()
        messageResolve = null
      }
    })

    // Set up input handling
    logger.debug('Setting up stdin input handling')
    process.stdin.setRawMode(true)
    process.stdin.on('data', async (data) => {
      // Always handle Ctrl+C
      if (data.toString() === '\u0003') {
        cleanup()
        return
      }

      if (mode === 'interactive' && interactiveProcess) {
        // Forward to Claude
        interactiveProcess.write(data)
      } else if (mode === 'remote') {
        // Switch back to interactive
        logger.debug('Key pressed in remote mode, switching back to interactive')
        startInteractive()
      }
    })

    // Start with interactive mode
    logger.debug('Initial startup - launching interactive mode')
    startInteractive()

    // Process remote messages (same pattern as original)
    while (!exiting) {
      if (mode === 'remote' && messageQueue.length > 0) {
        const message = messageQueue.shift()
        if (message) {
          await processRemoteMessage(message)
        }
      } else {
        // Wait for next message
        logger.debug('Waiting for next message or event')
        await new Promise<void>((resolve) => {
          messageResolve = resolve
        })
      }
    }

    // Wait for watcher to finish
    await watcherPromise
  }

  // Cleanup function
  const cleanup = () => {
    logger.debug('Starting cleanup process')
    exiting = true

    if (interactiveProcess) {
      interactiveProcess.kill()
    }

    if (watcherAbortController) {
      watcherAbortController.abort()
    }

    // Wake up the loop if it's waiting
    if (messageResolve) {
      messageResolve()
    }

    process.stdin.setRawMode(false)
  }

  // Start the loop
  const promise = run()

  // Return cleanup function
  return async () => {
    cleanup()
    await promise
  }
}