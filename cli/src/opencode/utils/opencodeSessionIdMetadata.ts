import type { Metadata } from '@/api/types';

export function maybeUpdateOpenCodeSessionIdMetadata(params: {
  getOpenCodeSessionId: () => string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => void;
  lastPublished: { value: string | null };
}): void {
  const raw = params.getOpenCodeSessionId();
  const next = typeof raw === 'string' ? raw.trim() : '';
  if (!next) return;

  if (params.lastPublished.value === next) return;
  params.lastPublished.value = next;

  params.updateHappySessionMetadata((metadata) => ({
    ...metadata,
    // Happy metadata field name. Value is OpenCode ACP sessionId (OpenCode uses sessionId as the stable resume id).
    opencodeSessionId: next,
  }));
}

