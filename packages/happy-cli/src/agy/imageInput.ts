import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { ApiSessionClient } from '@/api/apiSession';
import type { FileEventMessage } from '@/api/types';
import { detectSupportedImageType } from '@/codex/utils/imageInput';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import type { PendingAttachment } from '@/utils/MessageQueue2';

type AgyAttachmentDownloader = Pick<ApiSessionClient, 'downloadAndDecryptAttachment'>;

export interface PreparedAgyImagePrompt {
  prompt: string;
  imagePaths: string[];
  cacheDir: string | null;
  skipped: number;
}

export async function downloadAgyFileEventAttachment(
  session: AgyAttachmentDownloader,
  fileEvent: FileEventMessage,
): Promise<PendingAttachment | null> {
  const ev = fileEvent.content.data.ev;
  try {
    const decrypted = await session.downloadAndDecryptAttachment(ev.ref);
    if (!decrypted) {
      logger.debug('[agy] Failed to decrypt attachment');
      return null;
    }
    return {
      data: decrypted,
      mimeType: ev.mimeType ?? 'image/jpeg',
      name: ev.name,
    };
  } catch (error) {
    logger.debug('[agy] Failed to download attachment', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
}

function sanitizeCachePathSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[\\/]+/g, '_')
    .replace(/\.+/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized.length > 0 ? sanitized : 'unknown-session';
}

export function resolveAgyImageCacheDir(opts: {
  sessionId: string;
  cacheRootDir?: string;
}): string {
  const cacheRoot = resolve(opts.cacheRootDir ?? join(configuration.happyHomeDir, 'agy-image-cache'));
  const sessionKey = sanitizeCachePathSegment(opts.sessionId);
  const cacheDir = resolve(cacheRoot, sessionKey);
  const relativePath = relative(cacheRoot, cacheDir);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return join(cacheRoot, 'invalid-session');
  }
  return cacheDir;
}

export async function cleanupAgyImageCacheDir(opts: {
  sessionId: string;
  cacheRootDir?: string;
}): Promise<void> {
  const cacheDir = resolveAgyImageCacheDir(opts);
  try {
    await rm(cacheDir, { recursive: true, force: true });
  } catch (error) {
    logger.debug('[agy] Failed to clean up image cache dir', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

export async function prepareAgyImagePrompt(opts: {
  message: string;
  attachments?: PendingAttachment[];
  sessionId: string;
  cacheRootDir?: string;
}): Promise<PreparedAgyImagePrompt> {
  const attachments = opts.attachments;
  if (!attachments || attachments.length === 0) {
    return {
      prompt: opts.message,
      imagePaths: [],
      cacheDir: null,
      skipped: 0,
    };
  }

  const cacheDir = resolveAgyImageCacheDir({
    sessionId: opts.sessionId,
    cacheRootDir: opts.cacheRootDir,
  });
  const imagePaths: string[] = [];
  let skipped = 0;

  for (const attachment of attachments) {
    const detected = detectSupportedImageType(attachment.data);
    if (!detected) {
      logger.debug('[agy] Skipping unsupported image attachment', {
        mimeType: attachment.mimeType,
        size: attachment.data.length,
      });
      skipped += 1;
      continue;
    }

    try {
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      await chmod(cacheDir, 0o700);
      const filePath = join(cacheDir, `${randomUUID()}.${detected.extension}`);
      await writeFile(filePath, Buffer.from(attachment.data), { mode: 0o600 });
      imagePaths.push(filePath);
    } catch (error) {
      logger.debug('[agy] Failed to cache image attachment', {
        mimeType: detected.mimeType,
        size: attachment.data.length,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      skipped += 1;
    }
  }

  if (imagePaths.length === 0) {
    return {
      prompt: opts.message,
      imagePaths: [],
      cacheDir: null,
      skipped,
    };
  }

  const fileList = imagePaths.map((p) => `- ${p}`).join('\n');
  const attachmentHeader = `Attached image file(s) (read them with \`read_file\` before answering):\n${fileList}`;
  const trimmedMessage = opts.message.trim();
  const prompt = trimmedMessage.length > 0
    ? `${attachmentHeader}\n\n${opts.message}`
    : `${attachmentHeader}\n\nInspect the attached image(s) and help with them.`;

  return {
    prompt,
    imagePaths,
    cacheDir,
    skipped,
  };
}
