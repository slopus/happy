import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import { configuration } from '@/configuration'
import { MachineIdentity, DaemonToServerEvents, ServerToDaemonEvents } from './types'
import { spawn } from 'child_process'
import crypto from 'crypto'

export class ApiDaemonSession extends EventEmitter {
  private socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
  private machineIdentity: MachineIdentity;
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private token: string;
  private secret: Uint8Array;
  private daemonHttpPort: number;
  private sessionCallbacks: Map<string, (sessionId: string) => void>;

  constructor(
    token: string, 
    secret: Uint8Array, 
    machineIdentity: MachineIdentity,
    daemonHttpPort: number,
    sessionCallbacks: Map<string, (sessionId: string) => void>
  ) {
    super();
    this.token = token;
    this.secret = secret;
    this.machineIdentity = machineIdentity;
    this.daemonHttpPort = daemonHttpPort;
    this.sessionCallbacks = sessionCallbacks;

    logger.daemonDebug(`Connecting to server: ${configuration.serverUrl}`);
    const socket = io(configuration.serverUrl, {
      auth: {
        token: this.token,
        clientType: 'machine-scoped' as const,
        machineId: this.machineIdentity.machineId
      },
      path: '/v1/updates',
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      transports: ['websocket'],
      withCredentials: true,
      autoConnect: false
    });

    socket.on('connect', () => {
      logger.daemonDebug('Socket connected');
      logger.daemonDebug(`Connected with auth - token: ${this.token.substring(0, 10)}..., machineId: ${this.machineIdentity.machineId}`);
      
      // Register RPC method with machineId prefix
      const rpcMethod = `${this.machineIdentity.machineId}:spawn-happy-session`;
      socket.emit('rpc-register', { method: rpcMethod });
      logger.daemonDebug(`Emitted RPC registration: ${rpcMethod}`);
      
      this.emit('connected');
      this.startKeepAlive();
    });
    
    // Register RPC handler
    socket.on('rpc-request', async (data, callback) => {
      logger.daemonDebug(`Received RPC request: ${JSON.stringify(data)}`);
      
      // We expect the method to be prefixed with machineId
      const expectedMethod = `${this.machineIdentity.machineId}:spawn-happy-session`;
      
      if (data.method === expectedMethod) {
        logger.daemonDebug('Processing spawn-happy-session RPC');
        try {
            const { directory } = data.params || {};
            
            if (!directory) {
              throw new Error('Directory is required');
            }
            
            // Platform check - daemon only works on macOS
            if (process.platform !== 'darwin') {
              throw new Error('Session spawning is only supported on macOS');
            }
            
            const nonce = crypto.randomBytes(16).toString('hex');
            
            // Setup callback promise
            const sessionPromise = new Promise<string>((resolve) => {
              this.sessionCallbacks.set(nonce, resolve);
              setTimeout(() => {
                this.sessionCallbacks.delete(nonce);
                resolve(''); // timeout
              }, 30000);
            });
            
            // Build command
            const args = [
              '--happy-starting-mode', 'remote',
              '--happy-daemon-port', String(this.daemonHttpPort),
              '--happy-daemon-new-session-nonce', nonce
            ];
            
            // Add --local if needed
            if (configuration.installationLocation === 'local') {
              args.push('--local');
            }
            
            // Spawn with AppleScript
            const script = `
              tell application "Terminal"
                activate
                do script "cd ${directory} && happy ${args.join(' ')}"
              end tell
            `;
            
            logger.daemonDebug(`Spawning happy in directory: ${directory}`);
            spawn('osascript', ['-e', script], { detached: true });
            
            // Wait for callback
            const sessionId = await sessionPromise;
            
            if (sessionId) {
              logger.daemonDebug(`Session spawned successfully: ${sessionId}`);
              callback({ ok: true, result: { sessionId } });
            } else {
              logger.daemonDebug('Timeout waiting for session callback');
              callback({ ok: false, error: 'Timeout waiting for session' });
            }
          } catch (error) {
            logger.daemonDebug('Error spawning session:', error);
            callback({ ok: false, error: error instanceof Error ? error.message : 'Unknown error' });
          }
        } else {
          logger.daemonDebug(`Unknown RPC method: ${data.method}`);
          callback({ ok: false, error: `Unknown method: ${data.method}` });
        }
      });

    socket.on('disconnect', (reason) => {
      logger.daemonDebug(`Disconnected from server. Reason: ${reason}`);
      this.emit('disconnected');
      this.stopKeepAlive();
    });
    
    socket.on('reconnect', () => {
      logger.daemonDebug('Reconnected to server');
      // Re-register RPC method after reconnection
      const rpcMethod = `${this.machineIdentity.machineId}:spawn-happy-session`;
      socket.emit('rpc-register', { method: rpcMethod });
      logger.daemonDebug(`Re-registered RPC method: ${rpcMethod}`);
    });
    
    socket.on('rpc-registered', (data) => {
      logger.daemonDebug(`RPC registration confirmed: ${data.method}`);
    });
    
    socket.on('rpc-unregistered', (data) => {
      logger.daemonDebug(`RPC unregistered: ${data.method}`);
    });
    
    socket.on('rpc-error', (data) => {
      logger.daemonDebug(`RPC error: ${JSON.stringify(data)}`);
    });
    
    // Debug: Log all events
    socket.onAny((event, ...args) => {
      if (!event.startsWith('machine-alive')) { // Don't log keep-alive
        logger.daemonDebug(`Socket event: ${event}, args: ${JSON.stringify(args)}`);
      }
    });
    
    socket.on('connect_error', (error) => {
      logger.daemonDebug(`Connection error: ${error.message}`);
      logger.daemonDebug(`Error type: ${error.type}`);
      logger.daemonDebug(`Error data: ${JSON.stringify(error.data)}`);
    });
    
    socket.on('error', (error) => {
      logger.daemonDebug(`Socket error: ${error}`);
    });


    socket.on('daemon-command', (data) => {
      switch (data.command) {
        case 'shutdown':
          this.shutdown();
          break;
        case 'status':
          this.emit('status-request');
          break;
      }
    });

    this.socket = socket;
  }

  private startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveInterval = setInterval(() => {
      logger.daemonDebug('Sending keep-alive ping');
      this.socket.volatile.emit('machine-alive', {
        time: Date.now()
      });
    }, 20000);
  }

  private stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  connect() {
    this.socket.connect();
  }

  shutdown() {
    this.stopKeepAlive();
    this.socket.close();
    this.emit('shutdown');
  }
}