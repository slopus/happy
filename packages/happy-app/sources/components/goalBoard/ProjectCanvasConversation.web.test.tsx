import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import type { ProjectCanvasProps } from './ProjectCanvas';

const fixture = vi.hoisted(() => {
    const account = { key: 'isolated-canvas-test' };
    const context = { token: 'fixture-token', assertCurrent: async () => {} };
    return {
        account, context,
        messages: {} as Record<string, Message[]>,
        download: vi.fn<(credentials: unknown, sessionId: string, ref: string) => Promise<Uint8Array>>(),
    };
});
vi.mock('@/auth/accountRuntime', () => ({ accountRuntimeCurrent: () => true, getRuntimeAccountSelection: () => fixture.account }));
vi.mock('@/hooks/useSessionAttachmentDraft', () => ({ useSessionAttachmentDraft: () => undefined }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'fixture-review-scope' }));
vi.mock('@/hooks/useImagePicker', () => ({ MAX_FILE_SIZE: 50_000_000, MAX_IMAGES_PER_MESSAGE: 50 }));
vi.mock('@/sync/storage', () => ({
    storage: (select: (state: { sessions: {} }) => unknown) => select({ sessions: {} }),
    useSessionMessages: (sessionId: string) => ({ messages: fixture.messages[sessionId] ?? [], isAtLatest: true }),
}));
vi.mock('@/sync/sync', () => ({ sync: {
    getCredentials: () => ({ token: fixture.context.token }),
    encryption: { getSessionBlobKey: () => new Uint8Array(32) },
} }));
vi.mock('@/sync/attachmentCacheContext', () => ({ captureAttachmentContext: () => fixture.context }));
vi.mock('@/sync/apiAttachments', () => ({ downloadEncryptedAttachment: fixture.download }));
vi.mock('@/encryption/blob', () => ({ decryptBlob: (bytes: Uint8Array) => bytes }));
vi.mock('@/utils/thumbhash', () => ({ generateThumbhash: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./ProjectCanvas', () => ({ ProjectCanvas: 'Canvas' }));

import { ProjectCanvasConversation } from './ProjectCanvasConversation.web';

const bytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64'));
const props = {
    machineId: 'machine', projectPath: '/project', files: null,
    showFile: false, fileMaximized: false, onSelectSurface: vi.fn(),
};
const application = (sessionId: string) => <ProjectCanvasConversation {...props} sessionId={sessionId} />;
let renderer: ReturnType<typeof TestRenderer.create> | undefined;

function setup(sessionId: string) {
    act(() => { renderer = TestRenderer.create(application(sessionId)); });
}
function canvas(): ProjectCanvasProps {
    return renderer?.root.findByType('Canvas').props;
}
function generatedMessage(sessionId: string): Message {
    const ref = `sessions/${sessionId}/attachments/result.png`;
    return { id: ref, kind: 'tool-call', localId: null, createdAt: 3, children: [],
        tool: { name: 'file', state: 'completed', createdAt: 3, startedAt: null, completedAt: 3, description: null,
            input: { ref, name: 'Result.png', source: 'generated' } },
    };
}

beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    fixture.messages = { first: [generatedMessage('first')], second: [generatedMessage('second')] };
    fixture.download.mockReset();
});
afterEach(() => act(() => { renderer?.unmount(); renderer = undefined; }));

describe('native canvas result reads', () => {
    it('does not download until selected and returns original bytes for a current result', async () => {
        setup('first');
        const { generatedResults, readGeneratedResult } = canvas();
        const ref = generatedResults![0].ref;
        expect(fixture.download).not.toHaveBeenCalled();
        await expect(readGeneratedResult!('sessions/first/attachments/user-attachment.png', new AbortController().signal)).rejects.toThrow();
        expect(fixture.download).not.toHaveBeenCalled();
        fixture.download.mockResolvedValue(bytes);
        const result = await readGeneratedResult!(ref, new AbortController().signal);
        expect(result).toMatchObject({ name: 'Result.png', type: 'image/png' });
        expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes);
        expect(fixture.download).toHaveBeenCalledExactlyOnceWith({ token: 'fixture-token' }, 'first', ref);
    });

    it('rejects a pending result when the conversation changes before download completes', async () => {
        let complete!: (bytes: Uint8Array) => void;
        fixture.download.mockReturnValue(new Promise(resolve => { complete = resolve; }));
        setup('first');
        const { generatedResults, readGeneratedResult } = canvas();
        const pending = readGeneratedResult!(generatedResults![0].ref, new AbortController().signal);
        act(() => { renderer?.update(application('second')); });
        expect(canvas().generatedResults?.[0].ref).toBe('sessions/second/attachments/result.png');
        complete(bytes);
        await expect(pending).rejects.toThrow('projectCanvas.importError');
    });
});
