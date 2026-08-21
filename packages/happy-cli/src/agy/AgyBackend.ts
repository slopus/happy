/**
 * Agy AgentBackend Implementation
 *
 * Custom AgentBackend that drives the agy (Antigravity) CLI using `--output-format stream-json`.
 *
 * agy is executed per prompt turn in headless mode. Each turn emits structured NDJSON events:
 *   - `init` (provides the conversation ID directly on the first line)
 *   - `step_update` (streamed text chunks, tool calls, tool results, reasoning, token usage)
 *   - `result` (final turn completion status and token usage summary)
 *
 * The conversation ID received from the `init` event is saved in memory and bound to Happy's
 * session state, so subsequent turns continue the same conversation via `--conversation <id>`.
 *
 * Includes automatic retry for transient network/eligibility errors during process startup.
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
import { buildAgyArgs } from './cliArgs';
import { resolveAgyModelName, type DiscoveredModel } from './discoverModels';
import { StreamJsonParser, type AgyResult } from './streamJson';

/** Signature of node's `spawn`, injectable so tests can supply a fake process. */
export type SpawnFn = typeof spawn;

export interface AgyBackendOptions {
  /** Working directory the agy process runs in. */
  cwd: string;
  /** Initial permission mode; updated per turn from message meta. */
  permissionMode: PermissionMode;
  /** Initial model display name or slug; updated per turn from message meta. */
  model?: string;
  /** List of discovered models for resolving slugs to display names. */
  models?: DiscoveredModel[];
  /** Optional initial conversation ID to resume (e.g. from session metadata or --resume). */
  conversationId?: string | null;
  /** Value for `--print-timeout`. Defaults to AGY_PRINT_TIMEOUT. */
  printTimeout?: string;
  /** Optional logger. */
  log?: (msg: string) => void;
  /** Injectable spawn (defaults to node's child_process.spawn). */
  spawnFn?: SpawnFn;
  /** Optional callback fired whenever a conversation ID is confirmed or discovered. */
  onConversationId?: (conversationId: string) => void;
  /** Maximum number of retries for transient startup errors (default 2). */
  maxRetries?: number;
}

/** Parse an agy duration string ("10m", "30s", "1h") to milliseconds; defaults to 10m. */
function parsePrintTimeoutMs(value: string): number {
  const m = /^(\d+)\s*(s|m|h)$/.exec(value.trim());
  if (!m) return 10 * 60_000;
  const n = Number(m[1]);
  return m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : n * 1_000;
}

/**
 * Detect transient initialization or network errors that are safe to retry.
 */
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
  private cancelled = false;

  constructor(opts: AgyBackendOptions) {
    this.cwd = opts.cwd;
    this.permissionMode = opts.permissionMode;
    this.models = opts.models;
    this.model = resolveAgyModelName(opts.model, this.models);
    this.conversationId = opts.conversationId ?? null;
    this.printTimeout = opts.printTimeout ?? AGY_PRINT_TIMEOUT;
    this.log = opts.log ?? (() => {});
    this.spawnFn = opts.spawnFn ?? spawn;
    this.maxRetries = opts.maxRetries ?? 2;

    if (opts.onConversationId) {
      this.conversationIdListeners.add(opts.onConversationId);
    }
  }

  /** Update the permission mode applied to subsequent turns. */
  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  /** Update the model applied to subsequent turns (resolves slugs to display names). */
  setModel(model: string | undefined): void {
    this.model = resolveAgyModelName(model, this.models);
  }

  /** Update the discovered model catalog. */
  setDiscoveredModels(models: DiscoveredModel[]): void {
    this.models = models;
    if (this.model) {
      this.model = resolveAgyModelName(this.model, this.models);
    }
  }

  /** Get the current resolved model display name. */
  getModel(): string | undefined {
    return this.model;
  }

  /** Get the active agy conversation ID, if one has been established. */
  getConversationId(): string | null {
    return this.conversationId;
  }

  /** Explicitly set or override the agy conversation ID. */
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

  /** Register a listener for conversation ID updates. Returns an unsubscribe callback. */
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
    return { sessionId: this.cwd };
  }

  async sendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
    this.cancelled = false;
    this.emit({ type: 'status', status: 'running' });

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (this.cancelled) {
        throw new Error('Turn was cancelled');
      }

      let stderrAccumulator = '';
      let hasEmittedOutput = false;

      try {
        await this.executeTurn(prompt, {
          onStderr: (chunk) => {
            stderrAccumulator += chunk;
          },
          onOutput: () => {
            hasEmittedOutput = true;
          },
        });
        this.emit({ type: 'status', status: 'idle' });
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const errorMsg = lastError.message;
        const isRetryable = isRetryableAgyError(errorMsg, stderrAccumulator);

        if (isRetryable && !hasEmittedOutput && attempt < this.maxRetries && !this.cancelled) {
          const delayMs = (attempt + 1) * 750;
          this.log(
            `Transient network/eligibility error on attempt ${attempt + 1}: "${errorMsg}". Retrying in ${delayMs}ms...`
          );
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }

        this.emit({ type: 'status', status: 'error', detail: errorMsg });
        throw lastError;
      }
    }

    if (lastError) {
      throw lastError;
    }
  }

  private executeTurn(
    prompt: string,
    hooks: { onStderr: (chunk: string) => void; onOutput: () => void }
  ): Promise<void> {
    const args = buildAgyArgs({
      prompt,
      model: this.model,
      conversationId: this.conversationId,
      permissionMode: this.permissionMode,
      addDirs: [this.cwd],
      printTimeout: this.printTimeout,
    });

    let lastResult: AgyResult | null = null;
    const parser = new StreamJsonParser({
      onInit: (event) => {
        if (event.conversation_id) {
          this.setConversationId(event.conversation_id);
          this.log(`Discovered agy conversation ID: ${event.conversation_id}`);
        }
      },
      onResult: (event) => {
        lastResult = event.result;
        if (event.result.conversation_id) {
          this.setConversationId(event.result.conversation_id);
        }
      },
      onMessage: (msg) => {
        if (msg.type === 'model-output' || msg.type === 'tool-call') {
          hooks.onOutput();
        }
        this.emit(msg);
      },
      log: this.log,
    });

    return new Promise<void>((resolve, reject) => {
      const child = this.spawnFn(resolveAgyBin(), args, {
        cwd: this.cwd,
        env: process.env,
        windowsHide: true,
        // agy in print mode expects immediate stdin EOF
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;

      let settled = false;
      const watchdog = setTimeout(() => {
        this.log(`agy turn exceeded ${this.printTimeout}; killing process`);
        child.kill('SIGKILL');
      }, parsePrintTimeoutMs(this.printTimeout) + 30_000);

      const cleanup = () => {
        clearTimeout(watchdog);
        if (this.child === child) {
          this.child = null;
        }
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (chunk) {
          parser.feed(chunk);
        }
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        const text = chunk.trimEnd();
        if (text) {
          this.log(`stderr: ${text}`);
          hooks.onStderr(chunk);
        }
      });

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        const detail = (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? `agy executable not found. Install the Antigravity CLI, or set HAPPY_AGY_PATH to its absolute path (tried 'agy' on PATH and ~/.local/bin/agy).`
          : err.message;
        reject(new Error(detail));
      });

      child.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        parser.flush();

        if (code === 0 && (!lastResult || lastResult.status !== 'ERROR')) {
          resolve();
        } else {
          const errorDetail =
            lastResult?.error ||
            lastResult?.response ||
            `agy exited with code ${code ?? 'null'}`;
          reject(new Error(errorDetail));
        }
      });
    });
  }

  async cancel(_sessionId?: SessionId): Promise<void> {
    this.cancelled = true;
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
