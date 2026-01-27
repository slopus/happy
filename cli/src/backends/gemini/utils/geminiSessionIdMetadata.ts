import type { Metadata } from '@/api/types';

export function maybeUpdateGeminiSessionIdMetadata(params: {
  getGeminiSessionId: () => string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => void;
  lastPublished: { value: string | null };
}): void {
  const raw = params.getGeminiSessionId();
  const next = typeof raw === 'string' ? raw.trim() : '';
  if (!next) return;

  if (params.lastPublished.value === next) return;
  params.lastPublished.value = next;

  params.updateHappySessionMetadata((metadata) => ({
    ...metadata,
    // Happy metadata field name. Value is Gemini ACP sessionId (Gemini uses sessionId as the stable resume id).
    geminiSessionId: next,
  }));
}

