/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import { io, Socket } from 'socket.io-client';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import { TrackedSession } from '@/daemon/api/types';
import { encrypt, decrypt, encodeBase64, decodeBase64 } from './encryption';
import { backoff } from '@/utils/time';


interface ServerToDaemonEvents {
  update: (data: Update) => void;
  'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void;
  'rpc-registered': (data: { method: string }) => void;
  'rpc-unregistered': (data: { method: string }) => void;
  'rpc-error': (data: { type: string, error: string }) => void;
  auth: (data: { success: boolean, user: string }) => void;
  error: (data: { message: string }) => void;
}

interface DaemonToServerEvents {
  'machine-alive': (data: {
    machineId: string;
    time: number;
  }) => void;

  'machine-update-metadata': (data: {
    machineId: string;
    metadata: string; // Encrypted MachineMetadata
    expectedVersion: number
  }, cb: (answer: {
    result: 'error'
  } | {
    result: 'version-mismatch'
    version: number,
    metadata: string
  } | {
    result: 'success',
    version: number,
    metadata: string
  }) => void) => void;

  'machine-update-state': (data: {
    machineId: string;
    daemonState: string; // Encrypted DaemonState
    expectedVersion: number
  }, cb: (answer: {
    result: 'error'
  } | {
    result: 'version-mismatch'
    version: number,
    daemonState: string
  } | {
    result: 'success',
    version: number,
    daemonState: string
  }) => void) => void;

  'rpc-register': (data: { method: string }) => void;
  'rpc-unregister': (data: { method: string }) => void;
  'rpc-call': (data: { method: string, params: any }, callback: (response: {
    ok: boolean
    result?: any
    error?: string
  }) => void) => void;
}

type MachineRpcHandlers = {
  spawnSession: (directory: string, sessionId?: string) => Promise<TrackedSession | null>;
  stopSession: (sessionId: string) => boolean;
  requestShutdown: () => void;
}

export class ApiMachineClient {
  private socket!: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
  private keepAliveInterval: NodeJS.Timeout | null = null;

  // RPC handlers
  private spawnSession?: (directory: string, sessionId?: string) => Promise<TrackedSession | null>;
  private stopSession?: (sessionId: string) => boolean;
  private requestShutdown?: () => void;

  constructor(
    private token: string,
    private secret: Uint8Array,
    private machine: Machine
  ) { }

  setRPCHandlers({
    spawnSession,
    stopSession,
    requestShutdown
  }: MachineRpcHandlers) {
    this.spawnSession = spawnSession;
    this.stopSession = stopSession;
    this.requestShutdown = requestShutdown;
  }

  /**
   * Update machine metadata
   * Currently unused, changes from the mobile client are more likely
   * for example to set a custom name.
   */
  async updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> {
    await backoff(async () => {
      const updated = handler(this.machine.metadata);

      const answer = await this.socket.emitWithAck('machine-update-metadata', {
        machineId: this.machine.id,
        metadata: encodeBase64(encrypt(updated, this.secret)),
        expectedVersion: this.machine.metadataVersion
      });

      if (answer.result === 'success') {
        this.machine.metadata = decrypt(decodeBase64(answer.metadata), this.secret);
        this.machine.metadataVersion = answer.version;
        logger.debug('[API MACHINE] Metadata updated successfully');
      } else if (answer.result === 'version-mismatch') {
        if (answer.version > this.machine.metadataVersion) {
          this.machine.metadataVersion = answer.version;
          this.machine.metadata = decrypt(decodeBase64(answer.metadata), this.secret);
        }
        throw new Error('Metadata version mismatch'); // Triggers retry
      }
    });
  }

  /**
   * Update daemon state (runtime info) - similar to session updateAgentState
   * Simplified without lock - relies on backoff for retry
   */
  async updateDaemonState(handler: (state: DaemonState | null) => DaemonState): Promise<void> {
    await backoff(async () => {
      const updated = handler(this.machine.daemonState);

      const answer = await this.socket.emitWithAck('machine-update-state', {
        machineId: this.machine.id,
        daemonState: encodeBase64(encrypt(updated, this.secret)),
        expectedVersion: this.machine.daemonStateVersion
      });

      if (answer.result === 'success') {
        this.machine.daemonState = decrypt(decodeBase64(answer.daemonState), this.secret);
        this.machine.daemonStateVersion = answer.version;
        logger.debug('[API MACHINE] Daemon state updated successfully');
      } else if (answer.result === 'version-mismatch') {
        if (answer.version > this.machine.daemonStateVersion) {
          this.machine.daemonStateVersion = answer.version;
          this.machine.daemonState = decrypt(decodeBase64(answer.daemonState), this.secret);
        }
        throw new Error('Daemon state version mismatch'); // Triggers retry
      }
    });
  }

  connect() {
    const serverUrl = configuration.serverUrl.replace(/^http/, 'ws');
    logger.debug(`[API MACHINE] Connecting to ${serverUrl}`);

    this.socket = io(serverUrl, {
      transports: ['websocket'],
      auth: {
        token: this.token,
        clientType: 'machine-scoped' as const,
        machineId: this.machine.id
      },
      path: '/v1/updates',
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000
    });

    // Define RPC method names
    const spawnMethod = `${this.machine.id}:spawn-happy-session`;
    const stopMethod = `${this.machine.id}:stop-session`;
    const stopDaemonMethod = `${this.machine.id}:stop-daemon`;

    this.socket.on('connect', () => {
      logger.debug('[API MACHINE] Connected to server');

      // Update daemon state to running
      // We need to override previous state because the daemon (this process)
      // has restarted with new PID & port
      this.updateDaemonState((state) => ({
        ...state,
        status: 'running',
        pid: process.pid,
        httpPort: this.machine.daemonState?.httpPort,
        startedAt: Date.now()
      }));

      // Register RPC methods
      this.socket.emit('rpc-register', { method: spawnMethod });
      this.socket.emit('rpc-register', { method: stopMethod });
      this.socket.emit('rpc-register', { method: stopDaemonMethod });
      logger.debug(`[API MACHINE] Registered RPC methods: ${spawnMethod}, ${stopMethod}, ${stopDaemonMethod}`);

      this.startKeepAlive();
    });

    // Single consolidated RPC handler
    this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
      logger.debugLargeJson(`[API MACHINE] Received RPC request:`, data);
      try {
        const spawnMethod = `${this.machine.id}:spawn-happy-session`;
        const stopMethod = `${this.machine.id}:stop-session`;
        const stopDaemonMethod = `${this.machine.id}:stop-daemon`;

        if (data.method === spawnMethod) {
          if (!this.spawnSession) {
            throw new Error('Spawn session handler not set');
          }

          const { directory, sessionId } = decrypt(decodeBase64(data.params), this.secret) || {};

          if (!directory) {
            throw new Error('Directory is required');
          }
          const session = await this.spawnSession(directory, sessionId);
          if (!session) {
            throw new Error('Failed to spawn session');
          }

          // Check if session has an error (e.g., directory creation failed)
          if (session.error) {
            throw new Error(session.error);
          }

          logger.debug(`[API MACHINE] Spawned session ${session.happySessionId || 'WARNING - not session Id recieved in webhook'} with PID ${session.pid}`);

          if (!session.happySessionId) {
            throw new Error(`Session spawned (PID ${session.pid}) but no sessionId received from webhook. The session process may still be initializing.`);
          }

          const response = { 
            sessionId: session.happySessionId,
            message: session.message 
          };
          logger.debug(`[API MACHINE] Sending RPC response:`, response);
          callback(encodeBase64(encrypt(response, this.secret)));
          return;
        }

        if (data.method === stopMethod) {
          logger.debug('[API MACHINE] Received stop-session RPC request');
          const decryptedParams = decrypt(decodeBase64(data.params), this.secret);
          const { sessionId } = decryptedParams || {};
          if (!this.stopSession) {
            throw new Error('Stop session handler not set');
          }

          if (!sessionId) {
            throw new Error('Session ID is required');
          }
          const success = this.stopSession(sessionId);
          if (!success) {
            throw new Error('Session not found or failed to stop');
          }
          logger.debug(`[API MACHINE] Stopped session ${sessionId}`);
          const response = { message: 'Session stopped' };
          const encryptedResponse = encodeBase64(encrypt(response, this.secret));
          callback(encryptedResponse);
          return;
        }

        // Add stop-daemon handler
        if (data.method === stopDaemonMethod) {
          logger.debug('[API MACHINE] Received stop-daemon RPC request');

          // Send acknowledgment immediately
          callback(encodeBase64(encrypt({
            message: 'Daemon stop request acknowledged, starting shutdown sequence...'
          }, this.secret)));

          // Trigger shutdown callback
          setTimeout(() => {
            logger.debug('[API MACHINE] Initiating daemon shutdown from RPC');
            if (this.requestShutdown) {
              this.requestShutdown();
            }
          }, 100);

          return;
        }

        throw new Error(`Unknown RPC method: ${data.method}`);
      } catch (error: any) {
        logger.debug(`[API MACHINE] RPC handler failed:`, error.message || error);
        logger.debug(`[API MACHINE] Error stack:`, error.stack);
        callback(encodeBase64(encrypt({ error: error.message || String(error) }, this.secret)));
      }
    });

    // Handle update events from server
    this.socket.on('update', (data: Update) => {
      // Machine clients should only care about machine updates
      if (data.body.t === 'update-machine' && (data.body as UpdateMachineBody).machineId === this.machine.id) {
        // Handle machine metadata or daemon state updates from other clients (e.g., mobile app)
        const update = data.body as UpdateMachineBody;

        if (update.metadata) {
          logger.debug('[API MACHINE] Received external metadata update');
          this.machine.metadata = decrypt(decodeBase64(update.metadata.value), this.secret);
          this.machine.metadataVersion = update.metadata.version;
        }

        if (update.daemonState) {
          logger.debug('[API MACHINE] Received external daemon state update');
          this.machine.daemonState = decrypt(decodeBase64(update.daemonState.value), this.secret);
          this.machine.daemonStateVersion = update.daemonState.version;
        }
      } else {
        logger.debug(`[API MACHINE] Received unknown update type: ${(data.body as any).t}`);
      }
    });

    this.socket.on('disconnect', () => {
      logger.debug('[API MACHINE] Disconnected from server');
      this.stopKeepAlive();
    });

    this.socket.io.on('reconnect', () => {
      logger.debug('[API MACHINE] Reconnected to server');
      this.socket.emit('rpc-register', { method: spawnMethod });
      this.socket.emit('rpc-register', { method: stopMethod });
      this.socket.emit('rpc-register', { method: stopDaemonMethod });
    });

    this.socket.on('connect_error', (error) => {
      logger.debug(`[API MACHINE] Connection error: ${error.message}`);
    });

    this.socket.io.on('error', (error: any) => {
      logger.debug('[API MACHINE] Socket error:', error);
    });
  }

  private startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveInterval = setInterval(() => {
      const payload = {
        machineId: this.machine.id,
        time: Date.now()
      };
      if (process.env.DEBUG) { // too verbose for production
        logger.debugLargeJson(`[API MACHINE] Emitting machine-alive`, payload);
      }
      this.socket.emit('machine-alive', payload);
    }, 20000);
    logger.debug('[API MACHINE] Keep-alive started (20s interval)');
  }

  private stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
      logger.debug('[API MACHINE] Keep-alive stopped');
    }
  }

  shutdown() {
    logger.debug('[API MACHINE] Shutting down');
    this.stopKeepAlive();
    if (this.socket) {
      this.socket.close();
      logger.debug('[API MACHINE] Socket closed');
    }
  }
}