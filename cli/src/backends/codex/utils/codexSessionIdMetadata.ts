import type { Metadata } from '@/api/types';

export function maybeUpdateCodexSessionIdMetadata(params: {
  getCodexThreadId: () => string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => void;
  lastPublished: { value: string | null };
}): void {
  const raw = params.getCodexThreadId();
  const next = typeof raw === 'string' ? raw.trim() : '';
  if (!next) return;

  if (params.lastPublished.value === next) return;
  params.lastPublished.value = next;

  params.updateHappySessionMetadata((metadata) => ({
    ...metadata,
    // Happy metadata field name. Value is Codex threadId (Codex uses "threadId" as the stable resume id).
    codexSessionId: next,
  }));
}

