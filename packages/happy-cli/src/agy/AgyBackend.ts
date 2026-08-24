/**
 * Agy AgentBackend Implementation
 *
 * Drives the agy (Antigravity) CLI in persistent streaming mode via:
 *   `--input-format stream-json --output-format stream-json`
 *
 * A single long-lived agy child process is maintained throughout the Happy session lifecycle.
 * Prompts are dispatched across turns via stdio NDJSON using the native schema:
 *   `{"event":"user","message":{"content":"..."}}`
 *
 * Features:
 *   - Zero cold start on multi-turn conversations (Harness, keyring, and session stay hot).
 *   - Automatic startup retry on transient Google OAuth / network EOF errors.
 *   - Full Stream-JSON parsing (text deltas, thinking, tool calls, tool results, usage).
 *   - Auto-recovery: if the process unexpectedly exits between turns, it is cleanly respawned
 *     with `--conversation <id>` to preserve context.
 *   - Live model switching: `setModel()` restarts the persistent process (the model is a
 *     spawn-time `--model` flag), deferring the restart until the active turn finishes.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { PermissionMode } from '@/api/types';
import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
} from '@/agent/core/AgentBackend';
import { resolveAgyBin, AGY_PRINT_TIMEOUT } from './constants';
import { resolveAgyModelName, type DiscoveredModel } from './discoverModels';
import { StreamJsonParser, type AgyResult } from './streamJson';

export type SpawnFn = typeof spawn;

export interface AgyBackendOptions {
  /** Working directory the agy process runs in. */
  cwd: string;
  /** Initial permission mode. */
  permissionMode: PermissionMode;
  /** Initial model display name or slug. */
  model?: string;
  /** List of discovered models for resolving slugs to display names. */
  models?: DiscoveredModel[];
  /** Optional initial conversation ID to resume. */
  conversationId?: string | null;
  /** Value for `--print-timeout`. Defaults to AGY_PRINT_TIMEOUT. */
  printTimeout?: string;
  /** Optional logger. */
  log?: (msg: string) => void;
  /** Injectable spawn (defaults to node's child_process.spawn). */
  spawnFn?: SpawnFn;
  /** Optional callback fired whenever a conversation ID is confirmed. */
  onConversationId?: (conversationId: string) => void;
  /** Maximum number of retries for transient startup errors (default 3). */
  maxRetries?: number;
}

export function isRetryableAgyError(errorText: string, stderrText = ''): boolean {
  const combined = `${errorText} ${stderrText}`.toLowerCase();
  return (
    combined.includes('eligibility check failed') ||
    combined.includes('failed to get profile picture') ||
    combined.includes(': eof') ||
    combined.includes('tls handshake timeout') ||
    combined.includes('connection reset by peer') ||
    combined.includes('i/o timeout') ||
    combined.includes('rate limit') ||
    combined.includes('resource_exhausted') ||
    combined.includes('currently overloaded')
  );
}

export class AgyBackend implements AgentBackend {
  private readonly handlers = new Set<AgentMessageHandler>();
  private readonly conversationIdListeners = new Set<(id: string) => void>();
  private readonly cwd: string;
  private readonly printTimeout: string;
  private readonly log: (msg: string) => void;
  private readonly spawnFn: SpawnFn;
  private readonly maxRetries: number;

  private permissionMode: PermissionMode;
  private model?: string;
  private models?: DiscoveredModel[];
  private conversationId: string | null = null;

  private child: ChildProcess | null = null;
  private currentTurnParser: StreamJsonParser | null = null;
  private activeTurnResolve: (() => void) | null = null;
  private activeTurnReject: ((err: Error) => void) | null = null;
  private activeTurnStderr = '';
  private isTurnRunning = false;
  private isDisposed = false;
  private pendingModelRestart = false;

  constructor(opts: AgyBackendOptions) {
    this.cwd = opts.cwd;
    this.permissionMode = opts.permissionMode;
    this.models = opts.models;
    this.model = resolveAgyModelName(opts.model, this.models);
    this.conversationId = opts.conversationId ?? null;
    this.printTimeout = opts.printTimeout ?? AGY_PRINT_TIMEOUT;
    this.log = opts.log ?? (() => {});
    this.spawnFn = opts.spawnFn ?? spawn;
    this.maxRetries = opts.maxRetries ?? 3;

    if (opts.onConversationId) {
      this.conversationIdListeners.add(opts.onConversationId);
    }
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  setModel(model: string | undefined): void {
    const resolved = resolveAgyModelName(model, this.models);
    if (resolved === this.model) {
      return;
    }
    this.model = resolved;

    // The model is only applied as a spawn-time `--model` flag, so a live child
    // keeps running the old model until respawned. Restart the persistent process
    // to honor the change; the respawn passes `--conversation <id>` so context is
    // preserved. Never kill mid-turn — that would fail the in-flight prompt — so
    // defer to the sendPrompt finally block while a turn is running.
    if (this.child && !this.child.killed) {
      if (this.isTurnRunning) {
        this.pendingModelRestart = true;
      } else {
        this.restartChildForModelChange();
      }
    }
  }

  private restartChildForModelChange(): void {
    this.log(
      `Model changed to "${this.model ?? 'default'}" — restarting persistent agy process ` +
        `(conversation ${this.conversationId ?? 'none'} is preserved on respawn)`,
    );
    this.child?.kill('SIGTERM');
    this.child = null;
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
    this.log('Resetting agy backend: clearing conversation ID and child process');
    this.conversationId = null;
    if (this.child) {
      this.child.kill('SIGTERM');
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
    await this.ensureChildRunning();
    return { sessionId: this.cwd };
  }

  async sendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
    if (this.isDisposed) {
      throw new Error('AgyBackend is disposed');
    }

    this.emit({ type: 'status', status: 'running' });
    this.isTurnRunning = true;
    this.activeTurnStderr = '';

    try {
      await this.ensureChildRunning();

      let lastResult: AgyResult | null = null;
      const turnPromise = new Promise<void>((resolve, reject) => {
        this.activeTurnResolve = resolve;
        this.activeTurnReject = reject;
      });

      this.currentTurnParser = new StreamJsonParser({
        onInit: (event) => {
          if (event.conversation_id) {
            this.setConversationId(event.conversation_id);
          }
        },
        onResult: (event) => {
          lastResult = event.result;
          if (event.result.conversation_id) {
            this.setConversationId(event.result.conversation_id);
          }
          if (event.result.status === 'SUCCESS') {
            this.activeTurnResolve?.();
          } else {
            const err = new Error(event.result.error || event.result.response || 'Turn failed');
            this.activeTurnReject?.(err);
          }
        },
        onMessage: (msg) => {
          this.emit(msg);
        },
        log: this.log,
      });

      // Send prompt via stream-json user event
      const payload = {
        event: 'user',
        message: {
          content: prompt,
        },
      };

      this.log(`Dispatching user turn to persistent agy process (length: ${prompt.length})`);
      this.child?.stdin?.write(JSON.stringify(payload) + '\n');

      await turnPromise;
      this.emit({ type: 'status', status: 'idle' });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'status', status: 'error', detail: errorMsg });
      // When a turn fails with an error (e.g. tool failure or unhandled exception in agy),
      // recycle the child process so it does not retain corrupted state or re-emit stale errors
      // across turns. On the next turn, ensureChildRunning will cleanly respawn agy with
      // --conversation <id> to resume the conversation state.
      if (this.child && !this.child.killed) {
        this.log('Turn failed — recycling child process to ensure clean state for next turn');
        this.child.kill('SIGTERM');
        this.child = null;
      }
      throw err;
    } finally {
      this.isTurnRunning = false;
      this.activeTurnResolve = null;
      this.activeTurnReject = null;
      this.currentTurnParser = null;
      this.activeTurnStderr = '';
      if (this.pendingModelRestart) {
        this.pendingModelRestart = false;
        this.restartChildForModelChange();
      }
    }
  }

  private async ensureChildRunning(): Promise<void> {
    if (this.child && !this.child.killed) {
      return;
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.spawnPersistentChild();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const isRetryable = isRetryableAgyError(lastError.message, this.activeTurnStderr);
        if (isRetryable && attempt < this.maxRetries && !this.isDisposed) {
          const delayMs = (attempt + 1) * 750;
          this.log(`Transient startup error on attempt ${attempt + 1}: ${lastError.message}. Retrying in ${delayMs}ms...`);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        throw lastError;
      }
    }

    if (lastError) {
      throw lastError;
    }
  }

  private spawnPersistentChild(): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
      ];

      if (this.permissionMode === 'bypassPermissions' || this.permissionMode === 'yolo') {
        args.push('--dangerously-skip-permissions');
      }

      if (this.model) {
        args.push('--model', this.model);
      }

      if (this.conversationId) {
        args.push('--conversation', this.conversationId);
      }

      args.push('--add-dir', this.cwd);

      this.log(`Spawning persistent agy: ${resolveAgyBin()} ${args.join(' ')}`);

      const child = this.spawnFn(resolveAgyBin(), args, {
        cwd: this.cwd,
        env: process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.child = child;
      let initialized = false;

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (!initialized) {
          // Check for initial init or result event
          const lines = chunk.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const data = JSON.parse(trimmed);
              if (data.event === 'init') {
                initialized = true;
                if (data.conversation_id) {
                  this.setConversationId(data.conversation_id);
                  this.log(`Persistent agy initialized with conversation ID: ${data.conversation_id}`);
                }
                resolve();
                return;
              } else if (data.event === 'result' && data.result?.status === 'ERROR') {
                initialized = true;
                reject(new Error(data.result.error || 'Startup failed'));
                return;
              }
            } catch {
              // Ignore non-JSON line during startup handshake
            }
          }
        }

        if (this.currentTurnParser && this.child === child) {
          this.currentTurnParser.feed(chunk);
        }
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        const text = chunk.trimEnd();
        if (text) {
          this.log(`[agy stderr] ${text}`);
          this.activeTurnStderr += chunk;
        }
      });

      child.on('error', (err: Error) => {
        if (!initialized) {
          initialized = true;
          reject(err);
        }
        // A late error from a replaced child (e.g. after a model-change restart)
        // must not fail the turn running on the new process.
        if (this.isTurnRunning && this.child === child) {
          this.activeTurnReject?.(err);
        }
      });

      child.on('close', (code: number | null) => {
        this.log(`Persistent agy process exited with code ${code ?? 'null'}`);
        // The close of a killed process arrives asynchronously, possibly after a
        // replacement was already spawned (model-change restart). Only clear the
        // reference if it still points at THIS child — otherwise the next prompt
        // would be written into the void via `this.child?.stdin?.write` on null.
        if (this.child === child) {
          this.child = null;
        }
        if (!initialized) {
          initialized = true;
          reject(new Error(`agy process exited during startup with code ${code ?? 'null'}: ${this.activeTurnStderr}`));
        }
        // Reject the active turn when the process serving it died. After a
        // model-change restart `this.child` already points at the replacement,
        // so a late close from the old process must not reject the new turn.
        // `this.child === null` covers cancel()/abort, which nulls the
        // reference before this event arrives and still needs the rejection.
        if (this.isTurnRunning && (this.child === child || this.child === null)) {
          this.activeTurnReject?.(new Error(`agy process exited unexpectedly during turn (code ${code})`));
        }
      });
    });
  }

  async cancel(_sessionId?: SessionId): Promise<void> {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.add(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers.delete(handler);
  }

  async dispose(): Promise<void> {
    this.isDisposed = true;
    await this.cancel();
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
