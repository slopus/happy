import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer does not publish declarations here.
import TestRenderer from 'react-test-renderer';
import { releaseImageViewerImageCache, useAttachmentImage } from './useAttachmentImage.web';

const mocks = vi.hoisted(() => ({
    createAttachmentImageSource: vi.fn(),
    dispose: vi.fn(),
    downloadEncryptedAttachment: vi.fn(),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        getCredentials: () => ({ token: 'test' }),
        encryption: { getSessionBlobKey: () => new Uint8Array(32) },
    },
}));
vi.mock('@/sync/apiAttachments', () => ({
    downloadEncryptedAttachment: mocks.downloadEncryptedAttachment,
}));
vi.mock('@/encryption/blob', () => ({ decryptBlob: (bytes: Uint8Array) => bytes }));
vi.mock('@/utils/attachmentImageSource', () => ({
    createAttachmentImageSource: mocks.createAttachmentImageSource,
}));

function Probe(props: { onUri: (uri: string | null) => void }) {
    const state = useAttachmentImage('session', 'attachment', { lifetime: 'viewer' });
    React.useEffect(() => {
        props.onUri(state.uri);
    }, [props, state.uri]);
    return null;
}

describe('web image viewer attachment cache', () => {
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        mocks.downloadEncryptedAttachment.mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
        mocks.createAttachmentImageSource.mockResolvedValue({
            uri: 'blob:full-resolution',
            byteSize: 4,
            dispose: mocks.dispose,
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('releases viewer-only full-resolution blobs after the modal is dismissed', async () => {
        const uris: Array<string | null> = [];
        let renderer: { unmount: () => void } | undefined;

        await act(async () => {
            renderer = TestRenderer.create(<Probe onUri={(uri) => uris.push(uri)} />);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(uris).toContain('blob:full-resolution');
        releaseImageViewerImageCache();
        expect(mocks.dispose).toHaveBeenCalledOnce();

        act(() => renderer?.unmount());
    });
});
