import type { Metadata } from '@/sync/storageTypes';

export function isCommittedMessageDiscarded(metadata: Metadata | null, localId: string | null): boolean {
  if (!metadata) return false;
  if (!localId) return false;
  const list = metadata.discardedCommittedMessageLocalIds;
  return Array.isArray(list) && list.includes(localId);
}
