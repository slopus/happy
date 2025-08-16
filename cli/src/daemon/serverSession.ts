/**
 * WebSocket session with Happy server
 * Handles RPC for spawning sessions (machine already registered before connection)
 */

import { io, Socket } from 'socket.io-client';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { MachineIdentity, ServerToDaemonEvents, DaemonToServerEvents, TrackedSession } from './types';

export class DaemonHappyServerSession {
  private socket!: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
  private token: string;
  private secret: Uint8Array;
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private readonly spawnMethod: string;
  private readonly stopMethod: string;

  constructor(
    credentials: { token: string; secret: Uint8Array },
    private machineIdentity: MachineIdentity,
    private spawnSession: (directory: string, sessionId?: string) => Promise<TrackedSession | null>,
    private stopSession: (sessionId: string) => boolean
  ) {
    this.token = credentials.token;
    this.secret = credentials.secret;
    // Lift RPC method names to constructor level
    this.spawnMethod = `${this.machineIdentity.machineIdLocalAndDb}:spawn-happy-session`;
    this.stopMethod = `${this.machineIdentity.machineIdLocalAndDb}:stop-session`;
  }

  connect() {
    const serverUrl = configuration.serverUrl.replace(/^http/, 'ws');
    logger.debug(`[SERVER SESSION] Connecting to ${serverUrl}`);
    
    this.socket = io(serverUrl, {
      transports: ['websocket'],
      auth: { token: this.token },
      path: '/v1/updates',
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000
    });

    this.socket.on('connect', () => {
      logger.debug('[SERVER SESSION] Connected to server');
      
      // Machine already registered before connection
      // Just register RPC methods
      this.socket.emit('rpc-register', { method: this.spawnMethod });
      this.socket.emit('rpc-register', { method: this.stopMethod });
      logger.debug(`[SERVER SESSION] Registered RPC methods: ${this.spawnMethod}, ${this.stopMethod}`);
      
      this.startKeepAlive();
    });

    // Single consolidated RPC handler
    this.socket.on('rpc-request', async (data, callback) => {
      if (data.method === this.spawnMethod) {
        logger.debug('[SERVER SESSION] Received spawn-happy-session RPC request');
        
        try {
          const { directory, sessionId } = data.params || {};
          
          if (!directory) {
            throw new Error('Directory is required');
          }
          
          const session = await this.spawnSession(directory, sessionId);
          
          if (!session) {
            throw new Error('Failed to spawn session');
          }
          
          logger.debug(`[SERVER SESSION] Spawned session ${session.happySessionId || 'pending'} with PID ${session.pid}`);
          const response = { 
            ok: true, 
            result: { 
              message: 'Session spawned successfully', 
              pid: session.pid,
              sessionId: session.happySessionId
            } 
          };
          logger.debug(`[SERVER SESSION] Sending RPC response:`, response);
          callback(response);
          
        } catch (error: any) {
          logger.debug(`[SERVER SESSION] RPC spawn failed:`, error);
          callback({ ok: false, error: error.message });
        }
      } else if (data.method === this.stopMethod) {
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
      // Re-register RPC methods
      this.socket.emit('rpc-register', { method: this.spawnMethod });
      this.socket.emit('rpc-register', { method: this.stopMethod });
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

  private startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveInterval = setInterval(() => {
      const payload = {
        machineId: this.machineIdentity.machineIdLocalAndDb,
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