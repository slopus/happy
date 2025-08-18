/**
 * WebSocket session with Happy server
 * Handles RPC for spawning sessions (machine already registered before connection)
 */

import { io, Socket } from 'socket.io-client';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { ServerToDaemonEvents, DaemonToServerEvents, TrackedSession } from './types';
import { encrypt, decrypt, encodeBase64, decodeBase64 } from '@/api/encryption';
import { ApiClient } from '@/api/api';
import { MachineMetadata } from '@/api/types';

export class DaemonHappyServerSession {
  private socket!: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private apiClient: ApiClient;
  private token: string;
  private secret: Uint8Array;

  constructor(
    credentials: { token: string; secret: Uint8Array },
    private machineId: string,
    private spawnSession: (directory: string, sessionId?: string) => Promise<TrackedSession | null>,
    private stopSession: (sessionId: string) => boolean,
    private requestShutdown: () => void
  ) {
    this.token = credentials.token;
    this.secret = credentials.secret;
    this.apiClient = new ApiClient(credentials.token, credentials.secret);
  }

  async updateMachineMetadata(updates: Partial<MachineMetadata>): Promise<void> {
    try {
      // First get the current machine state to get the version
      const currentMachine = await this.apiClient.getMachine(this.machineId);
      if (!currentMachine) {
        logger.debug('[SERVER SESSION][ERROR] Machine not found, will not be able to update metadata, skipping');
        return;
      }

      // Merge with existing metadata (already decrypted by ApiClient)
      const mergedMetadata = { ...currentMachine.metadata, ...updates };

      // Just emit the update - the server will handle it
      // We don't need to wait for response since this is best-effort
      this.socket.emit('machine-update-metadata', {
        machineId: this.machineId,
        metadata: encodeBase64(encrypt(mergedMetadata, this.secret)),
        expectedVersion: currentMachine.metadataVersion
      });

      logger.debug('[SERVER SESSION] Sent machine metadata update:', updates);
    } catch (error) {
      logger.debug('[SERVER SESSION] Failed to update metadata:', error);
    }
  }

  connect() {
    const serverUrl = configuration.serverUrl.replace(/^http/, 'ws');
    logger.debug(`[SERVER SESSION] Connecting to ${serverUrl}`);

    this.socket = io(serverUrl, {
      transports: ['websocket'],
      auth: {
        token: this.token,
        clientType: 'machine-scoped' as const,
        machineId: this.machineId
      },
      path: '/v1/updates',
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000
    });

    this.socket.on('connect', () => {
      logger.debug('[SERVER SESSION] Connected to server');

      // Define RPC method names
      const spawnMethod = `${this.machineId}:spawn-happy-session`;
      const stopMethod = `${this.machineId}:stop-session`;
      const stopDaemonMethod = `${this.machineId}:stop-daemon`;

      // Update daemon status to running
      this.updateMachineMetadata({
        daemonLastKnownStatus: 'running',
        daemonLastKnownPid: process.pid
      });

      // Register RPC methods
      this.socket.emit('rpc-register', { method: spawnMethod });
      this.socket.emit('rpc-register', { method: stopMethod });
      this.socket.emit('rpc-register', { method: stopDaemonMethod });
      logger.debug(`[SERVER SESSION] Registered RPC methods: ${spawnMethod}, ${stopMethod}, ${stopDaemonMethod}`);

      this.startKeepAlive();
    });

    // Single consolidated RPC handler
    this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
      logger.debugLargeJson(`[SERVER SESSION] Received RPC request:`, data);
      try {
        const spawnMethod = `${this.machineId}:spawn-happy-session`;
        const stopMethod = `${this.machineId}:stop-session`;
        const stopDaemonMethod = `${this.machineId}:stop-daemon`;

        if (data.method === spawnMethod) {
          const { directory, sessionId } = decrypt(decodeBase64(data.params), this.secret) || {};

          if (!directory) {
            throw new Error('Directory is required');
          }
          const session = await this.spawnSession(directory, sessionId);
          if (!session) {
            throw new Error('Failed to spawn session');
          }

          logger.debug(`[SERVER SESSION] Spawned session ${session.happySessionId || 'pending'} with PID ${session.pid}`);

          if (!session.happySessionId) {
            throw new Error(`Session spawned (PID ${session.pid}) but no sessionId received from webhook. The session process may still be initializing.`);
          }

          const response = { sessionId: session.happySessionId };
          logger.debug(`[SERVER SESSION] Sending RPC response:`, response);
          callback(encodeBase64(encrypt(response, this.secret)));
          return;
        }

        if (data.method === stopMethod) {
          logger.debug('[SERVER SESSION] Received stop-session RPC request');
          const decryptedParams = decrypt(decodeBase64(data.params), this.secret);
          const { sessionId } = decryptedParams || {};
          if (!sessionId) {
            throw new Error('Session ID is required');
          }
          const success = this.stopSession(sessionId);
          if (!success) {
            throw new Error('Session not found or failed to stop');
          }
          logger.debug(`[SERVER SESSION] Stopped session ${sessionId}`);
          const response = { message: 'Session stopped' };
          const encryptedResponse = encodeBase64(encrypt(response, this.secret));
          callback(encryptedResponse);
          return;
        }

        // Add stop-daemon handler
        if (data.method === stopDaemonMethod) {
          logger.debug('[SERVER SESSION] Received stop-daemon RPC request');

          // Send acknowledgment immediately
          callback(encodeBase64(encrypt({
            message: 'Daemon stop request acknowledged, starting shutdown sequence...'
          }, this.secret)));

          // Trigger shutdown callback
          setTimeout(() => {
            logger.debug('[SERVER SESSION] Initiating daemon shutdown from RPC');
            this.requestShutdown();
          }, 100);

          return;
        }

        throw new Error(`Unknown RPC method: ${data.method}`);
      } catch (error: any) {
        logger.debug(`[SERVER SESSION] RPC handler failed:`, error.message || error);
        logger.debug(`[SERVER SESSION] Error stack:`, error.stack);
        callback(encodeBase64(encrypt({ error: error.message || String(error) }, this.secret)));
      }
    });

    this.socket.on('disconnect', () => {
      logger.debug('[SERVER SESSION] Disconnected from server');
      this.stopKeepAlive();
    });

    this.socket.io.on('reconnect', () => {
      logger.debug('[SERVER SESSION] Reconnected to server');
      // Re-register RPC methods
      const spawnMethod = `${this.machineId}:spawn-happy-session`;
      const stopMethod = `${this.machineId}:stop-session`;
      const stopDaemonMethod = `${this.machineId}:stop-daemon`;
      this.socket.emit('rpc-register', { method: spawnMethod });
      this.socket.emit('rpc-register', { method: stopMethod });
      this.socket.emit('rpc-register', { method: stopDaemonMethod });
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
        machineId: this.machineId,
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