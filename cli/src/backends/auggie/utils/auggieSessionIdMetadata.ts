import type { Metadata } from '@/api/types';

export function maybeUpdateAuggieSessionIdMetadata(params: {
  getAuggieSessionId: () => string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => void;
  lastPublished: { value: string | null };
}): void {
  const raw = params.getAuggieSessionId();
  const next = typeof raw === 'string' ? raw.trim() : '';
  if (!next) return;

  if (params.lastPublished.value === next) return;
  params.lastPublished.value = next;

  params.updateHappySessionMetadata((metadata) => ({
    ...metadata,
    // Happy metadata field name. Value is Auggie ACP sessionId (opaque; stable resume id when loadSession is supported).
    auggieSessionId: next,
  }));
}

