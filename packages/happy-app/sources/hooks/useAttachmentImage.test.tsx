import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface below.
import TestRenderer from 'react-test-renderer';
import { useAttachmentImage } from './useAttachmentImage';

const mocks = vi.hoisted(() => ({
    downloadEncryptedAttachment: vi.fn(),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        getCredentials: () => ({ token: 'test' }),
        encryption: {
            getSessionBlobKey: () => new Uint8Array(32),
        },
    },
}));
vi.mock('@/sync/apiAttachments', () => ({
    downloadEncryptedAttachment: mocks.downloadEncryptedAttachment,
}));
vi.mock('@/encryption/blob', () => ({
    decryptBlob: (bytes: Uint8Array) => bytes,
}));
vi.mock('@/encryption/base64', () => ({
    encodeBase64: (bytes: Uint8Array) => `encoded-${bytes[0]}`,
}));

function Probe(props: {
    onState: (sessionId: string, state: ReturnType<typeof useAttachmentImage>) => void;
    ref_: string;
    sessionId: string;
}) {
    const state = useAttachmentImage(props.sessionId, props.ref_);
    props.onState(props.sessionId, state);
    React.useEffect(() => {
        props.onState(props.sessionId, state);
    }, [props, state]);
    return null;
}

describe('useAttachmentImage session isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.downloadEncryptedAttachment.mockImplementation(async (
            _credentials: unknown,
            sessionId: string,
        ) => new Uint8Array([sessionId === 'session-a' ? 1 : 2]));
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it('does not share cached or in-flight attachment bytes across sessions with the same ref', async () => {
        const uris = new Map<string, string | null>();
        let renderer: { unmount: () => void } | undefined;

        await act(async () => {
            renderer = TestRenderer.create(
                <>
                    <Probe onState={(sessionId, state) => uris.set(sessionId, state.uri)} ref_="shared-ref" sessionId="session-a" />
                    <Probe onState={(sessionId, state) => uris.set(sessionId, state.uri)} ref_="shared-ref" sessionId="session-b" />
                </>,
            );
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(mocks.downloadEncryptedAttachment).toHaveBeenCalledTimes(2);
        expect(uris.get('session-a')).toBe('data:image/png;base64,encoded-1');
        expect(uris.get('session-b')).toBe('data:image/png;base64,encoded-2');

        act(() => renderer?.unmount());
    });

    it('hides the previous session uri on the first render after an in-place session switch', async () => {
        const renders: Array<{ sessionId: string; uri: string | null }> = [];
        const onState = (sessionId: string, state: ReturnType<typeof useAttachmentImage>) => {
            renders.push({ sessionId, uri: state.uri });
        };
        let renderer: { update: (node: React.ReactNode) => void; unmount: () => void } | undefined;

        await act(async () => {
            renderer = TestRenderer.create(<Probe onState={onState} ref_="rerender-ref" sessionId="session-a" />);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(renders.some((entry) => entry.sessionId === 'session-a' && entry.uri === 'data:image/png;base64,encoded-1')).toBe(true);

        const switchStart = renders.length;
        act(() => {
            renderer?.update(<Probe onState={onState} ref_="rerender-ref" sessionId="session-b" />);
        });
        const firstSessionBRender = renders.slice(switchStart).find((entry) => entry.sessionId === 'session-b');
        expect(firstSessionBRender?.uri).toBeNull();

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(renders.some((entry) => entry.sessionId === 'session-b' && entry.uri === 'data:image/png;base64,encoded-2')).toBe(true);

        act(() => renderer?.unmount());
    });
});
