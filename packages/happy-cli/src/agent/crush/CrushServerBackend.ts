/**
 * Crush Server Backend - Crush agent via HTTP server API
 *
 * This module provides a backend implementation that communicates with
 * the Crush server (`crush server`, v0.80+ wire protocol) over HTTP.
 * Crush exposes a REST API under /v1 with SSE streaming for events.
 *
 * API endpoints used (all accept/require ?client_id=<uuid>):
 * - POST /v1/workspaces - Create workspace for the working directory
 * - POST /v1/workspaces/{id}/agent/init - Initialize agent
 * - POST /v1/workspaces/{id}/sessions - Create session
 * - POST /v1/workspaces/{id}/agent - Send prompt (fire-and-forget, 202)
 * - GET  /v1/workspaces/{id}/events - SSE event stream
 * - POST /v1/workspaces/{id}/agent/sessions/{sid}/cancel - Cancel run
 * - POST /v1/workspaces/{id}/permissions/grant - Answer permission request
 *
 * SSE events arrive as a two-layer envelope:
 *   { type: <payload-type>, payload: { type: 'created'|'updated', payload: <inner> } }
 *
 * The server is spawned on a per-session Unix domain socket; Windows is
 * not supported (throwing early instead of silently misbehaving).
 *
 * @module CrushServerBackend
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import http from 'node:http';
import type { RequestOptions } from 'node:http';
import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
  McpServerConfig,
} from '../core';
import { logger } from '@/ui/logger';

/**
 * Configuration for CrushServerBackend
 */
export interface CrushServerBackendOptions {
  /** Agent name for identification */
  agentName: string;

  /** Working directory for the agent */
  cwd: string;

  /** Environment variables to pass to the agent */
  env?: Record<string, string>;

  /** MCP servers (currently unused by the Crush server API) */
  mcpServers?: Record<string, McpServerConfig>;

  /** Custom crush binary path (defaults to 'crush') */
  command?: string;

  /** Extra arguments to pass to `crush server` */
  extraArgs?: string[];
}

/** Session info returned by the Crush server */
interface CrushSession {
  id: string;
  title?: string;
}

/** SSE envelope: outer { type } wrapping an inner { type, payload } notification */
export interface CrushEvent {
  type: string;
  payload?: {
    type?: string;
    payload?: unknown;
  };
  [key: string]: unknown;
}

/** A content part of a Crush message (see crush internal/proto/message.go) */
interface CrushPart {
  type?: string;
  data?: unknown;
}

/** A Crush chat message */
interface CrushMessage {
  id?: string;
  role?: string;
  parts?: CrushPart[];
}

/** Crush run_complete payload */
interface CrushRunComplete {
  session_id?: string;
  message_id?: string;
  text?: string;
  error?: string;
  cancelled?: boolean;
}

/** Crush agent_event payload */
interface CrushAgentEvent {
  type?: string;
  message?: { text?: string };
  session_id?: string;
}

/** Crush permission_request payload (see crush internal/proto/permission.go) */
interface CrushPermissionRequest {
  id?: string;
  session_id?: string;
  tool_call_id?: string;
  tool_name?: string;
  description?: string;
  action?: string;
  params?: unknown;
  path?: string;
}

/** Read a nested object field from an unknown value. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** Read a string field from a record. */
function str(source: Record<string, unknown> | null, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Concatenate the text of all text parts of a Crush message. */
function messageText(message: CrushMessage): string {
  let text = '';
  for (const part of message.parts ?? []) {
    if (part.type === 'text') {
      const data = asRecord(part.data);
      const chunk = data && typeof data.text === 'string' ? data.text : '';
      text += chunk;
    }
  }
  return text;
}

/** Safely parse a Crush tool call input (a JSON string) into an args record. */
function parseToolInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object') {
    return input as Record<string, unknown>;
  }
  if (typeof input === 'string' && input.length > 0) {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Non-JSON input - expose as a raw string arg
      return { input };
    }
  }
  return {};
}

/**
 * Streaming state maintained across Crush SSE events.
 */
export interface CrushEventStreamState {
  /** Cumulative assistant text per message id */
  accumulatedText: Map<string, string>;
  /** Tool part keys (`${type}:${callId}`) already emitted, to avoid re-emitting on cumulative updates */
  emittedToolParts: Set<string>;
}

/**
 * Pure function that maps one SSE envelope to zero, one, or several
 * AgentMessages. State (accumulated assistant text and emitted tool parts)
 * is passed in and updated in place. Extracted from CrushServerBackend for
 * testability.
 */
export function mapCrushEventToAgentMessages(event: CrushEvent, state: CrushEventStreamState): AgentMessage[] {
  const inner = asRecord(event.payload?.payload);

  switch (event.type) {
    case 'message': {
      const message = inner as CrushMessage | null;
      if (!message || message.role !== 'assistant') {
        return [];
      }

      const messages: AgentMessage[] = [];
      const messageId = message.id ?? 'assistant';

      // Emit tool calls / results as they appear in the accumulated parts.
      // Crush re-sends every existing part on each cumulative update, so
      // each tool part is emitted only once per call id.
      for (const part of message.parts ?? []) {
        const data = asRecord(part.data);
        if (!data) continue;
        if (part.type === 'tool_call') {
          const callId = str(data, 'id') ?? randomUUID();
          const key = `tool_call:${callId}`;
          if (state.emittedToolParts.has(key)) continue;
          state.emittedToolParts.add(key);
          messages.push({
            type: 'tool-call',
            toolName: str(data, 'name') ?? 'unknown',
            args: parseToolInput(data.input),
            callId,
          });
        } else if (part.type === 'tool_result') {
          const callId = str(data, 'tool_call_id') ?? randomUUID();
          const key = `tool_result:${callId}`;
          if (state.emittedToolParts.has(key)) continue;
          state.emittedToolParts.add(key);
          messages.push({
            type: 'tool-result',
            toolName: str(data, 'name') ?? 'unknown',
            result: str(data, 'content') ?? str(data, 'data') ?? '',
            callId,
          });
        }
      }

      // Stream text as deltas: each message event carries the cumulative
      // text of all text parts, so emit only the newly appended suffix.
      const text = messageText(message);
      const previous = state.accumulatedText.get(messageId) ?? '';
      if (text.length > previous.length && text.startsWith(previous)) {
        state.accumulatedText.set(messageId, text);
        messages.push({ type: 'model-output', textDelta: text.slice(previous.length) });
      } else if (text && text !== previous) {
        // Unexpected divergence - send the full text as the authoritative output
        state.accumulatedText.set(messageId, text);
        messages.push({ type: 'model-output', fullText: text });
      }

      return messages;
    }

    case 'run_complete': {
      const run = inner as CrushRunComplete | null;
      if (!run) {
        return [];
      }
      if (run.error) {
        return [{ type: 'status', status: 'error', detail: run.error }];
      }
      return [{ type: 'status', status: 'idle' }];
    }

    case 'agent_event': {
      const agentEvent = inner as CrushAgentEvent | null;
      switch (agentEvent?.type) {
        case 'agent_started':
        case 'agent_busy':
          return [{ type: 'status', status: 'running' }];
        case 'agent_finished':
          return [{ type: 'status', status: 'idle' }];
        case 'agent_error':
          return [{ type: 'status', status: 'error', detail: agentEvent.message?.text ?? 'Unknown error' }];
        default:
          return [];
      }
    }

    case 'permission_request': {
      const request = inner as CrushPermissionRequest | null;
      if (!request) {
        return [];
      }
      const id = request.id ?? request.tool_call_id ?? randomUUID();
      const reason = request.description ?? request.tool_name ?? 'Permission requested';
      return [{ type: 'permission-request', id, reason, payload: request }];
    }

    case 'permission_notification': {
      const granted = inner?.granted === true || inner?.denied === false;
      const toolCallId = str(inner, 'tool_call_id');
      if (!toolCallId) {
        return [];
      }
      return [{ type: 'permission-response', id: toolCallId, approved: granted }];
    }

    default:
      return [];
  }
}

/**
 * Crush backend using HTTP server API
 *
 * Spawns `crush server` as a subprocess with a Unix socket,
 * then communicates via HTTP requests and SSE streaming.
 */
export class CrushServerBackend implements AgentBackend {
  private listeners: AgentMessageHandler[] = [];
  private process: ChildProcess | null = null;
  private disposed = false;
  private socketPath = '';
  private workspaceId: string | null = null;
  private crushSessionId: string | null = null;
  private clientId = randomUUID();
  private abortController: AbortController | null = null;
  private sseRequest: http.ClientRequest | null = null;
  private streamState: CrushEventStreamState = {
    accumulatedText: new Map<string, string>(),
    emittedToolParts: new Set<string>(),
  };
  private pendingPermissions = new Map<string, CrushPermissionRequest>();

  constructor(private options: CrushServerBackendOptions) {
  }

  onMessage(handler: AgentMessageHandler): void {
    this.listeners.push(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    const index = this.listeners.indexOf(handler);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }

  private emit(msg: AgentMessage): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch (error) {
        logger.warn('[CrushServerBackend] Error in message handler:', error);
      }
    }
  }

  /**
   * Start the crush server subprocess and wait for it to be ready
   */
  private async startCrushServer(): Promise<void> {
    if (platform() === 'win32') {
      throw new Error('Crush server integration requires Unix domain sockets and is not supported on Windows');
    }

    this.socketPath = join(tmpdir(), `crush-happy-${randomUUID()}.sock`);

    const command = this.options.command || 'crush';
    const args = ['server', '--host', `unix://${this.socketPath}`];
    if (this.options.extraArgs) {
      args.push(...this.options.extraArgs);
    }

    logger.debug(`[CrushServerBackend] Starting crush server: ${command} ${args.join(' ')}`);

    this.process = spawn(command, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    if (this.process.stderr) {
      this.process.stderr.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
          logger.debug(`[CrushServerBackend] Server stderr: ${text}`);
        }
      });
    }

    this.process.on('error', (err) => {
      logger.debug('[CrushServerBackend] Process error:', err);
      this.emit({ type: 'status', status: 'error', detail: err.message });
    });

    this.process.on('exit', (code, signal) => {
      if (!this.disposed && code !== 0 && code !== null) {
        logger.debug(`[CrushServerBackend] Process exited with code ${code}, signal ${signal}`);
        this.emit({ type: 'status', status: 'stopped', detail: `Exit code: ${code}` });
      }
    });

    // Wait for the server to be ready by polling the health endpoint
    await this.waitForServerReady();
  }

  /**
   * Poll the health endpoint until the server is ready
   */
  private async waitForServerReady(maxRetries = 60, retryDelayMs = 500): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      if (this.disposed || !this.process) {
        throw new Error('Server process terminated before becoming ready');
      }
      try {
        const health = await this.httpGet('/v1/health');
        if (health.ok) {
          logger.debug('[CrushServerBackend] Server is ready');
          return;
        }
      } catch {
        // Server not ready yet, wait and retry
      }
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
    throw new Error('Crush server failed to become ready within timeout');
  }

  /**
   * Make an HTTP request to the crush server over its Unix socket
   */
  private httpRequest(method: string, path: string, body?: unknown): Promise<unknown> {
    const bodyStr = body ? JSON.stringify(body) : undefined;

    return new Promise<unknown>((resolve, reject) => {
      const options: RequestOptions = {
        method,
        path: `${path}${path.includes('?') ? '&' : '?'}client_id=${this.clientId}`,
        socketPath: this.socketPath,
        headers: {
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch {
              resolve(data);
            }
          } else if (res.statusCode === 404) {
            resolve(null);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', reject);

      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  private async httpGet(path: string): Promise<{ ok: boolean; data?: unknown }> {
    try {
      const data = await this.httpRequest('GET', path);
      return { ok: true, data };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Subscribe to SSE events from the server
   */
  private subscribeToEvents(): void {
    const path = `/v1/workspaces/${this.workspaceId}/events`;

    this.abortController = new AbortController();

    const options: RequestOptions = {
      method: 'GET',
      path: `${path}?client_id=${this.clientId}`,
      socketPath: this.socketPath,
      headers: {
        'Accept': 'text/event-stream',
      },
    };

    const req = http.request(options, (res) => {
      let buffer = '';

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6).trim();
            if (jsonStr) {
              try {
                const event = JSON.parse(jsonStr) as CrushEvent;
                this.handleServerEvent(event);
              } catch {
                // Ignore parse errors
              }
            }
          }
        }
      });

      res.on('end', () => {
        logger.debug('[CrushServerBackend] SSE stream ended');
      });

      res.on('error', (err) => {
        logger.debug('[CrushServerBackend] SSE stream error:', err);
      });
    });

    req.on('error', (err) => {
      logger.debug('[CrushServerBackend] SSE request error:', err);
    });

    // Wire the abort signal so dispose() actually tears down the stream
    this.abortController.signal.addEventListener('abort', () => {
      req.destroy();
    });

    this.sseRequest = req;
    req.end();
  }

  /**
   * Handle an event from the crush server SSE stream
   * Maps crush events to AgentMessage types
   */
  private handleServerEvent(event: CrushEvent): void {
    logger.debug(`[CrushServerBackend] Event received: ${event.type}`);

    // Remember permission requests so respondToPermission can echo the
    // full request back in the grant body (crush requires it)
    if (event.type === 'permission_request') {
      const request = asRecord(event.payload?.payload) as CrushPermissionRequest | null;
      const id = request?.id ?? request?.tool_call_id;
      if (id && request) {
        this.pendingPermissions.set(id, request);
      }
    }

    const messages = mapCrushEventToAgentMessages(event, this.streamState);
    if (messages.length > 0) {
      for (const message of messages) {
        this.emit(message);
      }
    } else {
      logger.debug(`[CrushServerBackend] Unhandled event type: ${event.type}`);
    }
  }

  async startSession(_initialPrompt?: string): Promise<StartSessionResult> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    this.emit({ type: 'status', status: 'starting' });

    try {
      // Start the crush server
      await this.startCrushServer();

      // Create a workspace for this working directory
      const workspace = await this.httpRequest('POST', '/v1/workspaces', {
        path: this.options.cwd,
        client_id: this.clientId,
      }) as { id: string } | null;
      if (!workspace?.id) {
        throw new Error('Failed to create crush workspace');
      }
      this.workspaceId = workspace.id;
      logger.debug(`[CrushServerBackend] Workspace created: ${this.workspaceId}`);

      // Initialize the agent
      await this.httpRequest('POST', `/v1/workspaces/${this.workspaceId}/agent/init`);

      // Create a session
      const session = await this.httpRequest('POST', `/v1/workspaces/${this.workspaceId}/sessions`, {
        title: 'Happy Session',
      }) as CrushSession | null;
      if (!session?.id) {
        throw new Error('Failed to create crush session');
      }
      this.crushSessionId = session.id;
      logger.debug(`[CrushServerBackend] Session created: ${this.crushSessionId}`);

      // Subscribe to events
      this.subscribeToEvents();

      this.emit({ type: 'status', status: 'idle' });

      return { sessionId: this.crushSessionId };
    } catch (error) {
      logger.debug('[CrushServerBackend] Failed to start session:', error);
      this.emit({ type: 'status', status: 'error', detail: error instanceof Error ? error.message : 'Unknown error' });
      throw error;
    }
  }

  async sendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
    if (!this.workspaceId || !this.crushSessionId) {
      throw new Error('Session not started');
    }

    this.emit({ type: 'status', status: 'running' });

    await this.httpRequest('POST', `/v1/workspaces/${this.workspaceId}/agent`, {
      session_id: this.crushSessionId,
      prompt,
    });
  }

  async cancel(sessionId: SessionId): Promise<void> {
    if (!this.workspaceId) return;

    try {
      await this.httpRequest('POST', `/v1/workspaces/${this.workspaceId}/agent/sessions/${sessionId}/cancel`);
      this.emit({ type: 'status', status: 'idle' });
    } catch (error) {
      logger.debug('[CrushServerBackend] Error canceling session:', error);
    }
  }

  async respondToPermission(requestId: string, approved: boolean): Promise<void> {
    if (!this.workspaceId) return;

    const permission = this.pendingPermissions.get(requestId);
    if (!permission) {
      logger.debug(`[CrushServerBackend] No pending permission found for id: ${requestId}`);
      return;
    }
    this.pendingPermissions.delete(requestId);

    try {
      await this.httpRequest('POST', `/v1/workspaces/${this.workspaceId}/permissions/grant`, {
        permission,
        action: approved ? 'allow' : 'deny',
      });
    } catch (error) {
      logger.debug('[CrushServerBackend] Error responding to permission:', error);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.sseRequest = null;

    if (this.process) {
      try {
        this.process.kill('SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!this.process.killed) {
          this.process.kill('SIGKILL');
        }
      } catch {
        // Process may already be dead
      }
      this.process = null;
    }
  }
}
