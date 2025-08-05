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
  private spawnedProcesses: Set<any> = new Set();

  constructor(
    token: string, 
    secret: Uint8Array, 
    machineIdentity: MachineIdentity
  ) {
    super();
    this.token = token;
    this.secret = secret;
    this.machineIdentity = machineIdentity;

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
            
            // Build command arguments
            const args = [
              '--daemon-spawn',
              '--happy-starting-mode', 'remote'  // ALWAYS force remote mode for daemon spawns
            ];
            
            // Add --local if needed
            if (configuration.installationLocation === 'local') {
              args.push('--local');
            }
            
            // Add server URL if not default
            if (configuration.serverUrl !== 'https://handy-api.korshakov.org') {
              args.push('--happy-server-url', configuration.serverUrl);
            }
            
            logger.daemonDebug(`Spawning happy in directory: ${directory} with args: ${args.join(' ')}`);
            
            // TODO: In the future, we should disable local mode entirely for daemon-spawned sessions
            // For now, we force remote mode since interactive mode requires a terminal
            
            // Determine the happy executable path
            const happyPath = process.argv[1]; // Path to the CLI script
            const isTypeScript = happyPath.endsWith('.ts');
            
            // Spawn the process
            const happyProcess = isTypeScript
              ? spawn('npx', ['tsx', happyPath, ...args], {
                  cwd: directory,
                  env: { ...process.env, EXPERIMENTAL_FEATURES: '1' },
                  detached: true,
                  stdio: ['ignore', 'pipe', 'pipe'] // We need stdout
                })
              : spawn(process.argv[0], [happyPath, ...args], {
                  cwd: directory,
                  env: { ...process.env, EXPERIMENTAL_FEATURES: '1' },
                  detached: true,
                  stdio: ['ignore', 'pipe', 'pipe'] // We need stdout
                });
            
            // Track this process
            this.spawnedProcesses.add(happyProcess);
            
            let sessionId: string | null = null;
            let output = '';
            let timeoutId: NodeJS.Timeout | null = null;
            
            // Cleanup function to remove listeners and timeout
            const cleanup = () => {
              happyProcess.stdout.removeAllListeners('data');
              happyProcess.stderr.removeAllListeners('data');
              happyProcess.removeAllListeners('error');
              happyProcess.removeAllListeners('exit');
              if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
              }
            };
            
            // Parse stdout for session ID
            happyProcess.stdout.on('data', (data) => {
              output += data.toString();
              const match = output.match(/daemon:sessionIdCreated:(.+?)[\n\r]/);
              if (match && !sessionId) {
                sessionId = match[1];
                logger.daemonDebug(`Session spawned successfully: ${sessionId}`);
                callback({ sessionId });
                
                // Stop listening to this process but keep it tracked
                cleanup();
                
                // Detach the process
                happyProcess.unref();
              }
            });
            
            // Log stderr for debugging
            happyProcess.stderr.on('data', (data) => {
              logger.daemonDebug(`Spawned process stderr: ${data.toString()}`);
            });
            
            // Handle errors
            happyProcess.on('error', (error) => {
              logger.daemonDebug('Error spawning session:', error);
              if (!sessionId) {
                callback({ error: `Failed to spawn: ${error.message}` });
                cleanup();
                this.spawnedProcesses.delete(happyProcess);
              }
            });
            
            // Clean up when process exits
            happyProcess.on('exit', (code, signal) => {
              logger.daemonDebug(`Spawned process exited with code ${code}, signal ${signal}`);
              this.spawnedProcesses.delete(happyProcess);
              if (!sessionId) {
                callback({ error: `Process exited before session ID received` });
                cleanup();
              }
            });
            
            // Timeout after 10 seconds
            timeoutId = setTimeout(() => {
              if (!sessionId) {
                logger.daemonDebug('Timeout waiting for session ID');
                callback({ error: 'Timeout waiting for session' });
                cleanup();
                happyProcess.kill();
                this.spawnedProcesses.delete(happyProcess);
              }
            }, 10000);
            
          } catch (error) {
            logger.daemonDebug('Error spawning session:', error);
            callback({ error: error instanceof Error ? error.message : 'Unknown error' });
          }
        } else {
          logger.daemonDebug(`Unknown RPC method: ${data.method}`);
          callback({ error: `Unknown method: ${data.method}` });
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
      logger.daemonDebug(`Error: ${JSON.stringify(error, null, 2)}`);
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
    logger.daemonDebug(`Shutting down daemon, killing ${this.spawnedProcesses.size} spawned processes`);
    
    // Kill all spawned processes
    for (const process of this.spawnedProcesses) {
      try {
        logger.daemonDebug(`Killing spawned process with PID: ${process.pid}`);
        process.kill('SIGTERM');
        // Give it a moment to terminate gracefully
        setTimeout(() => {
          try {
            process.kill('SIGKILL');
          } catch (e) {
            // Process might already be dead
          }
        }, 1000);
      } catch (error) {
        logger.daemonDebug(`Error killing process: ${error}`);
      }
    }
    this.spawnedProcesses.clear();
    
    this.stopKeepAlive();
    this.socket.close();
    this.emit('shutdown');
  }
}