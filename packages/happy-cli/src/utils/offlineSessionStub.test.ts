import { describe, expect, it } from 'vitest';

import { createOfflineSessionStub } from './offlineSessionStub';

describe('createOfflineSessionStub', () => {
    // Regression guard: runAgy/runCodex register attachment handlers
    // unconditionally at startup, so the stub must implement them or offline
    // startup dies with a TypeError before the reconnection loop begins.
    it('implements the attachment surface used unconditionally at startup', async () => {
        const stub = createOfflineSessionStub('tag-1');

        expect(() => stub.onFileEvent(() => {})).not.toThrow();
        expect(() => stub.trackAttachmentDownload(Promise.resolve(null))).not.toThrow();
        await expect(stub.drainAttachmentsForUserMessage()).resolves.toEqual([]);
    });
});
