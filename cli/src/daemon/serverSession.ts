/**
 * WebSocket session with Happy server
 * Handles machine registration and RPC for spawning sessions
 */

import { io, Socket } from 'socket.io-client';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { encrypt, encodeBase64 } from '@/api/encryption';
import packageJson from '../../package.json';
import { MachineIdentity, MachineMetadata, ServerToDaemonEvents, DaemonToServerEvents, TrackedSession } from './types';

export class DaemonHappyServerSession {
  private socket!: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
  private token: string;
  private secret: Uint8Array;
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private machineRegistered = false;

  constructor(
    credentials: { token: string; secret: Uint8Array },
    private machineIdentity: MachineIdentity,
    private spawnSession: (directory: string, sessionId?: string) => TrackedSession | null,
    private stopSession: (sessionId: string) => boolean
  ) {
    this.token = credentials.token;
    this.secret = credentials.secret;
  }

  connect() {
    const serverUrl = configuration.serverUrl.replace(/^http/, 'ws');
    logger.debug(`[SERVER SESSION] Connecting to ${serverUrl}`);
    
    this.socket = io(serverUrl, {
      transports: ['websocket'],
      auth: { token: this.token },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000
    });

    this.socket.on('connect', () => {
      logger.debug('[SERVER SESSION] Connected to server');
      
      // Register machine
      if (!this.machineRegistered) {
        this.registerMachine();
      }
      
      // Register RPC method
      const rpcMethod = `${this.machineIdentity.machineId}:spawn-happy-session`;
      this.socket.emit('rpc-register', { method: rpcMethod });
      logger.debug(`[SERVER SESSION] Registered RPC method: ${rpcMethod}`);
      
      this.startKeepAlive();
    });

    // Handle spawn-happy-session RPC
    this.socket.on('rpc-request', async (data, callback) => {
      const expectedMethod = `${this.machineIdentity.machineId}:spawn-happy-session`;
      
      if (data.method === expectedMethod) {
        logger.debug('[SERVER SESSION] Received spawn-happy-session RPC request');
        
        try {
          const { directory, sessionId } = data.params || {};
          
          if (!directory) {
            throw new Error('Directory is required');
          }
          
          const session = this.spawnSession(directory, sessionId);
          
          if (!session) {
            throw new Error('Failed to spawn session');
          }
          
          logger.debug(`[SERVER SESSION] Spawned session with PID ${session.pid}`);
          
          // Return immediately
          callback({ ok: true, result: { message: 'Session spawning', pid: session.pid } });
          
        } catch (error: any) {
          logger.debug(`[SERVER SESSION] RPC spawn failed:`, error);
          callback({ ok: false, error: error.message });
        }
      }
    });

    // Handle stop-session RPC (if we add this in the future)
    this.socket.on('rpc-request', async (data, callback) => {
      const expectedMethod = `${this.machineIdentity.machineId}:stop-session`;
      
      if (data.method === expectedMethod) {
        logger.debug('[SERVER SESSION] Received stop-session RPC request');
        
        try {
          const { sessionId } = data.params || {};
          
          if (!sessionId) {
            throw new Error('Session ID is required');
          }
          
          const success = this.stopSession(sessionId);
          
          if (!success) {
            throw new Error('Session not found or failed to stop');
          }
          
          logger.debug(`[SERVER SESSION] Stopped session ${sessionId}`);
          callback({ ok: true, result: { message: 'Session stopped' } });
          
        } catch (error: any) {
          logger.debug(`[SERVER SESSION] RPC stop failed:`, error);
          callback({ ok: false, error: error.message });
        }
      }
    });

    this.socket.on('disconnect', () => {
      logger.debug('[SERVER SESSION] Disconnected from server');
      this.stopKeepAlive();
    });

    this.socket.io.on('reconnect', () => {
      logger.debug('[SERVER SESSION] Reconnected to server');
      // Re-register RPC method
      const rpcMethod = `${this.machineIdentity.machineId}:spawn-happy-session`;
      this.socket.emit('rpc-register', { method: rpcMethod });
    });

    this.socket.on('daemon-command', (data) => {
      logger.debug(`[SERVER SESSION] Received daemon command: ${data.command}`);
      switch (data.command) {
        case 'shutdown':
          logger.debug('[SERVER SESSION] Remote shutdown requested');
          this.shutdown();
          // Note: The daemon will handle the actual shutdown
          break;
        case 'status':
          logger.debug('[SERVER SESSION] Status request received');
          // Could emit status back if needed
          break;
      }
    });

    this.socket.on('connect_error', (error) => {
      logger.debug(`[SERVER SESSION] Connection error: ${error.message}`);
    });

    this.socket.io.on('error', (error: any) => {
      logger.debug('[SERVER SESSION] Socket error:', error);
    });
  }

  private async registerMachine() {
    try {
      const metadata: MachineMetadata = {
        host: this.machineIdentity.machineHost,
        platform: this.machineIdentity.platform,
        happyCliVersion: this.machineIdentity.happyCliVersion,
        happyHomeDirectory: this.machineIdentity.happyHomeDirectory
      };
      
      logger.debug('[SERVER SESSION] Registering machine with server');
      
      const encrypted = encrypt(JSON.stringify(metadata), this.secret);
      const encryptedMetadata = encodeBase64(encrypted);
      
      const response = await fetch(`${configuration.serverUrl}/v1/machines`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          id: this.machineIdentity.machineId,
          metadata: encryptedMetadata 
        })
      });
      
      if (response.ok) {
        logger.debug('[SERVER SESSION] Machine registered successfully');
        this.machineRegistered = true;
      } else {
        const errorText = await response.text();
        logger.debug(`[SERVER SESSION] Failed to register machine: ${response.status} - ${errorText}`);
      }
    } catch (error) {
      logger.debug('[SERVER SESSION] Failed to register machine:', error);
    }
  }

  private startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveInterval = setInterval(() => {
      const payload = {
        machineId: this.machineIdentity.machineId,
        time: Date.now()
      };
      logger.debugLargeJson(`[SERVER SESSION] Emitting machine-alive`, payload);
      this.socket.emit('machine-alive', payload);
    }, 20000);
    logger.debug('[SERVER SESSION] Keep-alive started (20s interval)');
  }

  private stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
      logger.debug('[SERVER SESSION] Keep-alive stopped');
    }
  }

  shutdown() {
    logger.debug('[SERVER SESSION] Shutting down');
    this.stopKeepAlive();
    if (this.socket) {
      this.socket.close();
      logger.debug('[SERVER SESSION] Socket closed');
    }
  }
}