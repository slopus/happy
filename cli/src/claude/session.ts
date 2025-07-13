/**
 * Claude session management module
 * 
 * This module manages Claude CLI sessions, tracking session IDs
 * and handling session persistence across command invocations.
 * 
 * Key responsibilities:
 * - Track current session ID
 * - Create new sessions
 * - Resume existing sessions
 * - Coordinate with ClaudeSpawner
 * 
 * Design decisions:
 * - Session IDs are captured from Claude's JSON output
 * - Sessions are directory-specific (Claude's internal behavior)
 * - No persistent storage of session IDs (Claude handles this)
 */

import { logger } from '#utils/logger'
import { EventEmitter } from 'node:events'

import { ClaudeSpawner } from './spawn.js'
import { ClaudeResponse, ClaudeSpawnOptions } from './types.js'

// eslint-disable-next-line unicorn/prefer-event-target
export class ClaudeSession extends EventEmitter {
  private currentSessionId?: string
  private spawner: ClaudeSpawner
  private workingDirectory: string
  
  constructor(workingDirectory: string) {
    super()
    this.workingDirectory = workingDirectory
    this.spawner = new ClaudeSpawner()
    this.setupSpawnerHandlers()
  }
  
  /**
   * Execute a command in Claude
   */
  execute(command: string, options?: Partial<ClaudeSpawnOptions>): void {
    const spawnOptions: ClaudeSpawnOptions = {
      model: options?.model || 'sonnet',
      permissionMode: options?.permissionMode || 'default',
      sessionId: this.currentSessionId,
      workingDirectory: this.workingDirectory,
      ...options
    }
    
    logger.info('Executing command:', command)
    logger.debug('Spawn options:', spawnOptions)
    
    this.spawner.spawn(command, spawnOptions)
  }
  
  /**
   * Get the current session ID
   */
  getSessionId(): string | undefined {
    return this.currentSessionId
  }
  
  /**
   * Check if a process is running
   */
  isRunning(): boolean {
    return this.spawner.isRunning()
  }
  
  /**
   * Kill the current Claude process
   */
  kill(): void {
    this.spawner.kill()
  }
  
  /**
   * Send input to the current Claude process
   */
  sendInput(input: string): void {
    this.spawner.sendInput(input)
  }
  
  /**
   * Start a new session (no previous session ID)
   */
  startNewSession(command: string, options?: Partial<ClaudeSpawnOptions>): void {
    this.currentSessionId = undefined
    this.execute(command, options)
  }
  
  /**
   * Set up event handlers for the spawner
   */
  private setupSpawnerHandlers(): void {
    this.spawner.on('response', (response: ClaudeResponse) => {
      // Capture session ID from responses
      if (response.session_id) {
        this.currentSessionId = response.session_id
        logger.info('Session ID updated:', this.currentSessionId)
      }
      
      // Forward the response
      this.emit('response', response)
    })
    
    this.spawner.on('output', (output: string) => {
      this.emit('output', output)
    })
    
    this.spawner.on('error', (error: string) => {
      this.emit('error', error)
    })
    
    this.spawner.on('exit', (exitInfo) => {
      this.emit('exit', exitInfo)
    })
    
    this.spawner.on('processError', (error) => {
      this.emit('processError', error)
    })
  }
}