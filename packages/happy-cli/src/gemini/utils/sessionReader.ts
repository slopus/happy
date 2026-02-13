/**
 * Gemini Session Reader
 *
 * Reads and parses Gemini session JSONL files from disk.
 * Used for session resume (building context prompts from history)
 * and session fork (reading + filtering lines).
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { logger } from '@/ui/logger';
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

/**
 * List all Gemini sessions from the local JSONL directory.
 * For each file, parses the first few lines to extract metadata.
 */
export async function listGeminiSessions(): Promise<GeminiSessionIndexEntry[]> {
  const sessionsDir = getGeminiSessionsDir();

  let dirents: Dirent[];
  try {
    dirents = await readdir(sessionsDir, { withFileTypes: true }) as Dirent[];
  } catch {
    return [];
  }

  const results: GeminiSessionIndexEntry[] = [];

  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.jsonl')) continue;

    const sessionId = dirent.name.replace(/\.jsonl$/, '');
    const filePath = getGeminiSessionFilePath(sessionId);

    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    let originalPath: string | null = null;
    let title: string | null = null;
    let messageCount = 0;
    let updatedAt: number | undefined;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);

        if (parsed.type === 'meta' && parsed.key === 'sessionStart') {
          originalPath = typeof parsed.value?.cwd === 'string' ? parsed.value.cwd : null;
        }

        if (parsed.type === 'user') {
          messageCount++;
          if (!title && typeof parsed.message === 'string' && parsed.message.trim()) {
            title = parsed.message.trim().substring(0, 80);
          }
        }

        // Track last timestamp for updatedAt
        if (typeof parsed.timestamp === 'number') {
          updatedAt = parsed.timestamp;
        }
      } catch {
        // skip malformed lines
      }
    }

    // Skip sessions with no user messages
    if (messageCount === 0) continue;

    // Use file mtime as fallback for updatedAt
    if (updatedAt === undefined) {
      try {
        const stats = await stat(filePath);
        updatedAt = stats.mtimeMs;
      } catch {
        // ignore
      }
    }

    results.push({ sessionId, originalPath, title, updatedAt, messageCount });
  }

  results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
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
