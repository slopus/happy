import { decodeBase64 } from '@/api/encryption';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { readFile, unlink, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import * as z from 'zod';

const SessionAttachPayloadSchema = z.object({
  encryptionKeyBase64: z.string().min(1),
  encryptionVariant: z.union([z.literal('legacy'), z.literal('dataKey')]),
});

export type SessionAttachPayload = z.infer<typeof SessionAttachPayloadSchema>;

export async function readSessionAttachFromEnv(): Promise<{ encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' } | null> {
  const rawPath = typeof process.env.HAPPY_SESSION_ATTACH_FILE === 'string' ? process.env.HAPPY_SESSION_ATTACH_FILE.trim() : '';
  if (!rawPath) return null;

  const filePath = resolve(rawPath);

  // Basic safety: require attach file to live within HAPPY_HOME_DIR.
  // This prevents accidental reads from arbitrary locations when a user sets env vars manually.
  if (!filePath.startsWith(resolve(configuration.happyHomeDir) + sep)) {
    throw new Error('Invalid session attach file location');
  }

  try {
    if (process.platform !== 'win32') {
      const s = await stat(filePath);
      // Ensure file is not readable by group/others (0600).
      if ((s.mode & 0o077) !== 0) {
        throw new Error('Session attach file permissions are too permissive');
      }
    }

    const raw = await readFile(filePath, 'utf-8');
    const parsed = SessionAttachPayloadSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logger.debug('[sessionAttach] Failed to parse attach file', parsed.error);
      throw new Error('Invalid session attach file');
    }

    const payload = parsed.data;
    const key = decodeBase64(payload.encryptionKeyBase64, 'base64');
    if (key.length !== 32) {
      throw new Error('Invalid session encryption key length');
    }

    return { encryptionKey: key, encryptionVariant: payload.encryptionVariant };
  } finally {
    // Best-effort cleanup to keep the key short-lived on disk.
    try {
      await unlink(filePath);
    } catch {
      // ignore
    }
  }
}
