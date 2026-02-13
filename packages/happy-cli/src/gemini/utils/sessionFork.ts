/**
 * Gemini Session Fork
 *
 * Fork and truncate Gemini session JSONL files for the duplicate feature.
 * Follows the same pattern as claudeSessionFork.ts.
 */

import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, unlink } from 'node:fs';
import { copyFile, rename, unlink as unlinkAsync } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { logger } from '@/ui/logger';
import { getGeminiSessionFilePath } from './sessionWriter';

export interface GeminiForkResult {
  success: boolean;
  newSessionId?: string;
  errorMessage?: string;
}

/**
 * Fork a Gemini session without truncation.
 * Copies the JSONL file to a new file with a fresh UUID.
 */
export async function forkGeminiSession(sessionId: string): Promise<GeminiForkResult> {
  return forkAndTruncateGeminiSession(sessionId);
}

/**
 * Fork a Gemini session and optionally truncate at a specific UUID.
 *
 * Steps:
 * 1. Generate a new session ID
 * 2. Copy the original JSONL file
 * 3. If truncateBeforeUuid provided, remove that line and everything after it
 * 4. Return the new session ID
 */
export async function forkAndTruncateGeminiSession(
  sessionId: string,
  truncateBeforeUuid?: string,
): Promise<GeminiForkResult> {
  const newSessionId = randomUUID();
  const originalPath = getGeminiSessionFilePath(sessionId);
  const newPath = getGeminiSessionFilePath(newSessionId);

  try {
    await copyFile(originalPath, newPath);

    if (truncateBeforeUuid) {
      const truncateResult = await truncateSessionFile(newPath, truncateBeforeUuid);
      if (!truncateResult.success) {
        try { await unlinkAsync(newPath); } catch { /* ignore */ }
        return { success: false, errorMessage: truncateResult.errorMessage };
      }
    }

    logger.debug(`[GeminiSessionFork] Forked ${sessionId} -> ${newSessionId}`);
    return { success: true, newSessionId };
  } catch (error) {
    try { await unlinkAsync(newPath); } catch { /* ignore */ }
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Failed to fork session',
    };
  }
}

/**
 * Truncate a JSONL file by removing a line with the given UUID and all subsequent lines.
 * Uses temp file + atomic rename to avoid corruption.
 */
async function truncateSessionFile(
  jsonlPath: string,
  truncateBeforeUuid: string,
): Promise<{ success: boolean; errorMessage?: string }> {
  const tempPath = `${jsonlPath}.tmp`;

  try {
    const readStream = createReadStream(jsonlPath, { encoding: 'utf8' });
    const writeStream = createWriteStream(tempPath, { encoding: 'utf8' });
    const rl = createInterface({ input: readStream, crlfDelay: Infinity });

    let foundTruncationPoint = false;

    for await (const line of rl) {
      if (!line.trim()) {
        if (!foundTruncationPoint) writeStream.write(line + '\n');
        continue;
      }

      try {
        const entry = JSON.parse(line);
        if (entry.uuid === truncateBeforeUuid) {
          foundTruncationPoint = true;
          continue;
        }
      } catch { /* not valid JSON, keep if before truncation */ }

      if (!foundTruncationPoint) {
        writeStream.write(line + '\n');
      }
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.end((err: Error | null | undefined) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await rename(tempPath, jsonlPath);
    return { success: true };
  } catch (error) {
    try {
      await new Promise<void>((resolve) => { unlink(tempPath, () => resolve()); });
    } catch { /* ignore */ }
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Failed to truncate session file',
    };
  }
}
