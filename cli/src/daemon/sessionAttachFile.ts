import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export type SessionAttachFilePayload = {
  encryptionKeyBase64: string;
  encryptionVariant: 'dataKey';
};

function sanitizeHappySessionIdForFilename(happySessionId: string): string {
  const safe = happySessionId.replace(/[^A-Za-z0-9._-]+/g, '_');
  const trimmed = safe
    .replace(/_+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[_-]+$/, '');

  const normalized = trimmed.length > 0 ? trimmed : 'session';
  return normalized.length > 96 ? normalized.slice(0, 96) : normalized;
}

function assertPathWithinBaseDir(baseDir: string, filePath: string): void {
  const rel = relative(baseDir, filePath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Invalid session attach file path');
  }
}

export async function createSessionAttachFile(params: {
  happySessionId: string;
  payload: SessionAttachFilePayload;
}): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const baseDir = resolve(join(configuration.happyHomeDir, 'tmp', 'session-attach'));
  await mkdir(baseDir, { recursive: true });

  const safeSessionId = sanitizeHappySessionIdForFilename(params.happySessionId);
  const filePath = resolve(join(baseDir, `${safeSessionId}-${randomUUID()}.json`));
  assertPathWithinBaseDir(baseDir, filePath);

  const payloadJson = JSON.stringify(params.payload);
  await writeFile(filePath, payloadJson, { mode: 0o600 });

  const cleanup = async () => {
    try {
      await unlink(filePath);
    } catch {
      // ignore
    }
  };

  logger.debug('[daemon] Created session attach file', { filePath });

  return { filePath, cleanup };
}
