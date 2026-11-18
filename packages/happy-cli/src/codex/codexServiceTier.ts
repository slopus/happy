import type { ApiSessionClient } from '@/api/apiSession';
import type { CodexAppServerClient } from './codexAppServerClient';

/** Keep persisted identity in sync when a tier switch discards a new empty thread. */
export async function setCodexServiceTier(
    client: Pick<CodexAppServerClient, 'threadId' | 'setServiceTier'>,
    session: Pick<ApiSessionClient, 'updateMetadataAndAwait'>,
    fast: boolean,
): Promise<void> {
    const previousThreadId = client.threadId;
    try {
        await client.setServiceTier(fast ? 'fast' : 'standard');
    } finally {
        // Reconnect may fail after the empty thread was discarded. Retrying
        // must not recover its stale ID from Paws metadata, even for commands.
        if (previousThreadId && !client.threadId) {
            await session.updateMetadataAndAwait((metadata) => metadata.codexThreadId === previousThreadId
                ? { ...metadata, codexThreadId: undefined }
                : metadata);
        }
    }
}
