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

function sessionFilePath(happyHomeDir: string, sessionId: string): string {
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
  const path = sessionFilePath(params.happyHomeDir, params.sessionId);
  try {
    const raw = await readFile(path, 'utf8');
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

