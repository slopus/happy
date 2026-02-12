/**
 * Gemini Session Writer
 *
 * Writes JSONL session logs to disk for Gemini sessions.
 * Unlike Claude/Codex (which write their own JSONL), Gemini CLI does not
 * persist sessions, so Happy writes the file by intercepting ACP events.
 *
 * All writes are best-effort and non-blocking — the server already has
 * all messages via sendAgentMessage(), so this is a local backup for
 * resume and fork features.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import type { GeminiSessionLine } from './sessionTypes';

const SESSIONS_DIR_NAME = 'gemini_sessions';

export function getGeminiSessionsDir(): string {
  return join(configuration.happyHomeDir, SESSIONS_DIR_NAME);
}

export function getGeminiSessionFilePath(sessionId: string): string {
  return join(getGeminiSessionsDir(), `${sessionId}.jsonl`);
}

export class GeminiSessionWriter {
  private readonly filePath: string;
  private writePromise: Promise<void> = Promise.resolve();

  constructor(happySessionId: string) {
    this.filePath = getGeminiSessionFilePath(happySessionId);
  }

  async init(meta?: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(getGeminiSessionsDir(), { recursive: true });
      this.appendLine({
        type: 'meta',
        key: 'sessionStart',
        value: meta ?? {},
        timestamp: Date.now(),
      });
      logger.debug(`[GeminiSessionWriter] Initialized: ${this.filePath}`);
    } catch (error) {
      logger.debug(`[GeminiSessionWriter] Failed to init:`, error);
    }
  }

  getFilePath(): string {
    return this.filePath;
  }

  writeUser(message: string): void {
    this.appendLine({
      type: 'user',
      message,
      timestamp: Date.now(),
      uuid: randomUUID(),
    });
  }

  writeAssistant(message: string, model?: string): void {
    this.appendLine({
      type: 'assistant',
      message,
      timestamp: Date.now(),
      uuid: randomUUID(),
      ...(model ? { model } : {}),
    });
  }

  writeToolCall(name: string, callId: string, input: unknown): void {
    this.appendLine({
      type: 'tool-call',
      name,
      callId,
      input,
      timestamp: Date.now(),
      uuid: randomUUID(),
    });
  }

  writeToolResult(callId: string, output: unknown, isError?: boolean): void {
    this.appendLine({
      type: 'tool-result',
      callId,
      output,
      ...(isError ? { isError } : {}),
      timestamp: Date.now(),
      uuid: randomUUID(),
    });
  }

  writeFileEdit(filePath: string, description: string, diff?: string): void {
    this.appendLine({
      type: 'file-edit',
      filePath,
      description,
      ...(diff ? { diff } : {}),
      timestamp: Date.now(),
      uuid: randomUUID(),
    });
  }

  /**
   * Queue a line to be written. Writes are serialized to preserve order.
   * Errors are logged but never thrown — persistence is best-effort.
   */
  private appendLine(line: GeminiSessionLine): void {
    this.writePromise = this.writePromise
      .then(() => appendFile(this.filePath, JSON.stringify(line) + '\n', 'utf-8'))
      .catch((error) => {
        logger.debug(`[GeminiSessionWriter] Write failed:`, error);
      });
  }
}
