/**
 * Simplified Claude CLI integration
 * 
 * This module provides a simple interface to spawn Claude CLI for each command.
 * Each command runs in its own process and exits when complete.
 * 
 * Key responsibilities:
 * - Spawn Claude CLI with appropriate arguments
 * - Track session ID across command invocations
 * - Parse and emit Claude responses
 * - Handle process lifecycle for each command
 * 
 * Design decisions:
 * - One process per command (no stdin interaction)
 * - Session ID persisted in memory only
 * - Kill any existing process before starting new one
 * - Simple event-based API for responses
 */

import { logger } from '@/ui/logger'
import { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

import { ClaudeResponse } from './types.js'

export interface ClaudeOptions {
  model?: string
  permissionMode?: 'auto' | 'default' | 'plan'
  skipPermissions?: boolean
  workingDirectory: string
}


// eslint-disable-next-line unicorn/prefer-event-target
export class Claude extends EventEmitter {
  private currentProcess?: ChildProcess
  private currentSessionId?: string
  
  /**
   * Get the current session ID
   */
  getSessionId(): string | undefined {
    return this.currentSessionId
  }
  
  /**
   * Kill the current process if running
   */
  kill(): void {
    if (this.currentProcess && !this.currentProcess.killed) {
      logger.info('Killing Claude process')
      this.currentProcess.kill()
      this.currentProcess = undefined
    }
  }
  
  /**
   * Run a single Claude command
   * Kills any existing process and spawns a new one
   */
  async runClaudeCodeTurn(
    command: string, 
    sessionId: string | undefined,
    options: ClaudeOptions
  ): Promise<void> {
    // Kill any existing process - wait for it to exit
    if (this.currentProcess && !this.currentProcess.killed) {
      logger.info('Killing existing Claude process')
      await this.killAndWait()
    }
    
    // Build command arguments (no session resuming for now)
    const args = this.buildArgs(command, undefined, options)
    
    logger.info('Spawning Claude CLI with args:', args)
    
    // Spawn the process
    this.currentProcess = spawn('claude', args, {
      cwd: options.workingDirectory,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    
    // Close stdin immediately (we don't send input)
    this.currentProcess.stdin?.end()
    
    // Handle stdout (JSON responses)
    let outputBuffer = ''
    this.currentProcess.stdout?.on('data', (data: Buffer) => {
      outputBuffer += data.toString()
      
      // Process complete lines
      const lines = outputBuffer.split('\n')
      outputBuffer = lines.pop() || ''
      
      for (const line of lines) {
        if (line.trim()) {
          this.processOutput(line)
        }
      }
    })
    
    // Handle stderr
    this.currentProcess.stderr?.on('data', (data: Buffer) => {
      const error = data.toString()
      logger.error('Claude stderr:', error)
      this.emit('error', error)
    })
    
    // Handle process exit
    this.currentProcess.on('exit', (code, signal) => {
      logger.info(`Claude process exited with code ${code} and signal ${signal}`)
      this.emit('exit', { code, signal })
      this.currentProcess = undefined
    })
    
    // Handle process errors
    this.currentProcess.on('error', (error) => {
      logger.error('Claude process error:', error)
      this.emit('processError', error)
      this.currentProcess = undefined
    })
  }
  
  /**
   * Build command line arguments for Claude
   */
  private buildArgs(
    command: string,
    sessionId: string | undefined,
    options: ClaudeOptions
  ): string[] {
    const args = [
      '--print', command,
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose'
    ]
    
    // Add model
    if (options.model) {
      args.push('--model', options.model)
    }
    
    // Add permission mode
    if (options.permissionMode) {
      const modeMap = {
        'auto': 'acceptEdits',
        'default': 'default',
        'plan': 'bypassPermissions'
      }
      args.push('--permission-mode', modeMap[options.permissionMode])
    }
    
    // Add skip permissions flag
    if (options.skipPermissions) {
      args.push('--dangerously-skip-permissions')
    }
    
    // Add session resume if we have a session ID
    if (sessionId) {
      args.push('--resume', sessionId)
    }
    
    return args
  }
  
  /**
   * Kill the current process and wait for it to exit
   */
  private async killAndWait(): Promise<void> {
    if (!this.currentProcess || this.currentProcess.killed) {
      return
    }
    
    return new Promise((resolve) => {
      const process = this.currentProcess!
      
      // Set up exit handler
      const exitHandler = () => {
        this.currentProcess = undefined
        resolve()
      }
      
      process.once('exit', exitHandler)
      
      // Kill the process
      process.kill()
      
      // Set a timeout in case the process doesn't exit
      setTimeout(() => {
        process.removeListener('exit', exitHandler)
        this.currentProcess = undefined
        resolve()
      }, 1000) // 1 second timeout
    })
  }
  
  /**
   * Process a line of output from Claude
   */
  private processOutput(line: string): void {
    try {
      const response = JSON.parse(line) as ClaudeResponse
      
      // Capture session ID from responses
      if (response.session_id) {
        this.currentSessionId = response.session_id
        logger.info('Session ID updated:', this.currentSessionId)
      }
      
      // Emit the parsed response
      this.emit('response', response)
    } catch {
      // Not JSON, emit as regular output
      this.emit('output', line)
    }
  }
}