/**
 * chat-tool-output-streaming Phase 3 — bash_stream MCP tool internals.
 *
 * Spawns a single `bash -c <command>` subprocess and forwards its stdout/
 * stderr line-by-line to the caller via an onProgress callback while still
 * collecting an aggregate output for the eventual MCP tool result. The
 * caller (the in-process Happy MCP HTTP handler) feeds those progress
 * batches through `AcpSessionManager.emitProgress(...)` so the daemon can
 * publish `tool-call-progress` envelopes addressed to the live tool call.
 *
 * MVP scope: single-line shell commands. Heredocs, multiline scripts,
 * timeouts, and cancellation are intentionally out of scope — the system
 * prompt steers the agent to fall back to Claude's built-in Bash for those.
 */

import { spawn } from 'node:child_process';

const FLUSH_INTERVAL_MS = 200;
const FLUSH_LINE_BATCH = 32;
const MAX_LINE_BYTES = 4096;
const TRUNCATED_SUFFIX = '… (truncated)';

export interface BashStreamProgress {
  stream: 'stdout' | 'stderr';
  lines: string[];
}

export interface RunBashStreamInput {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onProgress: (progress: BashStreamProgress) => void;
}

export interface RunBashStreamResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

class StreamLineBuffer {
  private remainder = '';
  private pending: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly stream: 'stdout' | 'stderr',
    private readonly onProgress: (progress: BashStreamProgress) => void,
  ) {}

  push(chunk: string): void {
    const combined = this.remainder + chunk;
    const lines = combined.split('\n');
    this.remainder = lines.pop() ?? '';
    for (const line of lines) {
      this.pending.push(capLine(line));
    }
    if (this.pending.length >= FLUSH_LINE_BATCH) {
      this.flush();
      return;
    }
    if (this.pending.length > 0 && !this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  /** Called once at process exit — emits any trailing partial line. */
  close(): void {
    if (this.remainder.length > 0) {
      this.pending.push(capLine(this.remainder));
      this.remainder = '';
    }
    this.flush();
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0) return;
    const lines = this.pending;
    this.pending = [];
    this.onProgress({ stream: this.stream, lines });
  }
}

function capLine(text: string): string {
  if (text.length <= MAX_LINE_BYTES) return text;
  return text.slice(0, MAX_LINE_BYTES - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX;
}

export async function runBashStream(input: RunBashStreamInput): Promise<RunBashStreamResult> {
  const { command, cwd, env, onProgress } = input;
  return new Promise<RunBashStreamResult>((resolve, reject) => {
    const child = spawn('bash', ['-c', command], {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutAggregate = '';
    let stderrAggregate = '';
    const stdoutBuf = new StreamLineBuffer('stdout', onProgress);
    const stderrBuf = new StreamLineBuffer('stderr', onProgress);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutAggregate += chunk;
      stdoutBuf.push(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderrAggregate += chunk;
      stderrBuf.push(chunk);
    });

    child.on('error', (err) => {
      stdoutBuf.close();
      stderrBuf.close();
      reject(err);
    });

    child.on('close', (code) => {
      stdoutBuf.close();
      stderrBuf.close();
      resolve({
        exitCode: code ?? -1,
        stdout: stdoutAggregate,
        stderr: stderrAggregate,
      });
    });
  });
}
