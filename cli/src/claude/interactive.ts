/**
 * Spawn interactive Claude process using PTY to allow users
 * to run `happy` as a drop in replacement for `claude`.
 * 
 * Returns control interface for the child process.
 */

import * as pty from 'node-pty'
import { claudePath } from './claudePath'
import { logger } from '@/ui/logger'

interface InteractiveChildClaude {
  write: (data: any) => void
  kill: () => void
  waitForExit: () => Promise<number>
  resize: (cols: number, rows: number) => void
}

export function spawnInteractiveClaude(options: {
  workingDirectory: string
  sessionId?: string
  model?: string
  permissionMode?: string
}): InteractiveChildClaude {
  const args: string[] = []
  
  if (options.sessionId) {
    args.push('--resume', options.sessionId)
  }
  
  if (options.model) {
    args.push('-m', options.model)
  }
  
  if (options.permissionMode) {
    args.push('-p', options.permissionMode)
  }

  // Create PTY process
  logger.debug('[PTY] Creating PTY process with args:', args)

  const ptyProcess = pty.spawn(claudePath(), args, {
    name: 'xterm-256color',
    cols: process.stdout.columns,
    rows: process.stdout.rows,
    cwd: options.workingDirectory,
    env: process.env
  })
  logger.debug('[PTY] PTY process created, pid:', (ptyProcess as any).pid)

  // Handle output - direct to stdout
  ptyProcess.onData((data: string) => {
    process.stdout.write(data)
  })

  // Handle resize
  const resizeHandler = () => {
    logger.debug('[PTY] SIGWINCH received, resizing to:', { cols: process.stdout.columns, rows: process.stdout.rows })
    ptyProcess.resize(process.stdout.columns, process.stdout.rows)
  }
  process.on('SIGWINCH', resizeHandler)

  // Create exit promise
  const exitPromise = new Promise<number>((resolve) => {
    ptyProcess.onExit((exitCode) => {
      logger.debug('[PTY] PTY process exited with code:', exitCode.exitCode)
      logger.debug('[PTY] Removing SIGWINCH handler')
      process.removeListener('SIGWINCH', resizeHandler)
      resolve(exitCode.exitCode)
    })
  })

  return {
    write: (data) => {
      // NOTE: Extremetly verbose log, disable
      // logger.debug('[PTY] Writing data to PTY, length:', data.length)
      ptyProcess.write(data)
    },
    kill: () => {
      logger.debug('[PTY] Kill called')
      process.removeListener('SIGWINCH', resizeHandler)
      ptyProcess.kill()
    },
    waitForExit: () => exitPromise,
    resize: (cols: number, rows: number) => {
      logger.debug('[PTY] Manual resize called:', { cols, rows })
      ptyProcess.resize(cols, rows)
    }
  }
}