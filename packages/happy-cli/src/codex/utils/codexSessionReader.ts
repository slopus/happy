/**
 * Codex Session Reader
 *
 * Reads user messages from Codex CLI's native JSONL session files.
 * Codex stores sessions at ~/.codex/sessions/{yyyy}/{mm}/{dd}/rollout-{datetime}-{conversationId}.jsonl
 *
 * The JSONL format uses these line types:
 * - session_meta: session metadata
 * - response_item: messages (role: 'user' | 'assistant'), tool calls, etc.
 * - event_msg: streaming events
 * - turn_context: turn-level context
 * - compacted: compaction markers
 */

import fs, { createReadStream } from 'node:fs';
import { readFile, stat as statFile } from 'node:fs/promises';
import os from 'node:os';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { logger } from '@/ui/logger';
import {
  loadSessionMetadataCache,
  normalizeSessionTitle,
  saveSessionMetadataCache,
  updateSessionMetadataCacheDiagnostics,
} from '@/cache/sessionMetadataCache';
import type { SessionCacheRuntimeStats } from '@/cache/SessionCache';

export interface CodexUserMessage {
  uuid: string;
  content: string;
  timestamp: string;
  index: number;
}

/**
 * Find Codex's native JSONL session file by conversationId.
 * Searches ~/.codex/sessions/ recursively for files ending with -{codexSessionId}.jsonl
 */
export function findCodexSessionFile(codexSessionId: string): string | null {
  if (!codexSessionId) return null;
  try {
    const codexHomeDir = process.env.CODEX_HOME || join(os.homedir(), '.codex');
    const rootDir = join(codexHomeDir, 'sessions');

    const query = codexSessionId.trim();
    const candidates = collectFilesRecursive(rootDir)
      .filter(full => {
        try {
          if (!fs.statSync(full).isFile()) return false;
        } catch {
          return false;
        }
        const rawId = extractSessionIdFromFilename(full);
        if (!rawId) return false;
        return rawId === query || rawId.endsWith(query);
      })
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return candidates[0] || null;
  } catch {
    return null;
  }
}

function collectFilesRecursive(dir: string, acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursive(full, acc);
    } else if (entry.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

function extractSessionIdFromFilename(filePath: string): string | null {
  const name = basename(filePath);
  const uuidSuffix = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  if (uuidSuffix?.[1]) return uuidSuffix[1];

  const fallback = name.match(/^rollout-(.+)\.jsonl$/);
  if (!fallback?.[1]) return null;
  return fallback[1].trim() || null;
}

function extractDisplaySessionId(rawSessionId: string): string {
  const lastSegment = rawSessionId.split('-').filter(Boolean).at(-1) || rawSessionId;
  return lastSegment.slice(-6);
}

/**
 * Generate a stable UUID-like identifier from timestamp + index.
 * Uses a deterministic hash so the same message always gets the same ID across reads.
 * Exported for use by codexSessionFork.ts truncation logic.
 */
export function generateStableUuid(timestamp: string, index: number): string {
  const hash = createHash('sha256').update(`codex:${timestamp}:${index}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Extract text content from a Codex response_item payload.
 * Exported for use by codexSessionFork.ts truncation logic.
 */
export function extractUserText(payload: any): string | null {
  const content = payload?.content;
  if (!content) return null;

  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        texts.push(block);
      } else if (block?.type === 'input_text' && typeof block.text === 'string') {
        texts.push(block.text);
      }
    }
    return texts.join('\n') || null;
  }

  return null;
}

/**
 * Detect system/environment messages that shouldn't appear in the user message picker.
 * Exported for use by codexSessionFork.ts truncation logic.
 */
export function isSystemMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith('# AGENTS.md') ||
    trimmed.startsWith('<environment_context') ||
    trimmed.startsWith('<INSTRUCTIONS>') ||
    trimmed.startsWith('# System instructions')
  );
}

/**
 * Read user messages from a Codex session's native JSONL file.
 *
 * Codex JSONL uses response_item lines with payload.role === 'user'.
 * User content is in payload.content (array of { type: 'input_text', text: string }).
 *
 * Skips system/environment messages (AGENTS.md instructions, environment_context, etc.)
 */
export async function readCodexSessionUserMessages(
  codexSessionId: string,
  limit: number = 50,
): Promise<CodexUserMessage[]> {
  const filePath = findCodexSessionFile(codexSessionId);
  if (!filePath) {
    logger.debug(`[CodexSessionReader] Session file not found for: ${codexSessionId}`);
    return [];
  }

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (error) {
    logger.debug(`[CodexSessionReader] Failed to read file: ${filePath}`, error);
    return [];
  }

  const lines = content.split('\n');
  const messages: CodexUserMessage[] = [];
  let userIndex = 0;

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line);

      if (parsed.type === 'response_item' && parsed.payload?.role === 'user') {
        const text = extractUserText(parsed.payload);
        if (!text) continue;

        // Skip system messages
        if (isSystemMessage(text)) continue;

        const timestamp = parsed.timestamp || '';
        messages.push({
          uuid: generateStableUuid(timestamp, userIndex),
          content: text.length > 500 ? text.substring(0, 500) + '...' : text,
          timestamp,
          index: userIndex,
        });
        userIndex++;
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  return messages.slice(-limit);
}

export interface CodexSessionIndexEntry {
  sessionId: string;
  originalPath: string | null;
  title?: string | null;
  updatedAt?: number;
  messageCount?: number;
  gitBranch?: string | null;
}

export interface CodexPreviewMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

interface CodexSessionMetadataCacheEntry {
  fileMtimeMs: number;
  fileSize: number;
  sessionId: string;
  originalPath: string | null;
  title: string | null;
  updatedAt?: number;
  messageCount: number;
  gitBranch?: string | null;
}

const CODEX_SESSION_METADATA_CACHE_VERSION = 1;
const CODEX_SESSION_METADATA_CACHE_FILENAME = 'codex-session-metadata-cache.json';

export async function saveCodexSessionCacheStats(sessionCache: SessionCacheRuntimeStats): Promise<void> {
  const codexHomeDir = process.env.CODEX_HOME || join(os.homedir(), '.codex');
  const rootDir = join(codexHomeDir, 'sessions');
  await updateSessionMetadataCacheDiagnostics({
    cacheFileName: CODEX_SESSION_METADATA_CACHE_FILENAME,
    cacheVersion: CODEX_SESSION_METADATA_CACHE_VERSION,
    scopeKey: 'rootDir',
    scopeValue: rootDir,
    sessionCache,
  });
}

async function parseCodexSessionMetadata(filePath: string): Promise<Omit<CodexSessionMetadataCacheEntry, 'fileMtimeMs' | 'fileSize'> | null> {
  const fileStream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const fileSessionId = extractSessionIdFromFilename(filePath);
  let sessionId: string | null = null;
  let originalPath: string | null = null;
  let updatedAt: number | undefined;
  let gitBranch: string | null = null;
  let title: string | null = null;
  let messageCount = 0;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);

        if (parsed.type === 'session_meta') {
          const payload = parsed.payload;
          sessionId = typeof payload?.id === 'string' ? payload.id : null;
          originalPath = typeof payload?.cwd === 'string' ? payload.cwd : null;
          gitBranch = typeof payload?.git?.branch === 'string' ? payload.git.branch : null;
          if (typeof payload?.timestamp === 'string') {
            const ts = Date.parse(payload.timestamp);
            if (!Number.isNaN(ts)) {
              updatedAt = ts;
            }
          }
        }

        if (parsed.type === 'response_item' && parsed.payload?.role === 'user') {
          const text = extractUserText(parsed.payload);
          if (text && !isSystemMessage(text)) {
            messageCount++;
            if (!title) {
              title = normalizeSessionTitle(text);
            }
          }
        }

        if (typeof parsed.timestamp === 'string') {
          const ts = Date.parse(parsed.timestamp);
          if (!Number.isNaN(ts)) updatedAt = ts;
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

  const rawSessionId = fileSessionId || sessionId;
  const displaySessionId = rawSessionId ? extractDisplaySessionId(rawSessionId) : null;
  if (!displaySessionId || messageCount === 0) {
    return null;
  }

  return {
    sessionId: displaySessionId,
    originalPath,
    title,
    updatedAt,
    messageCount,
    gitBranch,
  };
}

/**
 * List all Codex sessions from the native session directory.
 * Scans ~/.codex/sessions/ recursively, reads first line (session_meta) and
 * counts user messages for each JSONL file.
 */
export async function listCodexSessions(): Promise<CodexSessionIndexEntry[]> {
  const codexHomeDir = process.env.CODEX_HOME || join(os.homedir(), '.codex');
  const rootDir = join(codexHomeDir, 'sessions');
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();

  const files = collectFilesRecursive(rootDir).filter(f => f.endsWith('.jsonl'));
  const existingCacheEntries = await loadSessionMetadataCache<CodexSessionMetadataCacheEntry>({
    cacheFileName: CODEX_SESSION_METADATA_CACHE_FILENAME,
    cacheVersion: CODEX_SESSION_METADATA_CACHE_VERSION,
    scopeKey: 'rootDir',
    scopeValue: rootDir,
  });
  const nextCacheEntries: Record<string, CodexSessionMetadataCacheEntry> = { ...existingCacheEntries };
  const seenCacheKeys = new Set<string>();
  let cacheDirty = false;
  let filesReparsed = 0;
  let cacheHitCount = 0;
  let cacheMissCount = 0;
  let staleEntryCount = 0;
  const results: CodexSessionIndexEntry[] = [];

  for (const filePath of files) {
    seenCacheKeys.add(filePath);

    let stats;
    try {
      stats = await statFile(filePath);
    } catch {
      continue;
    }

    const cached = nextCacheEntries[filePath];
    const isCacheValid = !!(
      cached &&
      cached.fileMtimeMs === stats.mtimeMs &&
      cached.fileSize === stats.size
    );

    let metadata: CodexSessionMetadataCacheEntry | null = null;
    if (isCacheValid && cached) {
      cacheHitCount++;
      metadata = cached;
    } else {
      filesReparsed++;
      cacheMissCount++;
      const parsed = await parseCodexSessionMetadata(filePath);
      if (parsed) {
        metadata = {
          fileMtimeMs: stats.mtimeMs,
          fileSize: stats.size,
          ...parsed,
        };
        nextCacheEntries[filePath] = metadata;
        cacheDirty = true;
      } else {
        if (nextCacheEntries[filePath]) {
          delete nextCacheEntries[filePath];
          cacheDirty = true;
        }
        continue;
      }
    }

    results.push({
      sessionId: metadata.sessionId,
      originalPath: metadata.originalPath,
      title: metadata.title,
      updatedAt: metadata.updatedAt ?? stats.mtimeMs,
      messageCount: metadata.messageCount,
      gitBranch: metadata.gitBranch ?? null,
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
      cacheFileName: CODEX_SESSION_METADATA_CACHE_FILENAME,
      cacheVersion: CODEX_SESSION_METADATA_CACHE_VERSION,
      scopeKey: 'rootDir',
      scopeValue: rootDir,
      entries: nextCacheEntries,
      lastRun: {
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        filesProcessed: files.length,
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
 * Get preview messages (user + assistant) from a Codex session.
 * Returns the last N messages in chronological order.
 */
export async function getCodexSessionPreview(
  codexSessionId: string,
  limit: number = 10,
): Promise<CodexPreviewMessage[]> {
  const filePath = findCodexSessionFile(codexSessionId);
  if (!filePath) return [];

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.split('\n');
  const messages: CodexPreviewMessage[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type !== 'response_item') continue;

      const payload = parsed.payload;
      if (payload?.role === 'user') {
        const text = extractUserText(payload);
        if (text && !isSystemMessage(text)) {
          messages.push({
            role: 'user',
            content: text,
            timestamp: parsed.timestamp,
          });
        }
      } else if (payload?.role === 'assistant') {
        // Extract assistant text from content array
        const content = payload?.content;
        if (Array.isArray(content)) {
          const texts: string[] = [];
          for (const block of content) {
            if (block?.type === 'output_text' && typeof block.text === 'string') {
              texts.push(block.text);
            }
          }
          const text = texts.join('\n');
          if (text) {
            messages.push({
              role: 'assistant',
              content: text,
              timestamp: parsed.timestamp,
            });
          }
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  return messages.slice(-limit);
}
