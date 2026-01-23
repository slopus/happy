import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Metadata } from '@/api/types';

export type TerminalAttachmentInfo = {
  version: 1;
  sessionId: string;
  terminal: NonNullable<Metadata['terminal']>;
  updatedAt: number;
};

function sessionsDir(happyHomeDir: string): string {
  return join(happyHomeDir, 'terminal', 'sessions');
}

function sessionIdToFilename(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

function sessionFilePath(happyHomeDir: string, sessionId: string): string {
  return join(sessionsDir(happyHomeDir), `${sessionIdToFilename(sessionId)}.json`);
}

function legacySessionFilePath(happyHomeDir: string, sessionId: string): string {
  return join(sessionsDir(happyHomeDir), `${sessionId}.json`);
}

export async function writeTerminalAttachmentInfo(params: {
  happyHomeDir: string;
  sessionId: string;
  terminal: NonNullable<Metadata['terminal']>;
}): Promise<void> {
  const dir = sessionsDir(params.happyHomeDir);
  await mkdir(dir, { recursive: true });

  const info: TerminalAttachmentInfo = {
    version: 1,
    sessionId: params.sessionId,
    terminal: params.terminal,
    updatedAt: Date.now(),
  };

  const path = sessionFilePath(params.happyHomeDir, params.sessionId);
  const tmpPath = `${path}.tmp`;

  await writeFile(tmpPath, JSON.stringify(info, null, 2), 'utf8');
  await rename(tmpPath, path);
}

export async function readTerminalAttachmentInfo(params: {
  happyHomeDir: string;
  sessionId: string;
}): Promise<TerminalAttachmentInfo | null> {
  try {
    const encodedPath = sessionFilePath(params.happyHomeDir, params.sessionId);
    let raw: string;
    try {
      raw = await readFile(encodedPath, 'utf8');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code !== 'ENOENT') throw e;
      // Only allow legacy fallback for filename-safe session ids. The legacy filename
      // used the raw sessionId, so path separators would allow traversal outside the
      // intended sessions directory.
      if (params.sessionId.includes('/') || params.sessionId.includes('\\')) throw e;
      const legacyPath = legacySessionFilePath(params.happyHomeDir, params.sessionId);
      if (legacyPath === encodedPath) throw e;
      raw = await readFile(legacyPath, 'utf8');
    }
    const parsed = JSON.parse(raw) as Partial<TerminalAttachmentInfo> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== 1) return null;
    if (parsed.sessionId !== params.sessionId) return null;
    if (!parsed.terminal || typeof parsed.terminal !== 'object') return null;
    if (parsed.terminal.mode !== 'plain' && parsed.terminal.mode !== 'tmux') return null;
    return parsed as TerminalAttachmentInfo;
  } catch {
    return null;
  }
}
