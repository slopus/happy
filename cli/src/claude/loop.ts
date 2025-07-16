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
import { parseClaudeSdkMessage, parseClaudePersistedMessage } from "./types"


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
  let currentClaudeSessionId: string | undefined
  let interactiveProcess: ReturnType<typeof spawnInteractiveClaude> | null = null
  let watcherAbortController: AbortController | null = null

  // Message queue for remote messages
  const messageQueue: UserMessage[] = []
  let messageResolve: (() => void) | null = null

  // Start interactive mode
  const startInteractive = () => {
    logger.debug('[LOOP] startInteractive called')
    logger.debug('[LOOP] Current mode:', mode)
    logger.debug('[LOOP] Current sessionId:', currentClaudeSessionId)
    logger.debug('[LOOP] Current interactiveProcess:', interactiveProcess ? 'exists' : 'null')
    
    mode = 'interactive'
    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: true  // CLI is controlling in interactive mode
    }))

    let startWatcher = async () => {
      watcherAbortController = new AbortController()

      for await (const event of watchMostRecentSession(opts.path, watcherAbortController)) {
        if (event.sessionId) {
          logger.debug(`[LOOP] New session detected from watcher: ${event.sessionId}`)
          currentClaudeSessionId = event.sessionId
          logger.debug('[LOOP] Updated currentSessionId to:', currentClaudeSessionId)
        }

        if (event.rawMessage) {
          // Transform interactive mode messages to match mobile format
          if (event.type === 'user' && event.rawMessage.message) {
            // Send user messages in the same format as mobile client
            // This is a hack to bridge the format difference between interactive and remote modes
            const userMessage: UserMessage = {
              role: 'user',
              localKey: event.rawMessage.uuid, // Use Claude's UUID as localKey
              sentFrom: 'cli', // Identify this as coming from CLI
              content: {
                type: 'text',
                text: event.rawMessage.message.content
              }
            };
            session.sendMessage(userMessage);
          } else if (event.type === 'assistant') {
            // Send assistant messages as-is for passive observation
            session.sendMessage({
              data: event.rawMessage,
              type: 'output',
            });
          }
        }
      }
    }
    void startWatcher()
    
    // Show interactive UI
    logger.info(chalk.bold.blue('📱 Happy CLI - Interactive Mode'))
    if (process.env.DEBUG) {
      logger.logFilePathPromise.then((path) => {
        logger.info(`Debug file for this session: ${path}`)
      })
    }
    logger.info('Your session is accessible from your mobile app\n')

    // Spawn Claude
    logger.debug(`[LOOP] About to spawn interactive Claude process (sessionId: ${currentClaudeSessionId})`)
    interactiveProcess = spawnInteractiveClaude({
      workingDirectory: opts.path,
      sessionId: currentClaudeSessionId,
      model: opts.model,
      permissionMode: opts.permissionMode
    })
    logger.debug('[LOOP] Interactive process spawned')
    
    // HACK: Force resize to trigger redraw when resuming session
    //
    // TODO @kirill
    // Race condition with interactive process starting
    setTimeout(() => {
      if (interactiveProcess && process.stdout.columns && process.stdout.rows) {
        const cols = process.stdout.columns
        const rows = process.stdout.rows
        logger.debug('[LOOP] Force resize timeout fire.d')
        logger.debug('[LOOP] Terminal size:', { cols, rows })
        logger.debug('[LOOP] Resizing to cols-1, rows-1')
        interactiveProcess.resize(cols - 1, rows - 1)
        setTimeout(() => {
          logger.debug('[LOOP] Second resize timeout fired')
          logger.debug('[LOOP] Resizing back to normal size')
          interactiveProcess?.resize(cols, rows)
        }, 10)
      } else {
        logger.debug('[LOOP] Force resize skipped - no process or invalid terminal size')
      }
    }, 100)
    
    // Handle exit in background
    interactiveProcess.waitForExit().then((code) => {
      logger.debug('[LOOP] Interactive process exit handler fired, code:', code)
      logger.debug('[LOOP] Current mode:', mode)
      logger.debug('[LOOP] Exiting:', exiting)
      
      // Only cleanup if we're still in interactive mode and not already exiting
      // If we're in remote mode, the exit was intentional
      if (!exiting && mode === 'interactive') {
        logger.info(`\nClaude exited with code ${code}`)
        cleanup()
      } else {
        logger.debug('[LOOP] Ignoring exit - was intentional mode switch or already exiting')
      }
    })
  }

  // Request switch to remote mode
  const requestSwitchToRemote = () => {
    logger.debug('[LOOP] requestSwitchToRemote called')
    logger.debug('[LOOP] Current mode before switch:', mode)
    logger.debug('[LOOP] interactiveProcess exists:', interactiveProcess ? 'yes' : 'no')
    
    // TODO: Check if terminal is still doing stuff - let it stabilize before switching
    mode = 'remote'
    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: false  // User is controlling via mobile in remote mode
    }))
    // Kill interactive process
    if (interactiveProcess) {
      logger.debug('[LOOP] Killing interactive process')
      interactiveProcess.kill()
      logger.debug('[LOOP] Kill called, setting interactiveProcess to null')
      interactiveProcess = null
    } else {
      logger.debug('[LOOP] No interactive process to kill')
    }
    
    // Clear and show remote UI
    // logger.debug('[LOOP] Clearing screen for remote mode')
    // console.clear()
    logger.info(chalk.bold.green('📱 Happy CLI - Remote Control Mode'))
    logger.info(chalk.gray('─'.repeat(50)))
    logger.info('\nYour session is being controlled from the mobile app.')
    logger.info('\n' + chalk.yellow('Press any key to return to interactive mode...'))
    process.stdout.write('\n> ')
    // Show cursor explicitly
    process.stdout.write('\x1b[?25h')
    logger.debug('[LOOP] Remote UI displayed')
  }

  session.addHandler('abort', () => {
    watcherAbortController?.abort()
  });

  // Process remote message with SDK
  const processRemoteMessage = async (message: UserMessage) => {
    logger.debug('Processing remote message:', message.content.text)
    opts.onThinking?.(true)
    watcherAbortController = new AbortController()
    for await (const output of claude({
      command: message.content.text,
      workingDirectory: opts.path,
      model: opts.model,
      permissionMode: opts.permissionMode,
      mcpServers: opts.mcpServers,
      permissionPromptToolName: opts.permissionPromptToolName,
      sessionId: currentClaudeSessionId,
      abort: watcherAbortController,
    })) {
      // Handle exit
      if (output.type === 'exit') {
        if (output.code !== 0 || output.code === undefined) {
          session.sendMessage({
            type: 'error',
            error: output.error,
            code: output.code,
          })
        }
        break
      }

      // Handle JSON output
      if (output.type === 'json') {
        logger.debugLargeJson('[LOOP] Sending message through socket:', output.data)
        session.sendMessage({
          data: output.data,
          type: 'output',
        })

        // Update session ID
        const claudeSdkMessage = parseClaudeSdkMessage(output.data)
        if (claudeSdkMessage) {
          currentClaudeSessionId = claudeSdkMessage.sessionId
          logger.debug(`[LOOP] Updated session ID from SDK: ${currentClaudeSessionId}`)
          logger.debugLargeJson('[LOOP] Full init data:', output.data)
        }
      }
    }

    opts.onThinking?.(false)
  }

  // Main control flow
  const run = async () => {
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
    logger.debug('[LOOP] Setting up stdin input handling')
    process.stdin.setRawMode(true)
    process.stdin.resume()
    logger.debug('[LOOP] stdin set to raw mode and resumed')
    
    // Handle stdin errors gracefully
    process.stdin.on('error', (err) => {
      logger.debug('[LOOP] stdin error:', err)
      if ((err as any).code === 'EIO') {
        // Terminal was closed, exit gracefully
        cleanup()
        process.exit(0)
      }
    })
    
    process.stdin.on('data', async (data) => {
      // NOTE: Extremetly verbose log, disabling
      // logger.debug('[PTY] stdin data received, length:', data.length)
      
      // Always handle Ctrl+C
      if (data.toString() === '\u0003') {
        logger.debug('[PTY] Ctrl+C detected')
        cleanup()
        process.exit(0)
        return
      }
      
      if (mode === 'interactive' && interactiveProcess) {
        // Forward to Claude
        // logger.debug('[PTY] Forwarding data to interactive process')
        interactiveProcess.write(data)
      } else if (mode === 'remote') {
        // Any key switches back to interactive
        logger.debug('[LOOP] Key pressed in remote mode, switching back to interactive')
        startInteractive()
      } else {
        logger.debug('[LOOP] [ERROR] Data received but no action taken')
      }
    })

    // Handle process termination signals
    process.on('SIGINT', () => {
      logger.debug('[LOOP] SIGINT received')
      cleanup()
      process.exit(0)
    })
    
    process.on('SIGTERM', () => {
      logger.debug('[LOOP] SIGTERM received')
      cleanup()
      process.exit(0)
    })
    
    // Start with interactive mode
    logger.debug('[LOOP] Initial startup - launching interactive mode')
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
  }

  // Cleanup function
  const cleanup = () => {
    logger.debug('[LOOP] cleanup called')
    exiting = true

    if (interactiveProcess) {
      logger.debug('[LOOP] Killing interactive process in cleanup')
      interactiveProcess.kill()
    } else {
      logger.debug('[LOOP] No interactive process to kill in cleanup')
    }

    if (watcherAbortController) {
      logger.debug('[LOOP] Aborting watcher')
      watcherAbortController.abort()
    }

    // Wake up the loop if it's waiting
    if (messageResolve) {
      logger.debug('[LOOP] Waking up message loop')
      messageResolve()
    }
    
    logger.debug('[LOOP] Setting stdin raw mode to false')
    process.stdin.setRawMode(false)
    process.stdin.pause()
    
    // Restore cursor visibility
    process.stdout.write('\x1b[?25h')
  }

  // Start the loop
  const promise = run()

  // Return cleanup function
  return async () => {
    cleanup()
    await promise
  }
}