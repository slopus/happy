/**
 * Crush AgentBackend Implementation
 *
 * Custom AgentBackend that drives the Crush CLI (charmbracelet/crush).
 * Crush exposes an HTTP server API (`crush server`) with SSE streaming
 * for events. This backend spawns `crush server` as a subprocess with
 * a Unix socket, then communicates via REST API + SSE.
 *
 *   POST /workspaces                        → create workspace
 *   POST /workspaces/{id}/agent/init        → init agent
 *   POST /workspaces/{id}/sessions          → create session
 *   POST /workspaces/{id}/agent             → send message (fire-and-forget)
 *   GET  /workspaces/{id}/events?client_id  → SSE event stream
 *   POST /workspaces/{id}/agent/sessions/{sid}/cancel → cancel
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
} from '@/agent/core/AgentBackend';
import { logger } from '@/ui/logger';

export type SpawnFn = typeof spawn;

export interface CrushBackendOptions {
  cwd: string;
  command?: string;
  extraArgs?: string[];
  spawnFn?: SpawnFn;
}

/** Crush server event mapped to AgentMessage. */
function mapCrushEvent(event: Record<string, unknown>): AgentMessage | null {
  const type = event.type as string;
  switch (type) {
    case 'agent_message_chunk': {
      const textDelta = (event.text || event.delta || '') as string;
      return textDelta ? { type: 'model-output', textDelta } : null;
    }
    case 'agent_message': {
      const text = (event.text || event.content || '') as string;
      return text ? { type: 'model-output', fullText: text } : null;
    }
    case 'tool_call': {
      const toolName = (event.name || event.tool || 'unknown') as string;
      const callId = (event.id || event.call_id || randomUUID()) as string;
      const args = (event.input || event.arguments || {}) as Record<string, unknown>;
      return { type: 'tool-call', toolName, args, callId };
    }
    case 'tool_result': {
      const toolName = (event.name || event.tool || 'unknown') as string;
      const callId = (event.id || event.call_id || randomUUID()) as string;
      const result = event.output ?? event.result;
      return { type: 'tool-result', toolName, result, callId };
    }
    case 'agent_started':
    case 'agent_busy':
      return { type: 'status', status: 'running' };
    case 'agent_idle':
    case 'agent_finished':
      return { type: 'status', status: 'idle' };
    case 'agent_error': {
      const detail = (event.error || event.message || 'Unknown error') as string;
      return { type: 'status', status: 'error', detail };
    }
    case 'permission_request': {
      const id = (event.id || randomUUID()) as string;
      const reason = (event.reason || 'Permission requested') as string;
      return { type: 'permission-request', id, reason, payload: event };
    }
    case 'file_edit':
    case 'patch_applied': {
      const description = (event.description || 'File edited') as string;
      return { type: 'fs-edit', description, diff: event.diff as string | undefined, path: event.path as string | undefined };
    }
    default:
      return null;
  }
}

export class CrushBackend implements AgentBackend {
  private readonly handlers = new Set<AgentMessageHandler>();
  private process: ChildProcess | null = null;
  private disposed = false;
  private socketPath = '';
  private workspaceId: string | null = null;
  private crushSessionId: string | null = null;
  private readonly clientId = randomUUID();
  private readonly spawnFn: SpawnFn;

  constructor(private readonly options: CrushBackendOptions) {
    this.spawnFn = options.spawnFn ?? spawn;
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.add(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers.delete(handler);
  }

  private emit(msg: AgentMessage): void {
    if (this.disposed) return;
    for (const h of this.handlers) {
      try { h(msg); } catch (e) { logger.warn('[CrushBackend] handler error:', e); }
    }
  }

  /** Pure event mapping exposed for testing. */
  static mapEvent(event: Record<string, unknown>): AgentMessage | null {
    return mapCrushEvent(event);
  }

  private async httpRequest(method: string, path: string, body?: unknown): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const options: RequestOptions = {
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      };
      if (this.socketPath) options.socketPath = this.socketPath;

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(data); }
          } else if (res.statusCode === 404) {
            resolve(null);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  private async waitForServerReady(maxRetries = 60, delayMs = 500): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      if (this.disposed || !this.process) throw new Error('Server terminated before ready');
      try {
        await this.httpRequest('GET', '/health');
        return;
      } catch { /* not ready */ }
      await new Promise(r => setTimeout(r, delayMs));
    }
    throw new Error('Crush server failed to become ready');
  }

  private subscribeToEvents(): void {
    const path = `/workspaces/${this.workspaceId}/events?client_id=${this.clientId}`;
    const options: RequestOptions = {
      method: 'GET',
      path,
      headers: { Accept: 'text/event-stream' },
    };
    if (this.socketPath) options.socketPath = this.socketPath;

    const req = http.request(options, (res) => {
      let buffer = '';
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              const msg = mapCrushEvent(event);
              if (msg) this.emit(msg);
            } catch { /* ignore */ }
          }
        }
      });
    });
    req.on('error', (err) => logger.debug('[CrushBackend] SSE error:', err));
    req.end();
  }

  async startSession(_initialPrompt?: string): Promise<StartSessionResult> {
    if (this.disposed) throw new Error('Backend disposed');

    this.socketPath = platform() === 'win32'
      ? ''
      : join(tmpdir(), `crush-${randomUUID()}.sock`);

    const command = this.options.command || 'crush';
    const serverArgs = ['server', '--host', platform() === 'win32' ? 'tcp://127.0.0.1:0' : `unix://${this.socketPath}`];
    if (this.options.extraArgs) serverArgs.push(...this.options.extraArgs);

    this.process = this.spawnFn(command, serverArgs, {
      cwd: this.options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (this.process.stderr) {
      this.process.stderr.on('data', (d: Buffer) => {
        const t = d.toString().trim();
        if (t) logger.debug(`[CrushBackend] stderr: ${t}`);
      });
    }
    this.process.on('error', (err) => this.emit({ type: 'status', status: 'error', detail: err.message }));
    this.process.on('exit', (code) => {
      if (!this.disposed && code !== 0 && code !== null) {
        this.emit({ type: 'status', status: 'stopped', detail: `Exit code ${code}` });
      }
    });

    this.emit({ type: 'status', status: 'starting' });
    await this.waitForServerReady();

    const workspace = await this.httpRequest('POST', '/workspaces', { path: this.options.cwd });
    this.workspaceId = workspace.id;

    await this.httpRequest('POST', `/workspaces/${this.workspaceId}/agent/init`, { interactive: false });

    const session = await this.httpRequest('POST', `/workspaces/${this.workspaceId}/sessions`, { title: 'Happy Session' });
    this.crushSessionId = session.id;

    this.subscribeToEvents();
    this.emit({ type: 'status', status: 'idle' });

    return { sessionId: this.crushSessionId! };
  }

  async sendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
    if (!this.workspaceId) throw new Error('No workspace');
    this.emit({ type: 'status', status: 'running' });
    await this.httpRequest('POST', `/workspaces/${this.workspaceId}/agent`, {
      type: 'user',
      content: prompt,
      session_id: this.crushSessionId,
    });
  }

  async cancel(_sessionId: SessionId): Promise<void> {
    if (!this.workspaceId || !this.crushSessionId) return;
    try {
      await this.httpRequest('POST', `/workspaces/${this.workspaceId}/agent/sessions/${this.crushSessionId}/cancel`);
      this.emit({ type: 'status', status: 'idle' });
    } catch (e) { logger.debug('[CrushBackend] cancel error:', e); }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 500));
        if (!this.process.killed) this.process.kill('SIGKILL');
      } catch { /* dead */ }
      this.process = null;
    }
  }
}
