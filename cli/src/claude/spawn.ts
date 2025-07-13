/**
 * Claude CLI process spawning module
 * 
 * This module handles spawning and managing Claude CLI processes.
 * It provides functionality to start Claude sessions, send commands,
 * and parse JSON line output.
 * 
 * Key responsibilities:
 * - Spawn Claude CLI with appropriate arguments
 * - Handle stdin/stdout/stderr streams
 * - Parse JSON line output
 * - Manage process lifecycle
 * 
 * Design decisions:
 * - Uses child_process.spawn for process management
 * - Parses JSON lines individually for streaming support
 * - Maintains process state for cleanup
 * - Supports session resumption via --resume flag
 */

import { logger } from '#utils/logger'
import { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

import { ClaudeProcess, ClaudeResponse, ClaudeSpawnOptions } from './types.js'

// eslint-disable-next-line unicorn/prefer-event-target
export class ClaudeSpawner extends EventEmitter {
  private currentProcess: ClaudeProcess | null = null
  
  /**
   * Get the current session ID
   */
  getSessionId(): string | undefined {
    return this.currentProcess?.sessionId
  }
  
  /**
   * Check if a process is running
   */
  isRunning(): boolean {
    return this.currentProcess?.isRunning || false
  }
  
  /**
   * Kill the current Claude process
   */
  kill(): void {
    if (this.currentProcess?.process) {
      logger.info('Killing Claude process')
      this.currentProcess.process.kill('SIGTERM')
      this.currentProcess.isRunning = false
    }
  }
  
  /**
   * Send input to the Claude process
   */
  sendInput(input: string): void {
    if (!this.currentProcess?.isRunning) {
      logger.error('No running Claude process')
      return
    }
    
    logger.debug('Sending input to Claude:', input)
    this.currentProcess.process.stdin?.write(input + '\n')
  }
  
  /**
   * Spawn a new Claude CLI process
   */
  spawn(command: string, options: ClaudeSpawnOptions): void {
    if (this.currentProcess?.isRunning) {
      logger.warn('Claude process already running, killing existing process')
      this.kill()
    }
    
    const args = this.buildArgs(command, options)
    logger.info('Spawning Claude CLI with args:', args.join(' '))
    
    const claudeProcess = spawn('claude', args, {
      cwd: options.workingDirectory,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    
    this.currentProcess = {
      isRunning: true,
      process: claudeProcess,
      sessionId: options.sessionId
    }
    
    this.setupProcessHandlers(claudeProcess)
    
    // Close stdin for --print mode (like claudecodeui does)
    claudeProcess.stdin?.end()
  }
  
  /**
   * Build command line arguments for Claude CLI
   */
  private buildArgs(command: string, options: ClaudeSpawnOptions): string[] {
    const args: string[] = []
    
    // The command must come first with --print flag (like claudecodeui does)
    args.push('--print', command)
    
    // Session resumption
    if (options.sessionId) {
      args.push('--resume', options.sessionId)
    }
    
    // Output format for JSON streaming
    args.push('--output-format', 'stream-json', '--verbose')
    
    // Model selection
    if (options.model) {
      args.push('--model', options.model)
    }
    
    // Permission mode
    if (options.permissionMode) {
      args.push('--permission-mode', options.permissionMode)
    }
    
    // Skip permissions if requested
    if (options.skipPermissions) {
      args.push('--dangerously-skip-permissions')
    }
    
    // Tool whitelisting
    if (options.allowedTools && options.allowedTools.length > 0) {
      for (const tool of options.allowedTools) {
        args.push('--allowedTools', tool)
      }
    }
    
    // Tool blacklisting
    if (options.disallowedTools && options.disallowedTools.length > 0) {
      for (const tool of options.disallowedTools) {
        args.push('--disallowedTools', tool)
      }
    }
    
    return args
  }
  
  /**
   * Set up event handlers for the Claude process
   */
  private setupProcessHandlers(claudeProcess: ChildProcess): void {
    // Handle stdout (JSON lines)
    claudeProcess.stdout?.on('data', (data: Buffer) => {
      const rawOutput = data.toString()
      const lines = rawOutput.split('\n').filter(line => line.trim())
      
      for (const line of lines) {
        try {
          const response: ClaudeResponse = JSON.parse(line)
          
          // Capture session ID if present
          if (response.session_id && this.currentProcess) {
            this.currentProcess.sessionId = response.session_id
            logger.debug('Captured session ID:', response.session_id)
          }
          
          this.emit('response', response)
        } catch {
          // If not JSON, emit as raw output
          logger.debug('Non-JSON output:', line)
          this.emit('output', line)
        }
      }
    })
    
    // Handle stderr
    claudeProcess.stderr?.on('data', (data: Buffer) => {
      const error = data.toString()
      
      // Filter out non-critical debugging messages
      const nonCriticalMessages = [
        'Debugger attached.',
        'Waiting for the debugger to disconnect...',
        'Debugger listening on'
      ]
      
      const isNonCritical = nonCriticalMessages.some(msg => error.includes(msg))
      
      if (isNonCritical) {
        logger.debug('Claude debug output:', error)
      } else {
        logger.error('Claude stderr:', error)
        this.emit('error', error)
      }
    })
    
    // Handle process exit
    claudeProcess.on('exit', (code, signal) => {
      logger.info(`Claude process exited with code ${code} and signal ${signal}`)
      if (this.currentProcess) {
        this.currentProcess.isRunning = false
      }

      this.emit('exit', { code, signal })
    })
    
    // Handle process errors
    claudeProcess.on('error', (error) => {
      logger.error('Claude process error:', error)
      if (this.currentProcess) {
        this.currentProcess.isRunning = false
      }

      this.emit('processError', error)
    })
  }
}