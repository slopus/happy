/**
 * Socket.IO client for handy-cli
 * 
 * This module manages the WebSocket connection to the handy server.
 * It handles authentication, connection lifecycle, and message routing.
 * 
 * Key responsibilities:
 * - Establish authenticated socket connection
 * - Handle reconnection logic
 * - Route messages between server and local handlers
 * - Manage connection state
 * 
 * Design decisions:
 * - Uses socket.io-client for compatibility with server
 * - Auth token passed in handshake for authentication
 * - Automatic reconnection with exponential backoff
 * - Event emitter pattern for decoupled message handling
 */

import { logger } from '#utils/logger'
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'

import { ClientToServerEvents, ServerToClientEvents, Update } from './types.js'

export interface SocketClientOptions {
  authToken: string
  serverUrl: string
  socketPath: string
}

// eslint-disable-next-line unicorn/prefer-event-target
export class SocketClient extends EventEmitter {
  private isConnected = false
  private options: SocketClientOptions
  private socket: null | Socket<ServerToClientEvents, ClientToServerEvents> = null
  
  constructor(options: SocketClientOptions) {
    super()
    this.options = options
  }
  
  /**
   * Connect to the socket server
   */
  connect(): void {
    if (this.socket) {
      logger.warn('Socket already connected')
      return
    }
    
    logger.info('Connecting to socket server...')
    logger.debug(`Server URL: ${this.options.serverUrl}`)
    logger.debug(`Socket path: ${this.options.socketPath}`)
    
    this.socket = io(this.options.serverUrl, {
      auth: {
        token: this.options.authToken
      },
      path: this.options.socketPath,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      transports: ['websocket', 'polling'],
      withCredentials: true
    })
    
    this.setupEventHandlers()
  }
  
  /**
   * Disconnect from the socket server
   */
  disconnect(): void {
    if (this.socket) {
      logger.info('Disconnecting socket...')
      this.socket.disconnect()
      this.socket = null
      this.isConnected = false
    }
  }
  
  /**
   * Check if socket is connected
   */
  getIsConnected(): boolean {
    return this.isConnected
  }
  
  /**
   * Wait for socket to be authenticated
   */
  async waitForAuth(): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Authentication timeout'))
      }, 10_000) // 10 second timeout
      
      this.once('authenticated', (user: string) => {
        clearTimeout(timeout)
        resolve(user)
      })
      
      this.once('authError', () => {
        clearTimeout(timeout)
        reject(new Error('Authentication failed'))
      })
      
      this.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
    })
  }
  
  /**
   * Set up socket event handlers
   */
  private setupEventHandlers(): void {
    if (!this.socket) return
    
    // Connection events
    this.socket.on('connect', () => {
      logger.info('Socket connected successfully')
      this.isConnected = true
      this.emit('connected')
    })
    
    this.socket.on('disconnect', (reason) => {
      logger.warn('Socket disconnected:', reason)
      this.isConnected = false
      this.emit('disconnected', reason)
    })
    
    this.socket.on('connect_error', (error) => {
      logger.error('Socket connection error:', error.message)
      this.emit('error', error)
    })
    
    // Server events
    this.socket.on('auth', (data) => {
      if (data.success) {
        logger.info('Socket authenticated successfully for user:', data.user)
        this.emit('authenticated', data.user)
      } else {
        logger.error('Socket authentication failed')
        this.emit('authError')
      }
    })
    
    this.socket.on('error', (data) => {
      logger.error('Server error:', data.message)
      this.emit('serverError', data.message)
    })
    
    this.socket.on('update', (data: Update) => {
      logger.debug('Received update:', data)
      this.emit('update', data)
    })
  }
}