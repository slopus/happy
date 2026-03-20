/**
 * CodexJsonRpcPeer - Bidirectional JSON-RPC transport for Codex app-server
 *
 * Manages the child process lifecycle and JSON-RPC message routing:
 * - Spawns `codex app-server` as a child process
 * - Reads newline-delimited JSON from stdout
 * - Writes newline-delimited JSON to stdin
 * - Correlates request/response pairs via incrementing IDs
 * - Routes server notifications and server-to-client requests
 *
 * NOTE: Codex does NOT use standard JSON-RPC 2.0 (no "jsonrpc" field).
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { logger } from '@/ui/logger';

export interface SpawnOptions {
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export type NotificationHandler = (method: string, params: unknown) => void;
export type ServerRequestHandler = (method: string, params: unknown, id: number | string) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  label: string;
}

export class CodexJsonRpcPeer {
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private pendingRequests = new Map<number | string, PendingRequest>();
  private nextId = 1;
  private notificationHandler: NotificationHandler | null = null;
  private serverRequestHandler: ServerRequestHandler | null = null;
  private closeHandler: (() => void) | null = null;
  private closed = false;
  private exited = false;
  private exitPromise: Promise<number | null> | null = null;

  /**
   * Spawn the codex app-server child process.
   */
  async spawn(command: string, args: string[], opts: SpawnOptions): Promise<void> {
    if (this.process) {
      throw new Error('CodexJsonRpcPeer: already spawned');
    }

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...opts.env,
      // Suppress noisy npm/node output
      NPM_CONFIG_LOGLEVEL: 'error',
      NODE_NO_WARNINGS: '1',
      NO_COLOR: '1',
    };

    logger.debug(`[CodexRPC] Spawning: ${command} ${args.join(' ')} in ${opts.cwd}`);

    this.process = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      signal: opts.signal,
      detached: true,  // Create new process group so we can kill all children
    });

    this.exitPromise = new Promise<number | null>((resolve) => {
      this.process!.on('close', (code) => {
        this.exited = true;
        logger.debug(`[CodexRPC] Process exited with code ${code}`);
        resolve(code);
      });
    });

    this.process.on('error', (err) => {
      logger.warn(`[CodexRPC] Process error: ${err.message}`);
      this.rejectAllPending(new Error(`Codex process error: ${err.message}`));
    });

    // Read stderr for diagnostics
    if (this.process.stderr) {
      this.process.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          logger.debug(`[CodexRPC] stderr: ${text}`);
        }
      });
    }

    // Read stdout line by line
    if (!this.process.stdout) {
      throw new Error('CodexJsonRpcPeer: stdout not available');
    }

    this.readline = createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });

    this.readline.on('line', (line) => {
      this.handleLine(line);
    });

    this.readline.on('close', () => {
      logger.debug('[CodexRPC] stdout closed');
      this.rejectAllPending(new Error('Codex process stdout closed'));
      this.closeHandler?.();
    });
  }

  /**
   * Send a request and wait for the response.
   */
  async request<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.closed || !this.process?.stdin?.writable) {
      throw new Error(`CodexJsonRpcPeer: cannot send request '${method}' - peer is closed`);
    }

    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`CodexJsonRpcPeer: '${method}' request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        label: method,
      });

      const msg: Record<string, unknown> = { id, method };
      if (params !== undefined) {
        msg.params = params;
      }

      this.writeLine(JSON.stringify(msg));
    });
  }

  /**
   * Send a notification (no response expected).
   */
  notify(method: string, params?: unknown): void {
    if (this.closed || !this.process?.stdin?.writable) {
      logger.debug(`[CodexRPC] Cannot send notification '${method}' - peer is closed`);
      return;
    }

    const msg: Record<string, unknown> = { method };
    if (params !== undefined) {
      msg.params = params;
    }

    this.writeLine(JSON.stringify(msg));
  }

  /**
   * Send a response to a server-to-client request.
   */
  respond(id: number | string, result: unknown): void {
    if (this.closed || !this.process?.stdin?.writable) {
      logger.debug(`[CodexRPC] Cannot respond to request ${id} - peer is closed`);
      return;
    }

    this.writeLine(JSON.stringify({ id, result }));
  }

  /**
   * Send an error response to a server-to-client request.
   */
  respondError(id: number | string, error: { code: number; message: string; data?: unknown }): void {
    if (this.closed || !this.process?.stdin?.writable) {
      logger.debug(`[CodexRPC] Cannot respond error to request ${id} - peer is closed`);
      return;
    }

    this.writeLine(JSON.stringify({ id, error }));
  }

  /**
   * Register handler for server notifications.
   */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /**
   * Register handler for server-to-client requests (approval requests).
   */
  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /**
   * Register handler for when the peer connection closes (process exit / stdout closed).
   */
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  /**
   * Close the peer and kill the child process group.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.rejectAllPending(new Error('CodexJsonRpcPeer: peer closed'));

    this.readline?.close();
    this.readline = null;

    const child = this.process;
    const pid = child?.pid;
    if (pid && !this.exited) {
      // Close stdin first to signal the process
      child!.stdin?.end();

      // SIGTERM the entire process group (kills Codex + any bash children).
      const termResult = this.killProcessGroup(child!, pid, 'SIGTERM');

      // Skip wait only if process is confirmed dead; on failure, still wait
      // (the signal may have partially worked, or process may exit on its own)
      if (termResult !== 'dead') {
        const didExit = await Promise.race([
          this.exitPromise?.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000)),
        ]);

        // SIGKILL the process group if still alive
        if (!didExit) {
          logger.debug('[CodexRPC] Process group did not exit after SIGTERM, sending SIGKILL');
          const killResult = this.killProcessGroup(child!, pid, 'SIGKILL');

          if (killResult !== 'dead') {
            await Promise.race([
              this.exitPromise?.then(() => true),
              new Promise<false>((resolve) => setTimeout(() => resolve(false), 2000)),
            ]);
          }
        }
      }

      // Brief grace period for close event delivery before warning
      if (!this.exited) {
        await Promise.race([
          this.exitPromise?.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
        ]);
      }
      if (!this.exited) {
        logger.warn(`[CodexRPC] Process ${pid} did not confirm exit — may have leaked`);
      }
    }

    this.process = null;
  }

  /**
   * Check if the peer is still alive.
   */
  get isAlive(): boolean {
    return !this.closed && this.process !== null && !this.exited;
  }

  /**
   * Get the underlying process PID.
   */
  get pid(): number | undefined {
    return this.process?.pid;
  }

  // ─── Internal ──────────────────────────────────────────────────

  private writeLine(json: string): void {
    try {
      this.process?.stdin?.write(json + '\n');
    } catch (err) {
      // BrokenPipe is expected when the process exits
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        logger.debug(`[CodexRPC] Write error:`, err);
      }
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // Non-JSON lines (e.g. debug output from Codex)
      logger.debug(`[CodexRPC] Non-JSON stdout: ${trimmed.slice(0, 200)}`);
      return;
    }

    if (typeof msg !== 'object' || msg === null) return;

    const hasId = 'id' in msg;
    const hasMethod = 'method' in msg;
    const hasResult = 'result' in msg;
    const hasError = 'error' in msg;

    if (hasId && (hasResult || hasError)) {
      // Response to a pending request
      this.handleResponse(msg);
    } else if (hasId && hasMethod) {
      // Server-to-client request (e.g. approval requests)
      this.handleServerRequest(msg);
    } else if (hasMethod && !hasId) {
      // Notification (no id)
      this.handleNotification(msg);
    } else {
      logger.debug(`[CodexRPC] Unrecognized message shape:`, msg);
    }
  }

  private handleResponse(msg: Record<string, unknown>): void {
    const id = msg.id as number | string;
    const pending = this.pendingRequests.get(id);

    if (!pending) {
      logger.debug(`[CodexRPC] Received response for unknown request id=${id}`);
      return;
    }

    this.pendingRequests.delete(id);
    clearTimeout(pending.timer);

    if ('error' in msg && msg.error) {
      const err = msg.error as { code: number; message: string; data?: unknown };
      pending.reject(new Error(`Codex '${pending.label}' request failed: ${err.message} (code ${err.code})`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleServerRequest(msg: Record<string, unknown>): void {
    const method = msg.method as string;
    const params = msg.params;
    const id = msg.id as number | string;

    if (this.serverRequestHandler) {
      this.serverRequestHandler(method, params, id);
    } else {
      // No handler registered - respond with null to avoid blocking the server
      logger.debug(`[CodexRPC] No handler for server request '${method}', responding with null`);
      this.respond(id, null);
    }
  }

  private handleNotification(msg: Record<string, unknown>): void {
    const method = msg.method as string;
    const params = msg.params;

    if (this.notificationHandler) {
      this.notificationHandler(method, params);
    } else {
      logger.debug(`[CodexRPC] No handler for notification '${method}'`);
    }
  }

  /**
   * Kill the process group. Returns:
   * - 'sent': signal was delivered successfully
   * - 'dead': process is already dead (ESRCH / taskkill "not found")
   * - 'failed': kill attempt failed (EPERM, etc.) — caller should still wait
   */
  private killProcessGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): 'sent' | 'dead' | 'failed' {
    if (process.platform === 'win32') {
      return this.killProcessGroupWindows(pid, signal);
    }

    try {
      // Unix: kill the entire process group via negative PID
      process.kill(-pid, signal);
      return 'sent';
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        return 'dead';
      }
      // Real failure (e.g. EPERM) — log and try direct kill as degraded fallback.
      // Only kills the leader, not the full tree — treat as 'failed' so caller
      // still waits and escalates, since child processes may survive.
      logger.warn(`[CodexRPC] process.kill(-${pid}, ${signal}) failed: ${code}, falling back to direct kill`);
      try {
        child.kill(signal);
      } catch { /* already dead */ }
      return 'failed';
    }
  }

  /**
   * Windows process tree kill. Uses taskkill with two-phase approach:
   * - SIGTERM phase: graceful shutdown without /F (allows cleanup)
   * - SIGKILL phase: forced termination with /F /T (kills entire tree)
   */
  private killProcessGroupWindows(pid: number, signal: NodeJS.Signals): 'sent' | 'dead' | 'failed' {
    const cmd = signal === 'SIGKILL'
      ? `taskkill /PID ${pid} /T /F`
      : `taskkill /PID ${pid} /T`;
    try {
      execSync(cmd, { stdio: 'ignore' });
      return 'sent';
    } catch (err) {
      // taskkill exit code 128 = "not found" (process already dead).
      // Use structured status field rather than error message text.
      const status = (err as { status?: number }).status;
      if (status === 128) {
        return 'dead';
      }
      logger.warn(`[CodexRPC] taskkill failed for PID ${pid} (exit ${status}): ${err instanceof Error ? err.message : err}`);
      return 'failed';
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}
