import { mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuration } from '@/configuration';

export type SessionExitReport = {
  observedAt: number;
  observedBy: 'daemon' | 'session';
  reason: string;
  code?: number | null;
  signal?: string | null;
  lastRpcMethod?: string | null;
  lastRpcAt?: number | null;
  error?: string | null;
};

/**
 * Persist a small, structured "why did this session stop?" record to disk.
 *
 * This is intentionally local-only so we can keep richer diagnostics without
 * expanding server schema or leaking sensitive details.
 */
export async function writeSessionExitReport(opts: {
  baseDir?: string;
  sessionId?: string | null;
  pid: number;
  report: SessionExitReport;
}): Promise<string> {
  const baseDir = opts.baseDir ?? join(configuration.happyHomeDir, 'logs', 'session-exit');
  await mkdir(baseDir, { recursive: true });

  const sessionPart = opts.sessionId ? `session-${opts.sessionId}` : 'session-unknown';
  const path = join(baseDir, `${sessionPart}-pid-${opts.pid}.json`);

  const payload = {
    sessionId: opts.sessionId ?? null,
    pid: opts.pid,
    ...opts.report,
  };

  await writeFile(path, JSON.stringify(payload, null, 2), 'utf8');
  return path;
}

export function writeSessionExitReportSync(opts: {
  baseDir?: string;
  sessionId?: string | null;
  pid: number;
  report: SessionExitReport;
}): string {
  const baseDir = opts.baseDir ?? join(configuration.happyHomeDir, 'logs', 'session-exit');
  mkdirSync(baseDir, { recursive: true });

  const sessionPart = opts.sessionId ? `session-${opts.sessionId}` : 'session-unknown';
  const path = join(baseDir, `${sessionPart}-pid-${opts.pid}.json`);

  const payload = {
    sessionId: opts.sessionId ?? null,
    pid: opts.pid,
    ...opts.report,
  };

  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8');
  return path;
}
