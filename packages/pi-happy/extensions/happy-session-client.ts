import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import axios from 'axios';
import type { SessionEnvelope, Update, UserMessage } from '@slopus/happy-wire';
import { UserMessageSchema } from '@slopus/happy-wire';
import {
  decodeBase64,
  decrypt,
  decryptBoxBundle,
  encodeBase64,
  encrypt,
  getRandomBytes,
  libsodiumEncryptForPublicKey,
} from 'happy-agent/encryption';
import { io, type Socket } from 'socket.io-client';

import type { PiHappyCredentials } from './credentials';
import { createOfflineSessionStub, type HappySessionClientLike } from './offline-stub';
import { ConnectionState } from './types';
import { AsyncLock } from '../vendor/async-lock';
import { logger } from '../vendor/logger';
import { registerCommonHandlers } from '../vendor/register-common-handlers';
import { RpcHandlerManager } from '../vendor/rpc/handler-manager';
import { InvalidateSync } from '../vendor/invalidate-sync';
import { backoff, delay, exponentialBackoffDelay } from '../vendor/time';

export type HappySessionMetadata = {
  path?: string;
  lifecycleState?: string;
  lifecycleStateSince?: number;
  [key: string]: unknown;
};

export type HappySessionAgentState = {
  [key: string]: unknown;
};

export type HappySession = {
  id: string;
  seq?: number;
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: HappySessionMetadata;
  metadataVersion: number;
  agentState: HappySessionAgentState | null;
  agentStateVersion: number;
};

export type HappySessionClientConfig = {
  serverUrl: string;
  cwd?: string;
  onShutdown?: () => void | Promise<void>;
  onAbort?: () => void | Promise<void>;
  onSessionSwap?: (client: HappySessionClient) => void | Promise<void>;
  healthCheck?: () => Promise<void>;
  initialReconnectDelayMs?: number;
};

type V3SessionMessage = {
  id: string;
  seq: number;
  content: { t: 'encrypted'; c: string };
  localId: string | null;
  createdAt: number;
  updatedAt: number;
};

type V3GetSessionMessagesResponse = {
  messages: V3SessionMessage[];
  hasMore: boolean;
};

type V3PostSessionMessagesResponse = {
  messages: Array<{
    id: string;
    seq: number;
    localId: string | null;
    createdAt: number;
    updatedAt: number;
  }>;
};

type RawCreatedSession = {
  id: string;
  seq: number;
  metadata: string;
  metadataVersion: number;
  agentState: string | null;
  agentStateVersion: number;
};

type UpdateMetadataAck =
  | { result: 'error' }
  | { result: 'version-mismatch'; version: number; metadata: string }
  | { result: 'success'; version: number; metadata: string };

type UpdateStateAck =
  | { result: 'error' }
  | { result: 'version-mismatch'; version: number; agentState: string | null }
  | { result: 'success'; version: number; agentState: string | null };

type ServerToClientEvents = {
  update: (data: Update) => void;
  'rpc-request': (data: { method: string; params: string }, callback: (response: string) => void) => void;
  error: (data: { message: string }) => void;
};

type ClientToServerEvents = {
  'session-alive': (data: {
    sid: string;
    time: number;
    thinking: boolean;
    mode?: 'local' | 'remote';
  }) => void;
  'session-end': (data: { sid: string; time: number }) => void;
  'update-metadata': (data: { sid: string; expectedVersion: number; metadata: string }, cb: (answer: UpdateMetadataAck) => void) => void;
  'update-state': (data: { sid: string; expectedVersion: number; agentState: string | null }, cb: (answer: UpdateStateAck) => void) => void;
  'ping': (callback: () => void) => void;
  'rpc-register': (data: { method: string }) => void;
  'rpc-unregister': (data: { method: string }) => void;
};

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

function isHappySessionMetadata(value: unknown): value is HappySessionMetadata {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isHappySessionAgentState(value: unknown): value is HappySessionAgentState {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = 'code' in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && NETWORK_ERROR_CODES.has(code);
}

function isOfflineCreateError(error: unknown): boolean {
  if (isNetworkError(error)) {
    return true;
  }

  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return status === 404 || (typeof status === 'number' && status >= 500);
  }

  const status = (
    error &&
    typeof error === 'object' &&
    'response' in error &&
    (error as { response?: { status?: unknown } }).response?.status
  );
  return status === 404 || (typeof status === 'number' && status >= 500);
}

function isUnauthorizedError(error: unknown): boolean {
  if (axios.isAxiosError(error)) {
    return error.response?.status === 401;
  }

  const status = (
    error &&
    typeof error === 'object' &&
    'response' in error &&
    (error as { response?: { status?: unknown } }).response?.status
  );
  return status === 401;
}

function buildDataEncryptionKey(publicKey: Uint8Array, sessionKey: Uint8Array): Uint8Array {
  const encryptedKey = libsodiumEncryptForPublicKey(sessionKey, publicKey);
  const withVersion = new Uint8Array(1 + encryptedKey.length);
  withVersion[0] = 0x00;
  withVersion.set(encryptedKey, 1);
  return withVersion;
}

function decryptCreatedMetadata(
  encryptionKey: Uint8Array,
  encryptionVariant: 'legacy' | 'dataKey',
  metadata: string,
  fallback: HappySessionMetadata,
): HappySessionMetadata {
  const decrypted = decrypt(encryptionKey, encryptionVariant, decodeBase64(metadata));
  return isHappySessionMetadata(decrypted) ? decrypted : fallback;
}

function decryptCreatedAgentState(
  encryptionKey: Uint8Array,
  encryptionVariant: 'legacy' | 'dataKey',
  agentState: string | null,
  fallback: HappySessionAgentState | null,
): HappySessionAgentState | null {
  if (!agentState) {
    return null;
  }

  const decrypted = decrypt(encryptionKey, encryptionVariant, decodeBase64(agentState));
  return isHappySessionAgentState(decrypted) ? decrypted : fallback;
}

export class HappySessionClient extends EventEmitter implements HappySessionClientLike {
  private static readonly MAX_OUTBOX_BATCH_SIZE = 50;

  private readonly credentials: PiHappyCredentials;
  private readonly serverUrl: string;
  readonly sessionId: string;
  private metadata: HappySessionMetadata;
  private metadataVersion: number;
  private agentState: HappySessionAgentState | null;
  private agentStateVersion: number;
  private readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  readonly rpcHandlerManager: RpcHandlerManager;
  private readonly encryptionKey: Uint8Array;
  private readonly encryptionVariant: 'legacy' | 'dataKey';
  private readonly sendSync: InvalidateSync;
  private readonly receiveSync: InvalidateSync;
  private readonly metadataLock = new AsyncLock();
  private readonly agentStateLock = new AsyncLock();
  private pendingMessages: UserMessage[] = [];
  private pendingMessageCallback: ((message: UserMessage) => void) | null = null;
  private pendingOutbox: Array<{ content: string; localId: string }> = [];
  private lastSeq = 0;
  private connectionState = ConnectionState.Disconnected;

  constructor(
    credentials: PiHappyCredentials,
    serverUrl: string,
    session: HappySession,
    options: Omit<HappySessionClientConfig, 'serverUrl' | 'onSessionSwap' | 'healthCheck' | 'initialReconnectDelayMs'> = {},
  ) {
    super();

    this.credentials = credentials;
    this.serverUrl = serverUrl;
    this.sessionId = session.id;
    this.metadata = session.metadata;
    this.metadataVersion = session.metadataVersion;
    this.agentState = session.agentState;
    this.agentStateVersion = session.agentStateVersion;
    this.encryptionKey = session.encryptionKey;
    this.encryptionVariant = session.encryptionVariant;

    this.sendSync = new InvalidateSync(() => this.flushOutbox());
    this.receiveSync = new InvalidateSync(() => this.fetchMessages());

    this.rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: this.sessionId,
      encryptionKey: this.encryptionKey,
      encryptionVariant: this.encryptionVariant,
      logger: (message, data) => logger.debug(message, data),
    });

    const workingDirectory = options.cwd ?? (typeof session.metadata.path === 'string' ? session.metadata.path : process.cwd());
    registerCommonHandlers(this.rpcHandlerManager, workingDirectory);

    this.rpcHandlerManager.registerHandler('killSession', async () => {
      await options.onShutdown?.();
      return { success: true };
    });

    this.rpcHandlerManager.registerHandler('abort', async () => {
      await options.onAbort?.();
      return { success: true };
    });

    this.socket = io(this.serverUrl, {
      auth: {
        token: this.credentials.token,
        clientType: 'session-scoped' as const,
        sessionId: this.sessionId,
      },
      path: '/v1/updates',
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      transports: ['websocket'],
      withCredentials: true,
      autoConnect: false,
    });

    this.registerSocketHandlers();
    this.setConnectionState(ConnectionState.Connecting);
    this.socket.connect();
  }

  static async create(
    credentials: PiHappyCredentials,
    config: HappySessionClientConfig,
    tag: string,
    metadata: HappySessionMetadata,
    state: HappySessionAgentState | null,
  ): Promise<HappySessionClient | null> {
    let encryptionKey: Uint8Array;
    let encryptionVariant: 'legacy' | 'dataKey';
    let dataEncryptionKey: Uint8Array | null = null;

    if (credentials.encryption.type === 'dataKey') {
      encryptionKey = getRandomBytes(32);
      encryptionVariant = 'dataKey';
      dataEncryptionKey = buildDataEncryptionKey(credentials.encryption.publicKey, encryptionKey);
    } else {
      encryptionKey = credentials.encryption.secret;
      encryptionVariant = 'legacy';
    }

    try {
      const response = await axios.post<{ session: RawCreatedSession }>(
        `${config.serverUrl}/v1/sessions`,
        {
          tag,
          metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, metadata)),
          agentState: state ? encodeBase64(encrypt(encryptionKey, encryptionVariant, state)) : null,
          dataEncryptionKey: dataEncryptionKey ? encodeBase64(dataEncryptionKey) : null,
        },
        {
          headers: {
            Authorization: `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 60_000,
        },
      );

      const raw = response.data.session;
      const session: HappySession = {
        id: raw.id,
        seq: raw.seq,
        encryptionKey,
        encryptionVariant,
        metadata: decryptCreatedMetadata(encryptionKey, encryptionVariant, raw.metadata, metadata),
        metadataVersion: raw.metadataVersion,
        agentState: decryptCreatedAgentState(encryptionKey, encryptionVariant, raw.agentState, state),
        agentStateVersion: raw.agentStateVersion,
      };

      return new HappySessionClient(credentials, config.serverUrl, session, {
        cwd: config.cwd,
        onShutdown: config.onShutdown,
        onAbort: config.onAbort,
      });
    } catch (error) {
      logger.debug('[HappySessionClient] failed to create session', error);
      if (isOfflineCreateError(error)) {
        return null;
      }
      throw error;
    }
  }

  static async createWithOfflineFallback(
    credentials: PiHappyCredentials,
    config: HappySessionClientConfig,
    tag: string,
    metadata: HappySessionMetadata,
    state: HappySessionAgentState | null,
  ): Promise<HappySessionClientLike> {
    const onlineClient = await HappySessionClient.create(credentials, config, tag, metadata, state);
    if (onlineClient) {
      return onlineClient;
    }

    const offlineStub = createOfflineSessionStub(tag, metadata, state);

    const reconnect = async (): Promise<void> => {
      try {
        const recovered = await HappySessionClient.create(
          credentials,
          config,
          tag,
          offlineStub.getMetadata(),
          offlineStub.getAgentState(),
        );
        if (!recovered) {
          throw new Error('Session creation still offline');
        }

        if (offlineStub.isClosed()) {
          await recovered.close();
          return;
        }

        offlineStub.attachLiveClient(recovered);

        if (config.onSessionSwap) {
          try {
            await config.onSessionSwap(recovered);
          } catch (error) {
            logger.warn('[HappySessionClient] onSessionSwap failed after offline recovery', error);
            offlineStub.emit('error', error);
          }
        }
      } catch (error) {
        if (isUnauthorizedError(error)) {
          logger.warn('[HappySessionClient] offline reconnection stopped due to authorization failure');
          return;
        }
        throw error;
      }
    };

    const healthCheck = config.healthCheck ?? (async () => {
      await axios.get(`${config.serverUrl}/v1/sessions`, {
        timeout: 5_000,
        validateStatus: status => status < 500,
      });
    });

    let cancelled = false;
    let failureCount = 0;
    let timeoutId: NodeJS.Timeout | null = null;

    const scheduleNext = (delayMs: number): void => {
      timeoutId = setTimeout(() => {
        void attemptReconnect();
      }, delayMs);
    };

    const attemptReconnect = async (): Promise<void> => {
      if (cancelled || offlineStub.isClosed() || offlineStub.isReconnected()) {
        return;
      }

      try {
        await healthCheck();
        if (cancelled || offlineStub.isClosed() || offlineStub.isReconnected()) {
          return;
        }
        await reconnect();
      } catch (error) {
        if (cancelled || offlineStub.isClosed() || offlineStub.isReconnected()) {
          return;
        }
        if (isUnauthorizedError(error)) {
          logger.warn('[HappySessionClient] offline reconnection stopped after unauthorized response');
          return;
        }
        failureCount += 1;
        const backoffDelay = exponentialBackoffDelay(failureCount, 5_000, 60_000, 10);
        logger.debug(`[HappySessionClient] offline reconnect attempt ${failureCount} failed; retrying in ${backoffDelay}ms`, error);
        scheduleNext(backoffDelay);
      }
    };

    scheduleNext(config.initialReconnectDelayMs ?? 5_000);
    offlineStub.attachCancellation(() => {
      cancelled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    });

    return offlineStub;
  }

  getMetadata(): HappySessionMetadata {
    return this.metadata;
  }

  getAgentState(): HappySessionAgentState | null {
    return this.agentState;
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  onUserMessage(callback: (message: UserMessage) => void): void {
    this.pendingMessageCallback = callback;
    while (this.pendingMessages.length > 0) {
      callback(this.pendingMessages.shift()!);
    }
  }

  sendSessionProtocolMessage(envelope: SessionEnvelope): void {
    this.enqueueMessage({
      role: 'session',
      content: envelope,
      meta: {
        sentFrom: 'cli',
      },
    });
  }

  keepAlive(thinking: boolean, mode?: 'local' | 'remote'): void {
    this.socket.volatile.emit('session-alive', {
      sid: this.sessionId,
      time: Date.now(),
      thinking,
      mode,
    });
  }

  sendSessionDeath(): void {
    this.socket.emit('session-end', { sid: this.sessionId, time: Date.now() });
  }

  async updateMetadata(handler: (metadata: HappySessionMetadata) => HappySessionMetadata): Promise<void> {
    await this.metadataLock.inLock(async () => {
      await backoff(async () => {
        const updated = handler(this.metadata);
        const answer = await this.socket.emitWithAck('update-metadata', {
          sid: this.sessionId,
          expectedVersion: this.metadataVersion,
          metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)),
        }) as UpdateMetadataAck;

        if (answer.result === 'success') {
          this.metadata = decryptCreatedMetadata(this.encryptionKey, this.encryptionVariant, answer.metadata, updated);
          this.metadataVersion = answer.version;
          return;
        }

        if (answer.result === 'version-mismatch') {
          if (answer.version > this.metadataVersion) {
            this.metadataVersion = answer.version;
            this.metadata = decryptCreatedMetadata(this.encryptionKey, this.encryptionVariant, answer.metadata, this.metadata);
          }
          throw new Error('Metadata version mismatch');
        }
      });
    });
  }

  async updateAgentState(
    handler: (agentState: HappySessionAgentState | null) => HappySessionAgentState | null,
  ): Promise<void> {
    await this.agentStateLock.inLock(async () => {
      await backoff(async () => {
        const updated = handler(this.agentState);
        const answer = await this.socket.emitWithAck('update-state', {
          sid: this.sessionId,
          expectedVersion: this.agentStateVersion,
          agentState: updated ? encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) : null,
        }) as UpdateStateAck;

        if (answer.result === 'success') {
          this.agentState = decryptCreatedAgentState(this.encryptionKey, this.encryptionVariant, answer.agentState, updated);
          this.agentStateVersion = answer.version;
          return;
        }

        if (answer.result === 'version-mismatch') {
          if (answer.version > this.agentStateVersion) {
            this.agentStateVersion = answer.version;
            this.agentState = decryptCreatedAgentState(this.encryptionKey, this.encryptionVariant, answer.agentState, this.agentState);
          }
          throw new Error('Agent state version mismatch');
        }
      });
    });
  }

  async updateLifecycleState(state: string): Promise<void> {
    await this.updateMetadata(metadata => ({
      ...metadata,
      lifecycleState: state,
      lifecycleStateSince: Date.now(),
    }));
  }

  async flush(): Promise<void> {
    await Promise.race([
      this.sendSync.invalidateAndAwait(),
      delay(10_000),
    ]);

    if (!this.socket.connected) {
      return;
    }

    await new Promise<void>(resolve => {
      this.socket.emit('ping', () => {
        resolve();
      });
      setTimeout(resolve, 10_000);
    });
  }

  async close(): Promise<void> {
    this.sendSync.stop();
    this.receiveSync.stop();
    this.socket.close();
    this.setConnectionState(ConnectionState.Disconnected);
  }

  private registerSocketHandlers(): void {
    this.socket.on('connect', () => {
      logger.debug('[HappySessionClient] socket connected');
      this.rpcHandlerManager.onSocketConnect(this.socket);
      this.setConnectionState(ConnectionState.Connected);
      this.receiveSync.invalidate();
    });

    this.socket.on('rpc-request', async (data, callback) => {
      callback(await this.rpcHandlerManager.handleRequest(data));
    });

    this.socket.on('disconnect', reason => {
      logger.debug('[HappySessionClient] socket disconnected', reason);
      this.rpcHandlerManager.onSocketDisconnect();
      this.setConnectionState(ConnectionState.Disconnected);
    });

    this.socket.on('connect_error', error => {
      logger.debug('[HappySessionClient] socket connect_error', error);
      this.rpcHandlerManager.onSocketDisconnect();
      this.setConnectionState(ConnectionState.Disconnected);
      this.emit('error', error);
    });

    this.socket.on('update', data => {
      try {
        if (!data.body) {
          return;
        }

        if (data.body.t === 'new-message') {
          const messageSeq = data.body.message?.seq;
          if (this.lastSeq === 0) {
            this.receiveSync.invalidate();
            return;
          }
          if (
            typeof messageSeq !== 'number' ||
            messageSeq !== this.lastSeq + 1 ||
            data.body.message.content.t !== 'encrypted'
          ) {
            this.receiveSync.invalidate();
            return;
          }
          const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.message.content.c));
          this.routeIncomingMessage(body);
          this.lastSeq = messageSeq;
          return;
        }

        if (data.body.t === 'update-session') {
          if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
            this.metadata = decryptCreatedMetadata(
              this.encryptionKey,
              this.encryptionVariant,
              data.body.metadata.value,
              this.metadata,
            );
            this.metadataVersion = data.body.metadata.version;
          }
          if (data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
            this.agentState = decryptCreatedAgentState(
              this.encryptionKey,
              this.encryptionVariant,
              data.body.agentState.value,
              this.agentState,
            );
            this.agentStateVersion = data.body.agentState.version;
          }
          return;
        }

        this.emit('message', data.body);
      } catch (error) {
        logger.debug('[HappySessionClient] failed to handle update', error);
      }
    });

    this.socket.on('error', data => {
      this.emit('error', data);
    });

    if ('io' in this.socket && this.socket.io && typeof this.socket.io.on === 'function') {
      this.socket.io.on('reconnect_attempt', () => {
        this.setConnectionState(ConnectionState.Connecting);
      });
    }
  }

  private setConnectionState(state: ConnectionState): void {
    if (this.connectionState === state) {
      return;
    }
    this.connectionState = state;
    this.emit('connectionState', state);
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.credentials.token}`,
      'Content-Type': 'application/json',
    };
  }

  private routeIncomingMessage(message: unknown): void {
    const userResult = UserMessageSchema.safeParse(message);
    if (userResult.success) {
      if (this.pendingMessageCallback) {
        this.pendingMessageCallback(userResult.data);
      } else {
        this.pendingMessages.push(userResult.data);
      }
      return;
    }

    this.emit('message', message);
  }

  private async fetchMessages(): Promise<void> {
    let afterSeq = this.lastSeq;

    while (true) {
      const response = await axios.get<V3GetSessionMessagesResponse>(
        `${this.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`,
        {
          params: {
            after_seq: afterSeq,
            limit: 100,
          },
          headers: this.authHeaders(),
          timeout: 60_000,
        },
      );

      const messages = Array.isArray(response.data.messages) ? response.data.messages : [];
      let maxSeq = afterSeq;

      for (const message of messages) {
        if (message.seq > maxSeq) {
          maxSeq = message.seq;
        }

        if (message.content?.t !== 'encrypted') {
          continue;
        }

        try {
          const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(message.content.c));
          this.routeIncomingMessage(body);
        } catch (error) {
          logger.debug('[HappySessionClient] failed to decrypt fetched message', {
            sessionId: this.sessionId,
            seq: message.seq,
            error,
          });
        }
      }

      this.lastSeq = Math.max(this.lastSeq, maxSeq);
      const hasMore = !!response.data.hasMore;
      if (hasMore && maxSeq === afterSeq) {
        break;
      }
      afterSeq = maxSeq;
      if (!hasMore) {
        break;
      }
    }
  }

  private async flushOutbox(): Promise<void> {
    while (this.pendingOutbox.length > 0) {
      const batchSize = Math.min(this.pendingOutbox.length, HappySessionClient.MAX_OUTBOX_BATCH_SIZE);
      const batch = this.pendingOutbox.splice(-batchSize, batchSize);

      const response = await axios.post<V3PostSessionMessagesResponse>(
        `${this.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`,
        { messages: batch },
        {
          headers: this.authHeaders(),
          timeout: 60_000,
        },
      );

      const messages = Array.isArray(response.data.messages) ? response.data.messages : [];
      const maxSeq = messages.reduce((highest, message) => Math.max(highest, message.seq), this.lastSeq);
      this.lastSeq = maxSeq;
    }
  }

  private enqueueMessage(content: unknown, invalidate: boolean = true): void {
    const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
    this.pendingOutbox.push({
      content: encrypted,
      localId: randomUUID(),
    });

    if (invalidate) {
      this.sendSync.invalidate();
    }
  }
}

export function decryptSessionDataKey(bundleBase64: string, secretKey: Uint8Array): Uint8Array | null {
  const decoded = decodeBase64(bundleBase64);
  return decryptBoxBundle(decoded.slice(1), secretKey);
}
