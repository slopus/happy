/**
 * OpenClaw Gateway WebSocket Client
 *
 * Implements the OpenClaw gateway protocol (v3) for Node.js.
 * Ported from expo-app/sources/clawdbot/ClawdbotSocket.ts.
 *
 * NOT a singleton — instantiated per backend.
 */

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import {
  loadOrCreateDeviceIdentity,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
  buildDeviceAuthPayload,
  signPayload,
} from './openclawAuth';
import type {
  OpenClawGatewayConfig,
  OpenClawFrame,
  OpenClawConnectParams,
  OpenClawHelloOk,
  OpenClawSession,
  OpenClawChatMessage,
  OpenClawChatHistoryResult,
  OpenClawSessionsListResult,
  OpenClawChatSendResult,
  OpenClawClientId,
  OpenClawClientMode,
} from './openclawTypes';

const PROTOCOL_VERSION = 3;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type OpenClawConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'pairing_required' | 'error';

export type OpenClawEventHandler = (event: string, payload: unknown) => void;
export type OpenClawStatusHandler = (
  status: OpenClawConnectionStatus,
  error?: string,
  details?: { pairingRequestId?: string },
) => void;

export interface OpenClawSocketOptions {
  homeDir: string;
  clientId?: OpenClawClientId;
  clientMode?: OpenClawClientMode;
  displayName?: string;
  log?: (msg: string) => void;
}

export class OpenClawSocket {
  private ws: WebSocket | null = null;
  private config: OpenClawGatewayConfig | null = null;
  private pending = new Map<string, PendingRequest>();
  private status: OpenClawConnectionStatus = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private mainSessionKey: string | null = null;
  private serverHost: string | null = null;
  private pairingRequestId: string | null = null;
  private deviceId: string | null = null;
  private connectNonce: string | null = null;
  private connectSent = false;
  private disposed = false;

  private statusListeners = new Set<OpenClawStatusHandler>();
  private eventListeners = new Set<OpenClawEventHandler>();

  private readonly options: Required<OpenClawSocketOptions>;

  constructor(options: OpenClawSocketOptions) {
    this.options = {
      homeDir: options.homeDir,
      clientId: options.clientId ?? 'node-host',
      clientMode: options.clientMode ?? 'backend',
      displayName: options.displayName ?? 'Happy CLI',
      log: options.log ?? (() => {}),
    };
  }

  getStatus(): OpenClawConnectionStatus {
    return this.status;
  }

  getMainSessionKey(): string | null {
    return this.mainSessionKey;
  }

  getServerHost(): string | null {
    return this.serverHost;
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  getDeviceId(): string | null {
    return this.deviceId;
  }

  getPairingRequestId(): string | null {
    return this.pairingRequestId;
  }

  connect(config: OpenClawGatewayConfig): void {
    this.config = config;
    this.pairingRequestId = null;
    this.doConnect();
  }

  disconnect(): void {
    this.config = null;
    this.clearReconnectTimer();
    this.closeSocket();
    this.updateStatus('disconnected');
    this.mainSessionKey = null;
    this.serverHost = null;
    this.pairingRequestId = null;
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.statusListeners.clear();
    this.eventListeners.clear();
  }

  retryConnect(): void {
    if (this.config) {
      this.pairingRequestId = null;
      this.doConnect();
    }
  }

  onStatusChange(handler: OpenClawStatusHandler): () => void {
    this.statusListeners.add(handler);
    handler(this.status, undefined, { pairingRequestId: this.pairingRequestId ?? undefined });
    return () => this.statusListeners.delete(handler);
  }

  onEvent(handler: OpenClawEventHandler): () => void {
    this.eventListeners.add(handler);
    return () => this.eventListeners.delete(handler);
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs = 15000): Promise<T> {
    if (!this.ws || this.status !== 'connected') {
      throw new Error('Not connected to gateway');
    }

    const id = randomUUID();
    const frame = { type: 'req', id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.ws!.send(JSON.stringify(frame));
    });
  }

  async listSessions(limit?: number): Promise<OpenClawSession[]> {
    const result = await this.request<OpenClawSessionsListResult>('sessions.list', {
      includeGlobal: true,
      includeUnknown: false,
      limit,
    });
    return result.sessions ?? [];
  }

  async listAgents(): Promise<unknown[]> {
    try {
      const result = await this.request<{ agents?: unknown[] }>('agents.list');
      return (result as { agents?: unknown[] }).agents ?? [];
    } catch {
      return [];
    }
  }

  async getHistory(sessionKey: string): Promise<OpenClawChatMessage[]> {
    const result = await this.request<OpenClawChatHistoryResult>('chat.history', { sessionKey });
    return result.messages ?? [];
  }

  async sendMessage(
    sessionKey: string,
    message: string,
    options?: { thinking?: string; attachments?: unknown[] },
  ): Promise<OpenClawChatSendResult> {
    return this.request<OpenClawChatSendResult>(
      'chat.send',
      {
        sessionKey,
        message,
        thinking: options?.thinking ?? 'low',
        attachments: options?.attachments,
        timeoutMs: 30000,
        idempotencyKey: randomUUID(),
      },
      35000,
    );
  }

  async abortRun(sessionKey: string, runId?: string): Promise<void> {
    await this.request('chat.abort', { sessionKey, runId }, 10000);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.request<{ ok?: boolean }>('health', undefined, 5000);
      return result.ok !== false;
    } catch {
      return false;
    }
  }

  // ─── Private ─────────────────────────────────────────────────

  private doConnect(): void {
    if (!this.config || this.disposed) return;

    this.updateStatus('connecting');
    this.closeSocket();
    this.connectNonce = null;
    this.connectSent = false;

    const url = this.config.url;
    this.options.log(`Connecting to gateway: ${url}`);

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.options.log(`Failed to create WebSocket: ${err}`);
      this.updateStatus('error', 'Failed to create connection');
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.options.log('WebSocket opened, waiting for challenge...');
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data.toString());
    });

    this.ws.on('error', (err) => {
      this.options.log(`WebSocket error: ${err.message}`);
      if (this.status === 'connecting') {
        this.updateStatus('error', 'Connection failed');
      }
    });

    this.ws.on('close', (code, reason) => {
      this.options.log(`WebSocket closed: ${code} ${reason.toString()}`);
      this.failAllPending(new Error('Connection closed'));
      if (this.config && this.status !== 'pairing_required' && !this.disposed) {
        this.scheduleReconnect();
      }
    });
  }

  private async sendConnect(): Promise<void> {
    if (!this.ws || !this.config || this.connectSent) return;
    this.connectSent = true;

    try {
      const identity = await loadOrCreateDeviceIdentity(this.options.homeDir);
      this.deviceId = identity.deviceId;
      this.options.log(`Using device ID: ${identity.deviceId.slice(0, 16)}...`);

      const storedToken = await loadDeviceAuthToken(this.options.homeDir);
      const clientId = this.options.clientId;
      const clientMode = this.options.clientMode;
      const role = 'operator';
      const scopes = ['operator.admin', 'operator.approvals', 'operator.pairing'];
      const signedAtMs = Date.now();
      const authToken = this.config.token ?? storedToken?.token ?? undefined;

      const payload = buildDeviceAuthPayload({
        deviceId: identity.deviceId,
        clientId,
        clientMode,
        role,
        scopes,
        signedAtMs,
        token: authToken ?? null,
        nonce: this.connectNonce!,
      });
      const signature = await signPayload(identity.privateKey, payload);

      const params: OpenClawConnectParams = {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: clientId,
          displayName: this.options.displayName,
          version: '1.0.0',
          platform: os.platform(),
          mode: clientMode,
        },
        role,
        scopes,
        device: {
          id: identity.deviceId,
          publicKey: identity.publicKey,
          signature,
          signedAt: signedAtMs,
          nonce: this.connectNonce ?? undefined,
        },
        auth: authToken ? { token: authToken } : this.config.password ? { password: this.config.password } : undefined,
      };

      const id = randomUUID();
      const frame = { type: 'req', id, method: 'connect', params };

      const resultPromise = new Promise<OpenClawHelloOk>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('Connect timeout'));
        }, 10000);

        this.pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value as OpenClawHelloOk);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
      });

      this.ws!.send(JSON.stringify(frame));
      const result = await resultPromise;

      if (result.auth?.deviceToken) {
        this.options.log('Storing device auth token');
        await storeDeviceAuthToken(this.options.homeDir, {
          token: result.auth.deviceToken,
          role: result.auth.role ?? role,
          scopes: result.auth.scopes ?? scopes,
        });
      }

      this.mainSessionKey = result.snapshot?.sessionDefaults?.mainSessionKey ?? null;
      this.serverHost = result.server?.host ?? null;
      this.updateStatus('connected');
      this.options.log(`Connected! Server: ${this.serverHost}, Main session: ${this.mainSessionKey}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '';
      this.options.log(`Connect failed: ${errorMsg}`);

      if (errorMsg.includes('NOT_PAIRED')) {
        const match = errorMsg.match(/requestId['":\s]+([a-f0-9-]+)/i);
        this.pairingRequestId = match?.[1] ?? null;
        this.updateStatus('pairing_required', 'Device pairing required', {
          pairingRequestId: this.pairingRequestId ?? undefined,
        });
        this.closeSocket();
        return;
      }

      this.updateStatus('error', error instanceof Error ? error.message : 'Connect failed');
      this.closeSocket();
      this.scheduleReconnect();
    }
  }

  private handleMessage(data: string): void {
    let frame: OpenClawFrame;
    try {
      frame = JSON.parse(data);
    } catch {
      this.options.log(`Invalid JSON: ${data.slice(0, 100)}`);
      return;
    }

    if (frame.type === 'res') {
      const pending = this.pending.get(frame.id);
      if (pending) {
        this.pending.delete(frame.id);
        if (frame.ok) {
          pending.resolve(frame.payload);
        } else {
          const err = frame.error;
          pending.reject(new Error(`${err?.code ?? 'ERROR'}: ${err?.message ?? 'Request failed'}`));
        }
      }
    } else if (frame.type === 'event') {
      let payload = frame.payload;
      if (!payload && frame.payloadJSON) {
        try {
          payload = JSON.parse(frame.payloadJSON);
        } catch {
          // ignore
        }
      }

      if (frame.event === 'connect.challenge' && !this.connectSent) {
        const nonce = (payload as { nonce?: string } | undefined)?.nonce;
        if (!nonce) {
          this.options.log('Gateway sent challenge without nonce — unsupported protocol');
          this.updateStatus('error', 'Gateway challenge missing nonce');
          this.closeSocket();
          return;
        }
        this.options.log(`Received challenge nonce: ${nonce.slice(0, 8)}...`);
        this.connectNonce = nonce;
        this.sendConnect();
        return;
      }

      for (const handler of this.eventListeners) {
        handler(frame.event, payload);
      }
    }
  }

  private updateStatus(status: OpenClawConnectionStatus, error?: string, details?: { pairingRequestId?: string }): void {
    this.status = status;
    for (const handler of this.statusListeners) {
      handler(status, error, details);
    }
  }

  private closeSocket(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (!this.config || this.disposed) return;
    this.clearReconnectTimer();
    this.updateStatus('disconnected');
    this.reconnectTimer = setTimeout(() => this.doConnect(), 3000);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
