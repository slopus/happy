/**
 * Gemini Session Reader
 *
 * Reads and parses Gemini session JSONL files from disk.
 * Used for session resume (building context prompts from history)
 * and session fork (reading + filtering lines).
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { logger } from '@/ui/logger';
import {
  loadSessionMetadataCache,
  normalizeSessionTitle,
  saveSessionMetadataCache,
  updateSessionMetadataCacheDiagnostics,
} from '@/cache/sessionMetadataCache';
import type { SessionCacheRuntimeStats } from '@/cache/SessionCache';
import { GeminiSessionLineSchema, type GeminiSessionLine } from './sessionTypes';
import { getGeminiSessionFilePath, getGeminiSessionsDir } from './sessionWriter';

/**
 * Read and parse a Gemini session JSONL file.
 * Invalid lines are silently skipped (logged at debug level).
 */
export async function readGeminiSessionLog(sessionId: string): Promise<GeminiSessionLine[]> {
  const filePath = getGeminiSessionFilePath(sessionId);
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (error) {
    logger.debug(`[GeminiSessionReader] Session file not found: ${filePath}`);
    return [];
  }

  const lines = content.split('\n');
  const entries: GeminiSessionLine[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const result = GeminiSessionLineSchema.safeParse(parsed);
      if (result.success) {
        entries.push(result.data);
      } else {
        logger.debug(`[GeminiSessionReader] Skipping invalid line: ${line.substring(0, 100)}`);
      }
    } catch {
      logger.debug(`[GeminiSessionReader] Skipping non-JSON line: ${line.substring(0, 100)}`);
    }
  }

  return entries;
}

export interface ResumeContextOptions {
  /** Max total messages to include (default: 30) */
  maxMessages?: number;
  /** Max user messages to include (default: 15) */
  maxUserMessages?: number;
  /** Max total characters across all messages (default: 100000) */
  maxCharacters?: number;
}

/**
 * Build a resume context prompt from a session log.
 *
 * Filters to user + assistant messages, selects a window from the end
 * that fits within limits, and formats as a context block that can be
 * prepended to the first prompt of a resumed session.
 *
 * Format matches ConversationHistory.getContextForNewSession() for consistency.
 */
export interface GeminiSessionIndexEntry {
  sessionId: string;
  originalPath: string | null;
  title?: string | null;
  updatedAt?: number;
  messageCount?: number;
}

export interface SessionPreviewMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

interface GeminiSessionMetadataCacheEntry {
  fileMtimeMs: number;
  fileSize: number;
  originalPath: string | null;
  title: string | null;
  messageCount: number;
  updatedAt?: number;
}

const GEMINI_SESSION_METADATA_CACHE_VERSION = 1;
const GEMINI_SESSION_METADATA_CACHE_FILENAME = 'gemini-session-metadata-cache.json';

export async function saveGeminiSessionCacheStats(sessionCache: SessionCacheRuntimeStats): Promise<void> {
  const sessionsDir = getGeminiSessionsDir();
  await updateSessionMetadataCacheDiagnostics({
    cacheFileName: GEMINI_SESSION_METADATA_CACHE_FILENAME,
    cacheVersion: GEMINI_SESSION_METADATA_CACHE_VERSION,
    scopeKey: 'sessionsDir',
    scopeValue: sessionsDir,
    sessionCache,
  });
}

async function parseGeminiSessionMetadata(filePath: string): Promise<Omit<GeminiSessionMetadataCacheEntry, 'fileMtimeMs' | 'fileSize'>> {
  const fileStream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let originalPath: string | null = null;
  let title: string | null = null;
  let messageCount = 0;
  let updatedAt: number | undefined;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);

        if (parsed.type === 'meta' && parsed.key === 'sessionStart') {
          originalPath = typeof parsed.value?.cwd === 'string' ? parsed.value.cwd : null;
        }

        if (parsed.type === 'user') {
          messageCount++;
          if (!title && typeof parsed.message === 'string' && parsed.message.trim()) {
            title = normalizeSessionTitle(parsed.message);
          }
        }

        if (typeof parsed.timestamp === 'number') {
          updatedAt = parsed.timestamp;
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // Return partial metadata collected so far.
  } finally {
    rl.close();
    fileStream.destroy();
  }

  return { originalPath, title, messageCount, updatedAt };
}

/**
 * List all Gemini sessions from the local JSONL directory.
 * For each file, parses the first few lines to extract metadata.
 */
export async function listGeminiSessions(): Promise<GeminiSessionIndexEntry[]> {
  const sessionsDir = getGeminiSessionsDir();
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();

  let dirents: Dirent[];
  try {
    dirents = await readdir(sessionsDir, { withFileTypes: true }) as Dirent[];
  } catch {
    return [];
  }

  const existingCacheEntries = await loadSessionMetadataCache<GeminiSessionMetadataCacheEntry>({
    cacheFileName: GEMINI_SESSION_METADATA_CACHE_FILENAME,
    cacheVersion: GEMINI_SESSION_METADATA_CACHE_VERSION,
    scopeKey: 'sessionsDir',
    scopeValue: sessionsDir,
  });
  const nextCacheEntries: Record<string, GeminiSessionMetadataCacheEntry> = { ...existingCacheEntries };
  const seenCacheKeys = new Set<string>();
  let cacheDirty = false;
  let filesProcessed = 0;
  let filesReparsed = 0;
  let cacheHitCount = 0;
  let cacheMissCount = 0;
  let staleEntryCount = 0;

  const results: GeminiSessionIndexEntry[] = [];

  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.jsonl')) continue;
    filesProcessed++;

    const sessionId = dirent.name.replace(/\.jsonl$/, '');
    const filePath = getGeminiSessionFilePath(sessionId);
    seenCacheKeys.add(sessionId);

    let stats;
    try {
      stats = await stat(filePath);
    } catch {
      continue;
    }

    const cached = nextCacheEntries[sessionId];
    const isCacheValid = !!(
      cached &&
      cached.fileMtimeMs === stats.mtimeMs &&
      cached.fileSize === stats.size
    );

    let metadata: GeminiSessionMetadataCacheEntry;
    if (isCacheValid && cached) {
      cacheHitCount++;
      metadata = cached;
    } else {
      filesReparsed++;
      cacheMissCount++;
      const parsed = await parseGeminiSessionMetadata(filePath);
      metadata = {
        fileMtimeMs: stats.mtimeMs,
        fileSize: stats.size,
        ...parsed,
      };
      nextCacheEntries[sessionId] = metadata;
      cacheDirty = true;
    }

    if (metadata.messageCount === 0) continue;
    const updatedAt = metadata.updatedAt ?? stats.mtimeMs;

    results.push({
      sessionId,
      originalPath: metadata.originalPath,
      title: metadata.title,
      updatedAt,
      messageCount: metadata.messageCount,
    });
  }

  for (const cacheKey of Object.keys(nextCacheEntries)) {
    if (seenCacheKeys.has(cacheKey)) continue;
    delete nextCacheEntries[cacheKey];
    cacheDirty = true;
    staleEntryCount++;
  }

  results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  if (cacheDirty) {
    await saveSessionMetadataCache({
      cacheFileName: GEMINI_SESSION_METADATA_CACHE_FILENAME,
      cacheVersion: GEMINI_SESSION_METADATA_CACHE_VERSION,
      scopeKey: 'sessionsDir',
      scopeValue: sessionsDir,
      entries: nextCacheEntries,
      lastRun: {
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        filesProcessed,
        filesReparsed,
        cacheHitCount,
        cacheMissCount,
        staleEntryCount,
        resultCount: results.length,
        cacheEntryCount: Object.keys(nextCacheEntries).length,
      },
    });
  }

  return results;
}

/**
 * Get preview messages (user + assistant) from a Gemini session.
 * Returns the last N messages in chronological order.
 */
export async function getGeminiSessionPreview(
  sessionId: string,
  limit: number = 10,
): Promise<SessionPreviewMessage[]> {
  const lines = await readGeminiSessionLog(sessionId);

  const messages: SessionPreviewMessage[] = [];
  for (const line of lines) {
    if (line.type === 'user' || line.type === 'assistant') {
      messages.push({
        role: line.type,
        content: line.message,
        timestamp: new Date(line.timestamp).toISOString(),
      });
    }
  }

  return messages.slice(-limit);
}

export function buildResumeContextFromSessionLog(
  lines: GeminiSessionLine[],
  options?: ResumeContextOptions,
): string {
  const maxMessages = options?.maxMessages ?? 30;
  const maxUserMessages = options?.maxUserMessages ?? 15;
  const maxCharacters = options?.maxCharacters ?? 100_000;

  // Filter to user and assistant lines only
  const conversationLines = lines.filter(
    (l): l is Extract<GeminiSessionLine, { type: 'user' | 'assistant' }> =>
      l.type === 'user' || l.type === 'assistant',
  );

  if (conversationLines.length === 0) return '';

  // Select from end, respecting limits
  const selected: typeof conversationLines = [];
  let totalCount = 0;
  let userCount = 0;
  let totalChars = 0;

  for (let i = conversationLines.length - 1; i >= 0; i--) {
    const line = conversationLines[i];
    const msgLength = line.message.length;

    if (totalChars + msgLength > maxCharacters && selected.length > 0) break;

    selected.push(line);
    totalCount++;
    totalChars += msgLength;
    if (line.type === 'user') userCount++;

    if (userCount >= maxUserMessages) break;
    if (totalCount >= maxMessages && line.type === 'user') break;
  }

  selected.reverse();

  if (selected.length === 0) return '';

  const formattedMessages = selected.map((msg) => {
    const role = msg.type === 'user' ? 'User' : 'Assistant';
    const content = msg.message.length > 2000
      ? msg.message.substring(0, 2000) + '... [truncated]'
      : msg.message;
    return `${role}: ${content}`;
  }).join('\n\n');

  return `[PREVIOUS SESSION CONTEXT]
The following is our previous conversation. Continue from where we left off:

${formattedMessages}

[END OF PREVIOUS CONTEXT]

`;
}
