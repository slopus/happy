import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import type { Session } from '@/api/types';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';

const PersistedHappySessionSchema = z.object({
  sessionId: z.string(),
  encryptionKeyBase64: z.string(),
  encryptionVariant: z.union([z.literal('legacy'), z.literal('dataKey')]),
  metadata: z.any(),
  metadataVersion: z.number().int().nonnegative(),
  agentState: z.any().nullable(),
  agentStateVersion: z.number().int().nonnegative(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
});

export type PersistedHappySession = z.infer<typeof PersistedHappySessionSchema>;

function sessionsDir(): string {
  return join(configuration.happyHomeDir, 'sessions');
}

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
  await rename(tmpPath, filePath);
}

export async function writePersistedHappySession(session: Session): Promise<void> {
  await ensureDir(sessionsDir());
  const now = Date.now();

  const persisted: PersistedHappySession = PersistedHappySessionSchema.parse({
    sessionId: session.id,
    encryptionKeyBase64: Buffer.from(session.encryptionKey).toString('base64'),
    encryptionVariant: session.encryptionVariant,
    metadata: session.metadata,
    metadataVersion: session.metadataVersion,
    agentState: session.agentState ?? null,
    agentStateVersion: session.agentStateVersion,
    createdAt: now,
    updatedAt: now,
  });

  const filePath = join(sessionsDir(), `${persisted.sessionId}.json`);
  await writeJsonAtomic(filePath, persisted);
}

export async function readPersistedHappySession(sessionId: string): Promise<Session | null> {
  const filePath = join(sessionsDir(), `${sessionId}.json`);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = PersistedHappySessionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logger.debug('[persistedHappySession] Failed to parse persisted session', parsed.error);
      return null;
    }

    const persisted = parsed.data;
    return {
      id: persisted.sessionId,
      seq: 0,
      metadata: persisted.metadata,
      metadataVersion: persisted.metadataVersion,
      agentState: persisted.agentState ?? null,
      agentStateVersion: persisted.agentStateVersion,
      encryptionKey: new Uint8Array(Buffer.from(persisted.encryptionKeyBase64, 'base64')),
      encryptionVariant: persisted.encryptionVariant,
    };
  } catch (e) {
    logger.debug('[persistedHappySession] Failed to read persisted session', e);
    return null;
  }
}

