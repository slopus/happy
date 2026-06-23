/**
 * Agy AgentBackend Implementation
 *
 * Custom AgentBackend that drives the agy (Antigravity) CLI. Unlike the ACP-based
 * backends, agy has no streaming-event protocol — its only non-interactive surface
 * is `agy --print "<prompt>"`, which streams the final answer as plain text and
 * exits. So this backend spawns one `agy --print` process per turn and maps:
 *
 *   spawn            → { type: 'status', status: 'running' }
 *   stdout chunk     → { type: 'model-output', textDelta }
 *   exit code 0      → { type: 'status', status: 'idle' }
 *   exit code != 0   → { type: 'status', status: 'error', detail }
 *
 * There are no tool-call or permission events: print mode is one-shot and governed
 * by the CLI flags (see cliArgs.ts) plus agy's own settings.json.
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
import { AGY_BIN, AGY_PRINT_TIMEOUT } from './constants';
import { buildAgyArgs } from './cliArgs';
import { readAgyConversationId } from './conversationStore';

/** Signature of node's `spawn`, injectable so tests can supply a fake process. */
export type SpawnFn = typeof spawn;

export interface AgyBackendOptions {
  /** Working directory the agy process runs in (and the conversation cache key). */
  cwd: string;
  /** Initial permission mode; updated per turn from message meta. */
  permissionMode: PermissionMode;
  /** Initial model display name; updated per turn from message meta. */
  model?: string;
  /** Value for `--print-timeout`. Defaults to AGY_PRINT_TIMEOUT. */
  printTimeout?: string;
  /** Optional logger. */
  log?: (msg: string) => void;
  /** Injectable spawn (defaults to node's child_process.spawn). */
  spawnFn?: SpawnFn;
  /** Optional override for resolving the resume conversation id (tests). */
  resolveConversationId?: (cwd: string) => string | null;
}

export class AgyBackend implements AgentBackend {
  private readonly handlers = new Set<AgentMessageHandler>();
  private readonly cwd: string;
  private readonly printTimeout: string;
  private readonly log: (msg: string) => void;
  private readonly spawnFn: SpawnFn;
  private readonly resolveConversationId: (cwd: string) => string | null;

  private permissionMode: PermissionMode;
  private model?: string;
  private conversationId: string | null = null;
  private child: ChildProcess | null = null;

  constructor(opts: AgyBackendOptions) {
    this.cwd = opts.cwd;
    this.permissionMode = opts.permissionMode;
    this.model = opts.model;
    this.printTimeout = opts.printTimeout ?? AGY_PRINT_TIMEOUT;
    this.log = opts.log ?? (() => {});
    this.spawnFn = opts.spawnFn ?? spawn;
    this.resolveConversationId = opts.resolveConversationId ?? readAgyConversationId;
  }

  /** Update the permission mode applied to subsequent turns. */
  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  /** Update the model applied to subsequent turns. */
  setModel(model: string | undefined): void {
    this.model = model;
  }

  async startSession(): Promise<StartSessionResult> {
    // agy spawns lazily per prompt; there is nothing long-lived to start.
    // Pick up any existing conversation for this cwd so the first turn resumes it.
    this.conversationId = this.resolveConversationId(this.cwd);
    return { sessionId: this.cwd };
  }

  async sendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
    const args = buildAgyArgs({
      prompt,
      model: this.model,
      conversationId: this.conversationId,
      permissionMode: this.permissionMode,
      addDirs: [this.cwd],
      printTimeout: this.printTimeout,
    });

    this.emit({ type: 'status', status: 'running' });

    await new Promise<void>((resolve, reject) => {
      const child = this.spawnFn(AGY_BIN, args, {
        cwd: this.cwd,
        env: process.env,
        windowsHide: true,
        // agy --print blocks until stdin reaches EOF. We never write stdin, so
        // give the child an empty stdin (immediate EOF) instead of an open pipe;
        // otherwise it hangs forever and the turn never completes.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (chunk) {
          this.emit({ type: 'model-output', textDelta: chunk });
        }
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        const text = chunk.trimEnd();
        if (text) {
          this.log(`stderr: ${text}`);
        }
      });

      child.on('error', (err: Error) => {
        this.child = null;
        this.emit({ type: 'status', status: 'error', detail: err.message });
        reject(err);
      });

      child.on('close', (code: number | null) => {
        this.child = null;
        // Capture the conversation id agy recorded for this cwd so the next turn resumes it.
        const cid = this.resolveConversationId(this.cwd);
        if (cid) {
          this.conversationId = cid;
        }

        if (code === 0) {
          this.emit({ type: 'status', status: 'idle' });
          resolve();
        } else {
          const detail = `agy exited with code ${code ?? 'null'}`;
          this.emit({ type: 'status', status: 'error', detail });
          reject(new Error(detail));
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
    await this.cancel();
    this.handlers.clear();
  }

  private emit(msg: AgentMessage): void {
    for (const handler of this.handlers) {
      handler(msg);
    }
  }
}
