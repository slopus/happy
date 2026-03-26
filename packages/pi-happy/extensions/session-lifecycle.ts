import { readFile } from 'node:fs/promises';
import os from 'node:os';

import axios from 'axios';

import type { PiHappySettings } from './settings';
import type { HappySessionAgentState, HappySessionMetadata } from './happy-session-client';
import type { PiHappyConfig, PiHappyExtensionContext } from './types';
import type { PiHappyMetadataPatch } from './metadata-sync';

export const KEEPALIVE_INTERVAL_MS = 2_000;

export type DaemonStateFile = {
  httpPort?: number;
};

export type PiHappyRuntimeSession = {
  keepAliveTimer: ReturnType<typeof setInterval> | null;
  thinking: boolean;
};

export function buildInitialAgentState(): HappySessionAgentState {
  return {
    controlledByUser: false,
  };
}

export function buildSessionMetadata(
  ctx: Pick<PiHappyExtensionContext, 'cwd'>,
  config: PiHappyConfig,
  settings: PiHappySettings,
  packageVersion: string,
  metadataPatch: PiHappyMetadataPatch,
): HappySessionMetadata {
  return {
    path: ctx.cwd,
    host: os.hostname(),
    version: packageVersion,
    os: os.platform(),
    machineId: settings.machineId,
    homeDir: os.homedir(),
    happyHomeDir: config.happyHomeDir,
    happyLibDir: '',
    happyToolsDir: '',
    startedFromDaemon: false,
    hostPid: process.pid,
    startedBy: 'terminal',
    lifecycleState: 'running',
    lifecycleStateSince: Date.now(),
    flavor: 'pi',
    sandbox: null,
    dangerouslySkipPermissions: null,
    ...metadataPatch,
  };
}

export async function readDaemonPort(daemonStateFile: string): Promise<number | undefined> {
  try {
    const raw = await readFile(daemonStateFile, 'utf8');
    const parsed = JSON.parse(raw) as DaemonStateFile;
    return typeof parsed.httpPort === 'number' && Number.isFinite(parsed.httpPort)
      ? parsed.httpPort
      : undefined;
  } catch {
    return undefined;
  }
}

export async function notifyDaemonSessionStarted(
  daemonStateFile: string,
  sessionId: string,
  metadata: HappySessionMetadata,
): Promise<boolean> {
  const daemonPort = await readDaemonPort(daemonStateFile);
  if (!daemonPort) {
    return false;
  }

  await axios.post(`http://127.0.0.1:${daemonPort}/session-started`, {
    sessionId,
    metadata,
  }, {
    timeout: 5_000,
  });
  return true;
}

export function startKeepAliveLoop(
  session: PiHappyRuntimeSession,
  callback: () => void,
  intervalMs: number = KEEPALIVE_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  stopKeepAliveLoop(session);
  const timer = setInterval(callback, intervalMs);
  timer.unref?.();
  session.keepAliveTimer = timer;
  return timer;
}

export function stopKeepAliveLoop(session: PiHappyRuntimeSession): void {
  if (session.keepAliveTimer) {
    clearInterval(session.keepAliveTimer);
    session.keepAliveTimer = null;
  }
}
