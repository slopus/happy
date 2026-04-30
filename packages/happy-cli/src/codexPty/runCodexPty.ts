/**
 * Codex PTY Runner
 *
 * Spawns the native `codex-pty` tool (shipped in happy-cli tools) and bridges:
 * - Happy user messages -> PTY stdin (JSONL)
 * - PTY transcript blocks -> Happy ACP messages
 */

import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { configuration } from '@/configuration';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { initialMachineMetadata } from '@/daemon/run';
import type { Credentials } from '@/persistence';
import { readSettings } from '@/persistence';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { connectionState } from '@/utils/serverConnectionErrors';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { logger } from '@/ui/logger';

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';

type CodexPtyInMsg =
  | { type: 'input'; text: string }
  | { type: 'raw'; bytes: number[] }
  | { type: 'shutdown' };

type CodexPtyOutMsg =
  | { type: 'transcript'; text: string }
  | { type: 'status'; message: string }
  | { type: 'error'; message: string };

function getCodexPtyBinaryPath(happyToolsDir: string): string {
  const exe = process.platform === 'win32' ? 'codex-pty.exe' : 'codex-pty';
  return join(happyToolsDir, exe);
}

function createTranscriptBatcher(opts: {
  flushMs: number;
  send: (text: string) => void;
}): { push: (text: string) => void; flush: () => void; stop: () => void } {
  let buf: string[] = [];
  let timer: NodeJS.Timeout | null = null;

  const flush = () => {
    if (buf.length === 0) return;
    const combined = buf.join('');
    buf = [];
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    opts.send(combined);
  };

  const push = (text: string) => {
    if (!text) return;
    buf.push(text);
    if (!timer) {
      timer = setTimeout(() => flush(), opts.flushMs);
    }
  };

  const stop = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return { push, flush, stop };
}

export async function runCodexPty(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  ptyCols?: number;
  ptyRows?: number;
}): Promise<void> {
  const sessionTag = randomUUID();
  connectionState.setBackend('Codex PTY');

  const api = await ApiClient.create(opts.credentials);

  const settings = await readSettings();
  const machineId = settings?.machineId;

  if (!machineId) {
    console.error(
      '[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue.'
    );
    process.exit(1);
  }

  await api.getOrCreateMachine({
    machineId,
    metadata: initialMachineMetadata,
  });

  const { state, metadata } = createSessionMetadata({
    flavor: 'codex',
    machineId,
    startedBy: opts.startedBy,
    sandbox: settings?.sandboxConfig,
  });

  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

  let session: ApiSessionClient;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
    },
  });
  session = initialSession;

  if (response) {
    try {
      logger.debug(`[codex-pty] Reporting session ${response.id} to daemon`);
      await notifyDaemonSessionStarted(response.id, metadata);
    } catch (error) {
      logger.debug('[codex-pty] Failed to report to daemon (may not be running):', error);
    }

    console.log(`codex-pty: happy session id: ${response.id}`);
    console.log(`${configuration.webappUrl}/session/${response.id}`);
  } else {
    console.log(`codex-pty: offline session id: ${session.sessionId}`);
    console.log('codex-pty: server unreachable; transcript will not sync until reconnect');
  }

  // Keep-alive
  let thinking = false;
  session.keepAlive(thinking, 'remote');
  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  const toolPath = getCodexPtyBinaryPath(metadata.happyToolsDir);
  if (!fs.existsSync(toolPath)) {
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();
    throw new Error(`codex-pty tool not found at ${toolPath}`);
  }

  const toolArgs: string[] = [];
  if (typeof opts.ptyCols === 'number') {
    toolArgs.push('--pty-cols', String(opts.ptyCols));
  }
  if (typeof opts.ptyRows === 'number') {
    toolArgs.push('--pty-rows', String(opts.ptyRows));
  }

  logger.debug('[codex-pty] Spawning tool', { toolPath, toolArgs });

  const child = spawn(toolPath, toolArgs, {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: process.env,
  });

  if (!child.stdin || !child.stdout) {
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();
    throw new Error('codex-pty stdio is not available');
  }

  let isShuttingDown = false;

  const sendToTool = async (msg: CodexPtyInMsg): Promise<void> => {
    if (isShuttingDown) return;
    if (!child.stdin.writable) return;

    const line = JSON.stringify(msg) + '\n';
    if (!child.stdin.write(line)) {
      await once(child.stdin, 'drain');
    }
  };

  const batcher = createTranscriptBatcher({
    flushMs: 200,
    send: (text) => {
      if (!text.trim()) return;
      session.sendAgentMessage('codex', { type: 'message', message: text });
    },
  });

  async function handleAbort() {
    try {
      // Codex UI shows "esc to interrupt".
      await sendToTool({ type: 'raw', bytes: [0x1b] });
    } catch (error) {
      logger.debug('[codex-pty] Abort failed:', error);
    }
  }

  async function handleKillSession() {
    if (isShuttingDown) return;
    isShuttingDown = true;

    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();

    batcher.flush();
    batcher.stop();

    try {
      await sendToTool({ type: 'shutdown' });
    } catch {
      // Ignore
    }

    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore
    }

    try {
      session.sendSessionDeath();
    } catch {
      // Ignore
    }

    // Ensure process terminates (matches other backends)
    process.exit(0);
  }

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

  // Forward user messages from Happy to the tool.
  session.onUserMessage((message) => {
    if (!message.content.text) {
      return;
    }
    void sendToTool({ type: 'input', text: message.content.text });
  });

  // Read JSONL transcript from tool and forward to Happy.
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line) return;

    let msg: CodexPtyOutMsg;
    try {
      msg = JSON.parse(line) as CodexPtyOutMsg;
    } catch {
      logger.debug('[codex-pty] Failed to parse tool JSONL line', { line });
      return;
    }

    if (msg.type === 'transcript') {
      batcher.push(msg.text);
      return;
    }

    if (msg.type === 'error') {
      logger.debug('[codex-pty] Tool error:', msg.message);
      session.sendAgentMessage('codex', { type: 'message', message: `codex-pty error: ${msg.message}\n` });
      return;
    }

    if (msg.type === 'status') {
      logger.debug('[codex-pty] Tool status:', msg.message);
    }
  });

  child.on('exit', (code, signal) => {
    logger.debug('[codex-pty] Tool exited', { code, signal });
    batcher.flush();
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();

    if (!isShuttingDown) {
      // Keep a minimal marker in the session.
      session.sendAgentMessage('codex', {
        type: 'message',
        message: `codex-pty exited (${signal || code || 0})\n`,
      });
    }

    // Match backend behavior: tool exit ends the session.
    process.exit(code ?? 0);
  });
}
