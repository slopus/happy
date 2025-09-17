import { io, Socket } from 'socket.io-client';
import { TokenStorage } from '@/auth/tokenStorage';
import { Encryption } from './encryption/encryption';
import { connectionTimeoutHandler, type RequestOptions } from './connectionTimeoutHandler';
import { log } from '@/log';

//
// Types
//

export interface SyncSocketConfig {
    endpoint: string;
    token: string;
}

export interface SyncSocketState {
    isConnected: boolean;
    connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    lastError: Error | null;
}

export type SyncSocketListener = (state: SyncSocketState) => void;

//
// Main Class
//

class ApiSocket {

  // State
  private socket: Socket | null = null;
  private config: SyncSocketConfig | null = null;
  private encryption: Encryption | null = null;
  private messageHandlers: Map<string, (data: any) => void> = new Map();
  private reconnectedListeners: Set<() => void> = new Set();
  private statusListeners: Set<(status: 'disconnected' | 'connecting' | 'connected' | 'error') => void> = new Set();
  private currentStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';

  //
  // Initialization
  //

  initialize(config: SyncSocketConfig, encryption: Encryption) {
    this.config = config;
    this.encryption = encryption;
    this.connect();
  }

  //
  // Connection Management
  //

  connect() {
    if (!this.config || this.socket) {
      return;
    }

    this.updateStatus('connecting');

    this.socket = io(this.config.endpoint, {
      path: '/v1/updates',
      auth: {
        token: this.config.token,
        clientType: 'user-scoped' as const,
      },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
    });

    this.setupEventHandlers();
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.updateStatus('disconnected');
  }

  //
  // Listener Management
  //

  onReconnected = (listener: () => void) => {
    this.reconnectedListeners.add(listener);
    return () => this.reconnectedListeners.delete(listener);
  };

  onStatusChange = (listener: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void) => {
    this.statusListeners.add(listener);
    // Immediately notify with current status
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  };

  //
  // Message Handling
  //

  onMessage(event: string, handler: (data: any) => void) {
    this.messageHandlers.set(event, handler);
    return () => this.messageHandlers.delete(event);
  }

  offMessage(event: string, handler: (data: any) => void) {
    this.messageHandlers.delete(event);
  }

  /**
     * RPC call for sessions - uses session-specific encryption
     */
  async sessionRPC<R, A>(sessionId: string, method: string, params: A, timeout?: number): Promise<R> {
    const sessionEncryption = this.encryption!.getSessionEncryption(sessionId);
    if (!sessionEncryption) {
      throw new Error(`Session encryption not found for ${sessionId}`);
    }

    const result = await this.emitWithAck('rpc-call', {
      method: `${sessionId}:${method}`,
      params: await sessionEncryption.encryptRaw(params),
    }, timeout);

    if (result.ok) {
      return await sessionEncryption.decryptRaw(result.result) as R;
    }
    throw new Error(`RPC call failed for ${sessionId}:${method}`);
  }

  /**
     * RPC call for machines - uses legacy/global encryption (for now)
     */
  async machineRPC<R, A>(machineId: string, method: string, params: A, timeout?: number): Promise<R> {
    const machineEncryption = this.encryption!.getMachineEncryption(machineId);
    if (!machineEncryption) {
      throw new Error(`Machine encryption not found for ${machineId}`);
    }

    const result = await this.emitWithAck('rpc-call', {
      method: `${machineId}:${method}`,
      params: await machineEncryption.encryptRaw(params),
    }, timeout);

    if (result.ok) {
      return await machineEncryption.decryptRaw(result.result) as R;
    }
    throw new Error(`RPC call failed for ${machineId}:${method}`);
  }

  send(event: string, data: any) {
        this.socket!.emit(event, data);
        return true;
  }

  async emitWithAck<T = any>(event: string, data: any, timeout?: number): Promise<T> {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }

    // If no timeout specified, use original behavior for backwards compatibility
    if (timeout === undefined) {
      return await this.socket.emitWithAck(event, data);
    }

    // Enhanced timeout handling only when timeout is explicitly specified
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Socket operation timeout after ${timeout}ms for event: ${event}`));
      }, timeout);
    });

    try {
      // Race between the actual operation and timeout
      const result = await Promise.race([
        this.socket.emitWithAck(event, data),
        timeoutPromise,
      ]);

      return result;
    } catch (error) {
      // Add context to error
      if (error instanceof Error) {
        error.message = `Socket operation failed for event '${event}': ${error.message}`;
      }
      throw error;
    }
  }

  //
  // HTTP Requests
  //

  async request(path: string, options?: RequestInit): Promise<Response> {
    if (!this.config) {
      throw new Error('SyncSocket not initialized');
    }

    const credentials = await TokenStorage.getCredentials();
    if (!credentials) {
      throw new Error('No authentication credentials');
    }

    const url = `${this.config.endpoint}${path}`;
    const headers = {
      'Authorization': `Bearer ${credentials.token}`,
      ...options?.headers,
    };

    // Use original fetch behavior for backwards compatibility
    return fetch(url, {
      ...options,
      headers,
    });
  }

  // Enhanced request method with timeout handling - opt-in usage
  async requestWithTimeout(path: string, options?: RequestInit & RequestOptions): Promise<Response> {
    if (!this.config) {
      throw new Error('SyncSocket not initialized');
    }

    const credentials = await TokenStorage.getCredentials();
    if (!credentials) {
      throw new Error('No authentication credentials');
    }

    const url = `${this.config.endpoint}${path}`;
    const headers = {
      'Authorization': `Bearer ${credentials.token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    };

    // Extract timeout-specific options
    const { timeout, retries, skipRetry, ...fetchOptions } = options || {};

    const requestOptions: RequestOptions = {
      ...fetchOptions,
      headers,
      timeout: timeout || 30000, // Default 30 seconds for API requests
      retries: retries || 2,      // Default 2 retries
      skipRetry,
    };

    return connectionTimeoutHandler.requestWithTimeout<Response>(url, requestOptions);
  }

  //
  // Connection Health API
  //

  isSocketConnected(): boolean {
    return this.socket?.connected || false;
  }

  getSocketInstance() {
    return this.socket;
  }

  addStatusListener(listener: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  }

  //
  // Token Management
  //

  updateToken(newToken: string) {
    if (this.config && this.config.token !== newToken) {
      this.config.token = newToken;

      if (this.socket) {
        this.disconnect();
        this.connect();
      }
    }
  }

  //
  // Private Methods
  //

  private updateStatus(status: 'disconnected' | 'connecting' | 'connected' | 'error') {
    if (this.currentStatus !== status) {
      this.currentStatus = status;
      this.statusListeners.forEach(listener => listener(status));
    }
  }

  private setupEventHandlers() {
    if (!this.socket) return;

    // Connection events
    this.socket.on('connect', () => {
      // console.log('🔌 SyncSocket: Connected, recovered: ' + this.socket?.recovered);
      // console.log('🔌 SyncSocket: Socket ID:', this.socket?.id);
      this.updateStatus('connected');
      if (!this.socket?.recovered) {
        this.reconnectedListeners.forEach(listener => listener());
      }
    });

    this.socket.on('disconnect', (reason) => {
      log.log(`🔌 SyncSocket: Disconnected - ${reason} (this may indicate shell/daemon crash)`);
      this.updateStatus('disconnected');
    });

    // Error events
    this.socket.on('connect_error', (error) => {
      log.log(`🔌 SyncSocket: Connection error - ${error.message || error}`);
      this.updateStatus('error');
    });

    this.socket.on('error', (error) => {
      log.log(`🔌 SyncSocket: Socket error - ${error.message || error}`);
      this.updateStatus('error');
    });

    // Message handling
    this.socket.onAny((event, data) => {
      // console.log(`📥 SyncSocket: Received event '${event}':`, JSON.stringify(data).substring(0, 200));
      const handler = this.messageHandlers.get(event);
      if (handler) {
        // console.log(`📥 SyncSocket: Calling handler for '${event}'`);
        handler(data);
      } else {
        // console.log(`📥 SyncSocket: No handler registered for '${event}'`);
      }
    });
  }
}

//
// Singleton Export
//

export const apiSocket = new ApiSocket();