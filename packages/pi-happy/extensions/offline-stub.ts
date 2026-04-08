import { EventEmitter } from 'node:events';

import type { SessionEnvelope, UserMessage } from '@slopus/happy-wire';

import { ConnectionState } from './types';
import type { HappySessionAgentState, HappySessionMetadata } from './happy-session-client';

export interface HappySessionClientLike {
  readonly sessionId: string;
  readonly rpcHandlerManager: {
    registerHandler: (method: string, handler: (data: unknown) => unknown | Promise<unknown>) => void;
    unregisterHandler?: (method: string) => void;
  };
  on(eventName: 'connectionState', listener: (state: ConnectionState) => void): this;
  on(eventName: 'message', listener: (message: unknown) => void): this;
  on(eventName: 'error', listener: (error: unknown) => void): this;
  getMetadata(): HappySessionMetadata;
  getAgentState(): HappySessionAgentState | null;
  getConnectionState(): ConnectionState;
  onUserMessage(callback: (message: UserMessage) => void): void;
  sendSessionProtocolMessage(envelope: SessionEnvelope): void;
  keepAlive(thinking: boolean, mode?: 'local' | 'remote'): void;
  sendSessionDeath(): void;
  updateMetadata(handler: (metadata: HappySessionMetadata) => HappySessionMetadata): Promise<void>;
  updateAgentState(handler: (agentState: HappySessionAgentState | null) => HappySessionAgentState | null): Promise<void>;
  updateLifecycleState(state: string): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export class OfflineHappySessionStub extends EventEmitter implements HappySessionClientLike {
  readonly rpcHandlerManager = {
    registerHandler: () => undefined,
    unregisterHandler: () => undefined,
  };

  private readonly offlineSessionId: string;
  private metadata: HappySessionMetadata;
  private agentState: HappySessionAgentState | null;
  private connectionState = ConnectionState.Offline;
  private cancelReconnection: (() => void) | null = null;
  private closed = false;
  private reconnected = false;
  private liveClient: HappySessionClientLike | null = null;
  private pendingUserMessageCallback: ((message: UserMessage) => void) | null = null;

  constructor(
    sessionTag: string,
    metadata: HappySessionMetadata,
    agentState: HappySessionAgentState | null = null,
  ) {
    super();
    this.offlineSessionId = `offline-${sessionTag}`;
    this.metadata = metadata;
    this.agentState = agentState;
  }

  get sessionId(): string {
    return this.liveClient?.sessionId ?? this.offlineSessionId;
  }

  getMetadata(): HappySessionMetadata {
    return this.liveClient?.getMetadata() ?? this.metadata;
  }

  getAgentState(): HappySessionAgentState | null {
    return this.liveClient?.getAgentState() ?? this.agentState;
  }

  getConnectionState(): ConnectionState {
    return this.liveClient?.getConnectionState() ?? this.connectionState;
  }

  onUserMessage(callback: (message: UserMessage) => void): void {
    this.pendingUserMessageCallback = callback;
    this.liveClient?.onUserMessage(callback);
  }

  sendSessionProtocolMessage(envelope: SessionEnvelope): void {
    this.liveClient?.sendSessionProtocolMessage(envelope);
  }

  keepAlive(thinking: boolean, mode?: 'local' | 'remote'): void {
    this.liveClient?.keepAlive(thinking, mode);
  }

  sendSessionDeath(): void {
    this.liveClient?.sendSessionDeath();
  }

  async updateMetadata(handler: (metadata: HappySessionMetadata) => HappySessionMetadata): Promise<void> {
    if (this.liveClient) {
      await this.liveClient.updateMetadata(handler);
      this.metadata = this.liveClient.getMetadata();
      return;
    }

    this.metadata = handler(this.metadata);
  }

  async updateAgentState(
    handler: (agentState: HappySessionAgentState | null) => HappySessionAgentState | null,
  ): Promise<void> {
    if (this.liveClient) {
      await this.liveClient.updateAgentState(handler);
      this.agentState = this.liveClient.getAgentState();
      return;
    }

    this.agentState = handler(this.agentState);
  }

  async updateLifecycleState(state: string): Promise<void> {
    if (this.liveClient) {
      await this.liveClient.updateLifecycleState(state);
      this.metadata = this.liveClient.getMetadata();
      return;
    }

    this.metadata = {
      ...this.metadata,
      lifecycleState: state,
      lifecycleStateSince: Date.now(),
    };
  }

  async flush(): Promise<void> {
    await this.liveClient?.flush();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelReconnection?.();
    await this.liveClient?.close();
  }

  attachCancellation(cancel: () => void): void {
    this.cancelReconnection = cancel;
  }

  attachLiveClient(client: HappySessionClientLike): void {
    if (this.liveClient || this.closed) {
      return;
    }

    this.liveClient = client;
    this.reconnected = true;

    if (this.pendingUserMessageCallback) {
      client.onUserMessage(this.pendingUserMessageCallback);
    }

    client.on('connectionState', state => {
      this.connectionState = state;
      this.emit('connectionState', state);
    });

    client.on('message', message => {
      this.emit('message', message);
    });

    client.on('error', error => {
      this.emit('error', error);
    });

    const currentState = client.getConnectionState();
    if (this.connectionState !== currentState) {
      this.connectionState = currentState;
      this.emit('connectionState', currentState);
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  isReconnected(): boolean {
    return this.reconnected;
  }
}

export function createOfflineSessionStub(
  sessionTag: string,
  metadata: HappySessionMetadata,
  agentState: HappySessionAgentState | null = null,
): OfflineHappySessionStub {
  return new OfflineHappySessionStub(sessionTag, metadata, agentState);
}
