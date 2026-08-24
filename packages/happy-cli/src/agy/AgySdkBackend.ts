/**
 * AgySdk AgentBackend Implementation
 *
 * Drives Antigravity via the official Python SDK bridge (`bridge/server.py`).
 * Runs as a single persistent long-lived process per session over stdio NDJSON.
 *
 * Benefits:
 *  - 0ms cold-start latency after session initialization
 *  - No repeated eligibility checks or per-turn authentication overhead
 *  - Live connection & stateful multi-turn conversation in localharness
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { PermissionMode } from '@/api/types';
import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
} from '@/agent/core/AgentBackend';
import { resolveAgyModelName, type DiscoveredModel } from './discoverModels';
import type { SpawnFn } from './AgyBackend';

export interface AgySdkBackendOptions {
  cwd: string;
  permissionMode: PermissionMode;
  model?: string;
  models?: DiscoveredModel[];
  conversationId?: string | null;
  apiKey?: string;
  pythonBin?: string;
  bridgeScriptPath?: string;
  log?: (msg: string) => void;
  spawnFn?: SpawnFn;
  onConversationId?: (conversationId: string) => void;
}

export class AgySdkBackend implements AgentBackend {
  private readonly handlers = new Set<AgentMessageHandler>();
  private readonly conversationIdListeners = new Set<(id: string) => void>();
  private readonly cwd: string;
  private readonly apiKey?: string;
  private readonly pythonBin: string;
  private readonly bridgeScriptPath: string;
  private readonly log: (msg: string) => void;
  private readonly spawnFn: SpawnFn;

  private permissionMode: PermissionMode;
  private model?: string;
  private models?: DiscoveredModel[];
  private conversationId: string | null = null;

  private child: ChildProcess | null = null;
  private stdoutBuffer = '';
  private pendingTurn: {
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;
  private isReady = false;
  private readyPromise: Promise<void> | null = null;

  constructor(opts: AgySdkBackendOptions) {
    this.cwd = opts.cwd;
    this.permissionMode = opts.permissionMode;
    this.models = opts.models;
    this.model = resolveAgyModelName(opts.model, this.models);
    this.conversationId = opts.conversationId ?? null;
    this.apiKey = opts.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    this.pythonBin = opts.pythonBin || 'python3';
    this.bridgeScriptPath =
      opts.bridgeScriptPath || path.join(__dirname, 'bridge', 'server.py');
    this.log = opts.log ?? (() => {});
    this.spawnFn = opts.spawnFn ?? spawn;

    if (opts.onConversationId) {
      this.conversationIdListeners.add(opts.onConversationId);
    }
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  setModel(model: string | undefined): void {
    this.model = resolveAgyModelName(model, this.models);
  }

  setDiscoveredModels(models: DiscoveredModel[]): void {
    this.models = models;
    if (this.model) {
      this.model = resolveAgyModelName(this.model, this.models);
    }
  }

  getModel(): string | undefined {
    return this.model;
  }

  getConversationId(): string | null {
    return this.conversationId;
  }

  setConversationId(id: string | null): void {
    if (id && id !== this.conversationId) {
      this.conversationId = id;
      for (const listener of this.conversationIdListeners) {
        try {
          listener(id);
        } catch (err) {
          this.log(`Error in conversation ID listener: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else if (id === null) {
      this.conversationId = null;
    }
  }

  reset(): void {
    this.log('Resetting agy SDK backend: clearing conversation ID and child bridge');
    this.conversationId = null;
    this.isReady = false;
    this.readyPromise = null;
    if (this.child) {
      try {
        const exitReq = JSON.stringify({ action: 'dispose' });
        this.child.stdin?.write(exitReq + '\n');
        this.child.kill('SIGTERM');
      } catch {
        // Ignore write errors during reset
      }
      this.child = null;
    }
  }

  onConversationId(listener: (id: string) => void): () => void {
    this.conversationIdListeners.add(listener);
    if (this.conversationId) {
      try {
        listener(this.conversationId);
      } catch (err) {
        this.log(`Error in conversation ID listener: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return () => {
      this.conversationIdListeners.delete(listener);
    };
  }

  async startSession(): Promise<StartSessionResult> {
    if (!this.child) {
      this.readyPromise = this.spawnBridge();
    }
    await this.readyPromise;
    return { sessionId: this.cwd };
  }

  private async spawnBridge(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = this.spawnFn(this.pythonBin, [this.bridgeScriptPath], {
        cwd: this.cwd,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          ...(this.apiKey ? { GEMINI_API_KEY: this.apiKey } : {}),
        },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;

      let settled = false;

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        this.stdoutBuffer += chunk;
        const lines = this.stdoutBuffer.split('\n');
        this.stdoutBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);
            this.handleBridgeEvent(event, () => {
              if (!settled) {
                settled = true;
                this.isReady = true;
                resolve();
              }
            });
          } catch {
            this.log(`[sdk-bridge] raw stdout: ${trimmed}`);
          }
        }
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        const text = chunk.trimEnd();
        if (text) {
          this.log(`[sdk-bridge stderr] ${text}`);
        }
      });

      child.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.emit({ type: 'status', status: 'error', detail: err.message });
      });

      child.on('close', (code: number | null) => {
        if (!settled) {
          settled = true;
          reject(new Error(`Antigravity SDK bridge exited with code ${code ?? 'null'}`));
        }
        if (this.pendingTurn) {
          this.pendingTurn.reject(new Error(`Bridge closed unexpectedly with code ${code}`));
          this.pendingTurn = null;
        }
      });

      // Send initial configuration over stdin
      const initPayload = JSON.stringify({
        action: 'init',
        cwd: this.cwd,
        model: this.model,
        conversation_id: this.conversationId,
        api_key: this.apiKey,
        permission_mode: this.permissionMode,
      });
      child.stdin?.write(initPayload + '\n');
    });
  }

  private handleBridgeEvent(event: any, onReady: () => void): void {
    switch (event.event) {
      case 'ready': {
        if (event.conversation_id) {
          this.setConversationId(event.conversation_id);
        }
        onReady();
        break;
      }
      case 'text_delta': {
        if (event.delta) {
          this.emit({ type: 'model-output', textDelta: event.delta });
        }
        break;
      }
      case 'thinking': {
        if (event.delta) {
          this.emit({
            type: 'event',
            name: 'thinking',
            payload: { text: event.delta, streaming: true },
          });
        }
        break;
      }
      case 'tool_call': {
        this.emit({
          type: 'tool-call',
          callId: event.call_id,
          toolName: event.tool_name,
          args: event.args || {},
        });
        break;
      }
      case 'tool_result': {
        this.emit({
          type: 'tool-result',
          callId: event.call_id,
          toolName: event.tool_name,
          result: event.result || '',
        });
        break;
      }
      case 'token_count': {
        this.emit({
          type: 'token-count',
          input_tokens: event.input_tokens || 0,
          output_tokens: event.output_tokens || 0,
          thinking_tokens: event.thinking_tokens || 0,
        });
        break;
      }
      case 'turn_complete': {
        if (event.conversation_id) {
          this.setConversationId(event.conversation_id);
        }
        if (event.status === 'SUCCESS') {
          this.emit({ type: 'status', status: 'idle' });
          this.pendingTurn?.resolve();
        } else {
          const detail = event.error || 'SDK turn failed';
          this.emit({ type: 'status', status: 'error', detail });
          this.pendingTurn?.reject(new Error(detail));
          // Reset/recycle the bridge process on turn error so subsequent turns don't get stuck in the error state
          if (this.child) {
            try {
              this.child.kill('SIGTERM');
            } catch {
              // ignore
            }
            this.child = null;
            this.isReady = false;
            this.readyPromise = null;
          }
        }
        this.pendingTurn = null;
        break;
      }
      case 'error': {
        this.log(`[sdk-bridge error] ${event.message}`);
        break;
      }
      default:
        this.log(`[sdk-bridge unknown event] ${JSON.stringify(event)}`);
    }
  }

  async sendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
    if (!this.child || !this.isReady) {
      await this.startSession();
    }

    if (this.pendingTurn) {
      throw new Error('A turn is already in progress');
    }

    this.emit({ type: 'status', status: 'running' });

    return new Promise<void>((resolve, reject) => {
      this.pendingTurn = { resolve, reject };

      const chatReq = JSON.stringify({
        action: 'chat',
        prompt,
        model: this.model,
        permission_mode: this.permissionMode,
      });

      this.child?.stdin?.write(chatReq + '\n');
    });
  }

  async cancel(_sessionId?: SessionId): Promise<void> {
    if (this.child) {
      const cancelReq = JSON.stringify({ action: 'cancel' });
      this.child.stdin?.write(cancelReq + '\n');
    }
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.add(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers.delete(handler);
  }

  async dispose(): Promise<void> {
    if (this.child) {
      try {
        const exitReq = JSON.stringify({ action: 'dispose' });
        this.child.stdin?.write(exitReq + '\n');
        this.child.kill('SIGTERM');
      } catch {
        // Ignore write errors during dispose
      }
      this.child = null;
    }
    this.handlers.clear();
    this.conversationIdListeners.clear();
  }

  private emit(msg: AgentMessage): void {
    for (const handler of this.handlers) {
      try {
        handler(msg);
      } catch (err) {
        this.log(`Error in message handler: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
