import type { Metadata } from '@/api/types';

/** Only a complete, decrypted ready-only transcript proves no turn was sent.
 * Missing native history alone must never authorize discarding a thread. */
export function isUnusedCodexSession(
  metadata: Pick<Metadata, 'flavor' | 'parentSessionId' | 'codexSyncCursor' | 'codexHistoryReplay'>,
  seq: number,
  messages: Array<{ seq: number; content: unknown }>,
): boolean {
  if (metadata.flavor !== 'codex' || metadata.parentSessionId
      || metadata.codexSyncCursor || metadata.codexHistoryReplay) return false;
  if (!Number.isSafeInteger(seq) || seq < 0 || seq > 150 || messages.length !== seq) return false;
  const ordered = [...messages].sort((a, b) => a.seq - b.seq);
  return ordered.every((message, index) => {
    if (message.seq !== index + 1) return false;
    const value = message.content as { role?: unknown; content?: { type?: unknown; data?: { type?: unknown } } } | null;
    return value?.role === 'agent' && value.content?.type === 'event' && value.content.data?.type === 'ready';
  });
}
