/**
 * OpenClaw AgentBackend Implementation
 *
 * Custom AgentBackend that connects to an OpenClaw gateway via WebSocket.
 * Unlike ACP-based backends, OpenClaw uses its own protocol, so this is
 * a direct implementation rather than wrapping AcpBackend.
 *
 * Message mapping from OpenClaw chat events → AgentMessage:
 *   started  → { type: 'status', status: 'running' }
 *   delta    → { type: 'model-output', textDelta }
 *   thinking → { type: 'event', name: 'thinking', payload: { text, streaming: true } }
 *   tool     → { type: 'tool-call', toolName, args, callId }
 *   final    → { type: 'status', status: 'idle' }
 *   error    → { type: 'status', status: 'error', detail }
 */

import { randomUUID } from 'node:crypto';
import { OpenClawSocket, type OpenClawConnectionStatus, type OpenClawSocketOptions } from './OpenClawSocket';
import type { OpenClawGatewayConfig, OpenClawChatMessage } from './openclawTypes';
import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId, StartSessionResult } from '@/agent/core/AgentBackend';

interface OpenClawChatEventPayload {
  runId: string;
  sessionKey: string;
  seq: number;
  state: 'started' | 'thinking' | 'delta' | 'tool' | 'final' | 'error';
  message?: OpenClawChatMessage;
  delta?: string;
  errorMessage?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolCallId?: string;
}

export interface OpenClawBackendOptions {
  homeDir: string;
  gatewayConfig: OpenClawGatewayConfig;
  clientId?: OpenClawSocketOptions['clientId'];
  clientMode?: OpenClawSocketOptions['clientMode'];
  displayName?: string;
  log?: (msg: string) => void;
}

function extractTextFromMessage(message?: OpenClawChatMessage): string {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('');
  }
  return '';
}

export class OpenClawBackend implements AgentBackend {
  private socket: OpenClawSocket;
  private gatewayConfig: OpenClawGatewayConfig;
  private handlers = new Set<AgentMessageHandler>();
  private sessionKey: string | null = null;
  private lastDeltaText: string | null = null;
  private log: (msg: string) => void;

  /** Resolves when the socket reaches 'connected' status */
  private connectionReady: Promise<void> | null = null;
  private connectionResolve: (() => void) | null = null;
  private connectionReject: ((err: Error) => void) | null = null;

  /** Resolves when the current turn (prompt → idle) finishes */
  private turnReady: Promise<void> | null = null;
  private turnResolve: (() => void) | null = null;
  private turnReject: ((err: Error) => void) | null = null;

  constructor(opts: OpenClawBackendOptions) {
    this.log = opts.log ?? (() => {});
    this.gatewayConfig = opts.gatewayConfig;
    this.socket = new OpenClawSocket({
      homeDir: opts.homeDir,
      clientId: opts.clientId,
      clientMode: opts.clientMode,
      displayName: opts.displayName,
      log: opts.log,
    });

    this.socket.onStatusChange((status, error, details) => {
      this.handleStatusChange(status, error, details);
    });

    this.socket.onEvent((event, payload) => {
      this.handleEvent(event, payload);
    });
  }

  async startSession(): Promise<StartSessionResult> {
    this.connectionReady = new Promise<void>((resolve, reject) => {
      this.connectionResolve = resolve;
      this.connectionReject = reject;
    });

    this.socket.connect(this.gatewayConfig);
    await this.connectionReady;

    this.sessionKey = this.socket.getMainSessionKey();
    if (!this.sessionKey) {
      throw new Error('No main session key from gateway');
    }

    const sessionId = this.sessionKey;
    this.log(`Session started: ${sessionId}`);
    return { sessionId };
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    if (!this.socket.isConnected()) {
      throw new Error('Not connected to OpenClaw gateway');
    }

    this.lastDeltaText = null;

    this.turnReady = new Promise<void>((resolve, reject) => {
      this.turnResolve = resolve;
      this.turnReject = reject;
    });

    this.emit({ type: 'status', status: 'running' });

    const result = await this.socket.sendMessage(sessionId, prompt);
    this.log(`Sent prompt, runId: ${result.runId}`);
  }

  async cancel(_sessionId: SessionId): Promise<void> {
    if (this.sessionKey) {
      await this.socket.abortRun(this.sessionKey);
    }
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.add(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers.delete(handler);
  }

  async waitForResponseComplete(timeoutMs = 120000): Promise<void> {
    if (!this.turnReady) return;

    const timeout = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('OpenClaw turn timed out')), timeoutMs);
    });
    await Promise.race([this.turnReady, timeout]);
  }

  async dispose(): Promise<void> {
    this.socket.dispose();
    this.handlers.clear();
  }

  getDeviceId(): string | null {
    return this.socket.getDeviceId();
  }

  getPairingRequestId(): string | null {
    return this.socket.getPairingRequestId();
  }

  retryConnect(): void {
    this.socket.retryConnect();
  }

  private emit(msg: AgentMessage): void {
    for (const handler of this.handlers) {
      handler(msg);
    }
  }

  private handleStatusChange(
    status: OpenClawConnectionStatus,
    error?: string,
    details?: { pairingRequestId?: string },
  ): void {
    if (status === 'connected') {
      this.connectionResolve?.();
      this.connectionResolve = null;
      this.connectionReject = null;
    } else if (status === 'error') {
      const err = new Error(`OpenClaw connection error: ${error ?? 'unknown'}`);
      this.connectionReject?.(err);
      this.connectionResolve = null;
      this.connectionReject = null;
      this.emit({ type: 'status', status: 'error', detail: error });
    } else if (status === 'pairing_required') {
      const err = new Error('Device pairing required');
      this.connectionReject?.(err);
      this.connectionResolve = null;
      this.connectionReject = null;
      this.emit({
        type: 'event',
        name: 'openclaw-pairing-required',
        payload: {
          pairingRequestId: details?.pairingRequestId ?? null,
          deviceId: this.socket.getDeviceId(),
        },
      });
    } else if (status === 'disconnected') {
      this.emit({ type: 'status', status: 'stopped' });
    }
  }

  private handleEvent(event: string, payload: unknown): void {
    if (event !== 'chat') return;

    const chatEvent = payload as OpenClawChatEventPayload;
    const state = chatEvent.state;

    if (state === 'started') {
      this.emit({ type: 'status', status: 'running' });
      return;
    }

    if (state === 'thinking') {
      const text = extractTextFromMessage(chatEvent.message);
      if (text) {
        this.emit({ type: 'event', name: 'thinking', payload: { text, streaming: true } });
      }
      return;
    }

    if (state === 'delta') {
      const text = extractTextFromMessage(chatEvent.message);
      if (text) {
        // Compute incremental delta: gateway sends cumulative text in delta events
        const incrementalDelta = this.lastDeltaText !== null
          ? text.slice(this.lastDeltaText.length)
          : text;
        this.lastDeltaText = text;
        if (incrementalDelta) {
          this.emit({ type: 'model-output', textDelta: incrementalDelta });
        }
      }
      return;
    }

    if (state === 'tool') {
      const toolName = chatEvent.toolName ?? 'unknown';
      const args = chatEvent.toolArgs ?? {};
      const callId = chatEvent.toolCallId ?? randomUUID();
      this.emit({ type: 'tool-call', toolName, args, callId });
      return;
    }

    if (state === 'final') {
      // The final event carries the complete message text; emit any remaining delta
      const text = extractTextFromMessage(chatEvent.message);
      if (text) {
        const remaining = this.lastDeltaText !== null
          ? text.slice(this.lastDeltaText.length)
          : text;
        if (remaining) {
          this.emit({ type: 'model-output', textDelta: remaining });
        }
      }
      this.lastDeltaText = null;
      this.emit({ type: 'status', status: 'idle' });
      this.turnResolve?.();
      this.turnResolve = null;
      this.turnReject = null;
      return;
    }

    if (state === 'error') {
      const detail = chatEvent.errorMessage ?? 'Unknown error';
      this.emit({ type: 'status', status: 'error', detail });
      this.turnReject?.(new Error(detail));
      this.turnResolve = null;
      this.turnReject = null;
      return;
    }
  }
}
