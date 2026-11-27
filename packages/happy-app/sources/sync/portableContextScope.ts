import type { Metadata } from './storageTypes';

/** A parent ID alone never proves the boundary of a truncated native branch. */
export function assertPortableContextSourceScope(metadata: Pick<Metadata, 'forkedFromMessageId' | 'portableContextBoundary' | 'parentSessionId'> | null | undefined): void {
    if (metadata?.forkedFromMessageId && !metadata.portableContextBoundary) throw new Error('portable-context-fork-boundary-unverified');
}
