import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import { configuration } from '@/configuration'
import { MachineIdentity, DaemonToServerEvents, ServerToDaemonEvents } from './daemonTypes'
import { spawn } from 'child_process'
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption'

export class ApiDaemonSession extends EventEmitter {
  private socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
  private machineIdentity: MachineIdentity;
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private token: string;
  private secret: Uint8Array;

  constructor(token: string, secret: Uint8Array, machineIdentity: MachineIdentity) {
    super();
    this.token = token;
    this.secret = secret;
    this.machineIdentity = machineIdentity;

    const socket = io(configuration.serverUrl, {
      auth: {
        token: this.token,
        clientType: 'machine-scoped' as const,
        machineId: this.machineIdentity.machineId
      },
      path: '/v1/user-machine-daemon',
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      transports: ['websocket'],
      withCredentials: true,
      autoConnect: false
    });

    socket.on('connect', () => {
      logger.debug('[DAEMON] Connected to server');
      this.emit('connected');
      socket.emit('machine-connect', {
        token: this.token,
        machineIdentity: encodeBase64(encrypt(this.machineIdentity, this.secret))
      });
      this.startKeepAlive();
    });

    socket.on('disconnect', () => {
      logger.debug('[DAEMON] Disconnected from server');
      this.emit('disconnected');
      this.stopKeepAlive();
    });

    socket.on('spawn-session', async (encryptedData, callback) => {
      let requestData: any;
      try {
        requestData = decrypt(decodeBase64(encryptedData), this.secret);
        logger.debug('[DAEMON] Received spawn-session request', requestData);
        const args = [
          '--directory', requestData.directory,
          '--happy-starting-mode', requestData.startingMode
        ];

        if (requestData.metadata) {
          args.push('--metadata', requestData.metadata);
        }

        if (requestData.startingMode === 'interactive' && process.platform === 'darwin') {
          const script = `
            tell application "Terminal"
              activate
              do script "cd ${requestData.directory} && happy ${args.join(' ')}"
            end tell
          `;
          spawn('osascript', ['-e', script], { detached: true });
        } else {
          const child = spawn('happy', args, {
            detached: true,
            stdio: 'ignore',
            cwd: requestData.directory
          });
          child.unref();
        }

        const result = { success: true };
        socket.emit('session-spawn-result', {
          requestId: requestData.requestId,
          result: encodeBase64(encrypt(result, this.secret))
        });

        callback(encodeBase64(encrypt({ success: true }, this.secret)));
      } catch (error) {
        logger.debug('[DAEMON] Failed to spawn session', error);
        const errorResult = {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
        socket.emit('session-spawn-result', {
          requestId: requestData?.requestId || '',
          result: encodeBase64(encrypt(errorResult, this.secret))
        });
        callback(encodeBase64(encrypt(errorResult, this.secret)));
      }
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