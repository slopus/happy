import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

const HAPPY_TERMINAL_ENTRYPOINT = '@slopus/happy-terminal/dist/main.js';
export const HAPPY_TERMINAL_BOOT_TIMEOUT_MS = 120_000;

const require = createRequire(import.meta.url);
let bootAttempted = false;

export type HappyTerminalBootCommand = {
  command: string;
  args: string[];
};

export function buildHappyTerminalBootCommand(
  resolvedEntrypoint: string,
  nodeExecutable: string = process.execPath,
): HappyTerminalBootCommand {
  return {
    command: nodeExecutable,
    args: [resolvedEntrypoint, 'daemon', 'start'],
  };
}

export function resolveHappyTerminalEntrypoint(): string {
  return require.resolve(HAPPY_TERMINAL_ENTRYPOINT);
}

function logChildOutput(stream: NodeJS.ReadableStream | null, label: string): void {
  stream?.on('data', (chunk: Buffer | string) => {
    const text = String(chunk).trimEnd();
    if (text.length > 0) logger.debug(`[HAPPY AGENT BOOT] ${label}: ${text}`);
  });
}

/**
 * Best-effort, one-shot startup of the machine-level Happy Agent daemon.
 *
 * The child is intentionally not part of Happy daemon shutdown: the agent
 * daemon is a machine service shared with Happy Terminal and other clients.
 *
 * Off unless asked for. Happy Agent registers a machine of its own on the
 * account, and until the phone knows the two daemons are one computer, booting
 * it for everybody would split every upgraded user's laptop into two rows in
 * their picker.
 */
export function startHappyTerminalDaemon(): ChildProcess | null {
  if (!configuration.bootHappyAgent) return null;
  if (bootAttempted) return null;
  bootAttempted = true;

  let command: HappyTerminalBootCommand;
  try {
    command = buildHappyTerminalBootCommand(resolveHappyTerminalEntrypoint());
  } catch (error) {
    logger.debug('[HAPPY AGENT BOOT] Could not resolve @slopus/happy-terminal:', error);
    return null;
  }

  logger.debug(`[HAPPY AGENT BOOT] Starting: ${command.command} ${command.args.join(' ')}`);

  let child: ChildProcess;
  try {
    child = spawn(command.command, command.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    logger.debug('[HAPPY AGENT BOOT] Spawn failed; continuing without Happy Agent:', error);
    return null;
  }

  logChildOutput(child.stdout, 'stdout');
  logChildOutput(child.stderr, 'stderr');

  const timeout = setTimeout(() => {
    logger.debug(
      `[HAPPY AGENT BOOT] Startup exceeded ${HAPPY_TERMINAL_BOOT_TIMEOUT_MS}ms; leaving child running`,
    );
  }, HAPPY_TERMINAL_BOOT_TIMEOUT_MS);
  timeout.unref();

  child.once('error', (error) => {
    clearTimeout(timeout);
    logger.debug('[HAPPY AGENT BOOT] Child failed; continuing without Happy Agent:', error);
  });
  child.once('exit', (code, signal) => {
    clearTimeout(timeout);
    logger.debug(`[HAPPY AGENT BOOT] Child exited (code=${code}, signal=${signal ?? 'none'})`);
  });

  return child;
}