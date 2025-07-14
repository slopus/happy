/**
 * Spawn interactive Claude process using PTY to allow users
 * to run `happy` as a drop in replacement for `claude`.
 * 
 * Returns control interface for the child process.
 */

import * as pty from 'node-pty'
import { claudePath } from './claudePath'

interface InteractiveChildClaude {
  write: (data: any) => void
  kill: () => void
  waitForExit: () => Promise<number>
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
  const ptyProcess = pty.spawn(claudePath(), args, {
    name: 'xterm-256color',
    cols: process.stdout.columns,
    rows: process.stdout.rows,
    cwd: options.workingDirectory,
    env: process.env
  })

  // Handle output - direct to stdout
  ptyProcess.onData((data: string) => {
    process.stdout.write(data)
  })

  // Handle resize
  const resizeHandler = () => {
    ptyProcess.resize(process.stdout.columns, process.stdout.rows)
  }
  process.on('SIGWINCH', resizeHandler)

  // Create exit promise
  const exitPromise = new Promise<number>((resolve) => {
    ptyProcess.onExit((exitCode) => {
      process.removeListener('SIGWINCH', resizeHandler)
      resolve(exitCode.exitCode)
    })
  })

  return {
    write: (data) => ptyProcess.write(data),
    kill: () => {
      process.removeListener('SIGWINCH', resizeHandler)
      ptyProcess.kill()
    },
    waitForExit: () => exitPromise
  }
}