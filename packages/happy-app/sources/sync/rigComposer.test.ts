import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { rigMetadataFixture } from './__testdata__/rigMetadata';

const mocks = vi.hoisted(() => ({
    emitWithAck: vi.fn(),
    encryptRaw: vi.fn(async (value: unknown) => JSON.stringify(value)),
    decryptRaw: vi.fn(async (value: string) => JSON.parse(value)),
    persisted: {
        drafts: {} as Record<string, string>,
        rig: {} as Record<string, {
            text: string | null;
            draftUpdatedAt: number;
            permissionMode: string | null;
            modelMode: string | null;
            effortLevel: string | null;
            serviceTier: string | null;
        }>,
    },
}));

// Real store and real writer; only the socket, encryption and native storage are replaced.
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
vi.mock('./persistence', () => ({
    loadSettings: () => ({}), loadLocalSettings: () => ({}), saveLocalSettings: vi.fn(), saveSettings: vi.fn(),
    loadPurchases: () => null, savePurchases: vi.fn(), loadProfile: () => null, saveProfile: vi.fn(),
    loadSessionDrafts: () => ({ ...mocks.persisted.drafts }),
    saveSessionDrafts: (drafts: Record<string, string>) => { mocks.persisted.drafts = { ...drafts }; },
    loadRigComposerDraft: (id: string) => mocks.persisted.rig[id] ?? null,
    saveRigComposerDraft: (id: string, draft: typeof mocks.persisted.rig[string] | null) => {
        if (draft === null) delete mocks.persisted.rig[id];
        else mocks.persisted.rig[id] = draft;
    },
    loadSessionLastMessageSentAt: () => ({}), saveSessionLastMessageSentAt: vi.fn(),
}));
vi.mock('./sync', () => ({
    sync: { encryption: { getSessionEncryption: () => ({ encryptRaw: mocks.encryptRaw, decryptRaw: mocks.decryptRaw }) } },
}));
vi.mock('./apiSocket', () => ({ apiSocket: { emitWithAck: mocks.emitWithAck } }));
vi.mock('@/realtime/RealtimeSession', () => ({ getCurrentRealtimeSessionId: () => null, getVoiceSession: () => null }));
vi.mock('@/components/tools/knownTools', () => ({ isMutableTool: () => true }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { storage } from './storage';
import { MetadataSchema, type Metadata } from './storageTypes';
import { rigComposerClear, rigComposerSetMode, rigComposerSetText, RIG_DRAFT_DEBOUNCE_MS } from './rigComposer';
import { useDraft } from '@/hooks/useDraft';

const lastMode = { providerId: 'codex', modelId: 'shared-model', effort: 'high', serviceTier: 'fast', permissionMode: 'auto' };

function metadata(extra: Record<string, unknown>): Metadata {
    return MetadataSchema.parse({ ...rigMetadataFixture, draft: null, draftUpdatedAt: null, lastMode, ...extra });
}

function apply(id: string, meta: Metadata, metadataVersion = 1) {
    storage.getState().applySessions([{
        id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        metadata: meta, metadataVersion, agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0,
    }]);
}

const session = (id: string) => storage.getState().sessions[id];
const writes = () => mocks.emitWithAck.mock.calls.map(([, payload]) => ({ ...payload, metadata: JSON.parse(payload.metadata) }));
const settle = () => vi.advanceTimersByTimeAsync(0);
let composer: ReturnType<typeof create> | undefined;
let editInput: (value: string) => void;
function Composer() {
    const [value, setValue] = React.useState(session('s').draft ?? '');
    editInput = setValue;
    useDraft('s', value, setValue);
    return null;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.persisted.drafts = {};
    mocks.persisted.rig = {};
    mocks.emitWithAck.mockResolvedValue({ result: 'success', version: 2 });
    storage.setState({ sessions: {}, socketStatus: 'disconnected' } as any);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
    if (composer) act(() => composer!.unmount());
    composer = undefined;
    vi.useRealTimers();
});

describe('Happy Agent composer synchronization', () => {
    it('retries after exhausting metadata conflicts without another edit or reconnect', async () => {
        apply('s', metadata({ draft: { ...lastMode, text: 'old' }, draftUpdatedAt: 100 }));
        storage.getState().setSocketStatus('connected');
        for (let version = 2; version <= 4; version++) {
            mocks.emitWithAck.mockResolvedValueOnce({
                result: 'version-mismatch', version,
                metadata: JSON.stringify(metadata({ draft: { ...lastMode, text: 'old' }, draftUpdatedAt: 100 })),
            });
        }
        rigComposerSetText('s', 'latest phone text');
        const stamp = session('s').draftUpdatedAt;
        await vi.advanceTimersByTimeAsync(RIG_DRAFT_DEBOUNCE_MS);
        expect(writes()).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(writes()).toHaveLength(4);
        expect(writes()[3]).toMatchObject({
            expectedVersion: 4,
            metadata: { draft: { text: 'latest phone text' }, draftUpdatedAt: stamp },
        });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(writes()).toHaveLength(4);
    });

    it('retries a rejected clear with its original stamp, one timer, and capped backoff', async () => {
        apply('s', metadata({ draft: { ...lastMode, text: 'old' }, draftUpdatedAt: 100 }));
        storage.getState().setSocketStatus('connected');
        mocks.emitWithAck.mockResolvedValueOnce({ result: 'error' })
            .mockRejectedValue(new Error('temporarily unavailable'));
        rigComposerClear('s');
        const stamp = session('s').draftUpdatedAt;
        await settle();
        let count = 1;
        for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
            expect(vi.getTimerCount()).toBe(1);
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(writes()).toHaveLength(count);
            await vi.advanceTimersByTimeAsync(1);
            expect(writes()).toHaveLength(++count);
            expect(writes().at(-1).metadata).toMatchObject({ draft: null, draftUpdatedAt: stamp });
        }
        mocks.emitWithAck.mockResolvedValue({ result: 'success', version: 2 });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(writes()).toHaveLength(count + 1);
        expect(vi.getTimerCount()).toBe(0);
        expect(mocks.persisted.rig.s).toMatchObject({ text: null, draftUpdatedAt: stamp });
    });

    it('sends a newer edit promptly instead of waiting for a failed write retry', async () => {
        apply('s', metadata({ draft: { ...lastMode, text: 'old' }, draftUpdatedAt: 100 }));
        storage.getState().setSocketStatus('connected');
        mocks.emitWithAck.mockResolvedValueOnce({ result: 'error' });
        rigComposerClear('s');
        await settle();
        rigComposerSetText('s', 'new edit');
        await vi.advanceTimersByTimeAsync(RIG_DRAFT_DEBOUNCE_MS);
        expect(writes()).toHaveLength(2);
        expect(writes()[1].metadata.draft.text).toBe('new edit');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(writes()).toHaveLength(2);
    });

    it('keeps retries serialized with edits made while a retry is in flight', async () => {
        apply('s', metadata({ draft: { ...lastMode, text: 'old' }, draftUpdatedAt: 100 }));
        storage.getState().setSocketStatus('connected');
        let finishRetry!: (result: { result: 'error' }) => void;
        mocks.emitWithAck
            .mockResolvedValueOnce({ result: 'error' })
            .mockImplementationOnce(() => new Promise((resolve) => { finishRetry = resolve; }));
        rigComposerClear('s');
        await settle();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(writes()).toHaveLength(2);
        rigComposerSetText('s', 'edited during retry');
        await vi.advanceTimersByTimeAsync(RIG_DRAFT_DEBOUNCE_MS);
        expect(writes()).toHaveLength(2);
        finishRetry({ result: 'error' });
        await settle();
        expect(writes()).toHaveLength(3);
        expect(writes()[2].metadata.draft.text).toBe('edited during retry');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(writes()).toHaveLength(3);
    });

    it('does not retry a write whose success was observed through a metadata echo', async () => {
        apply('s', metadata({ draft: { ...lastMode, text: 'old' }, draftUpdatedAt: 100 }));
        storage.getState().setSocketStatus('connected');
        mocks.emitWithAck.mockRejectedValueOnce(new Error('acknowledgement timed out'));
        rigComposerClear('s');
        await settle();
        apply('s', metadata({ draft: null, draftUpdatedAt: session('s').draftUpdatedAt }), 2);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(writes()).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['remote', 'removed', 'disconnected'])('stops a pending retry when the session is %s', async (change) => {
        apply('s', metadata({ draft: { ...lastMode, text: 'old' }, draftUpdatedAt: 100 }));
        storage.getState().setSocketStatus('connected');
        mocks.emitWithAck.mockResolvedValueOnce({ result: 'error' });
        rigComposerClear('s');
        await settle();
        if (change === 'remote') {
            apply('s', metadata({ draft: { ...lastMode, text: 'remote winner' }, draftUpdatedAt: 20_000 }), 3);
        } else if (change === 'removed') {
            storage.getState().deleteSession('s');
        } else {
            storage.getState().setSocketStatus('disconnected');
        }
        await vi.advanceTimersByTimeAsync(60_000);
        expect(writes()).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
        if (change === 'disconnected') {
            storage.getState().setSocketStatus('connected');
            await settle();
            expect(writes()).toHaveLength(2);
            expect(writes()[1].metadata.draft).toBeNull();
        }
    });

    it.each(['remote', 'send'])('keeps a %s clear null while the composer is mounted', async (source) => {
        apply('s', metadata({ draft: { ...lastMode, text: 'old text' }, draftUpdatedAt: 100 }));
        act(() => { composer = create(React.createElement(Composer)); });
        act(() => {
            if (source === 'remote') apply('s', metadata({ draft: null, draftUpdatedAt: 200 }), 2);
            else rigComposerClear('s');
        });
        await vi.advanceTimersByTimeAsync(500);
        expect(session('s').draft).toBeNull();
        if (source === 'remote') {
            expect(session('s').draftUpdatedAt).toBe(200);
            expect(mocks.emitWithAck).not.toHaveBeenCalled();
        }
    });

    it('does not overwrite a remote edit when the composer closes before React renders it', async () => {
        apply('s', metadata({ draft: { ...lastMode, text: 'old text' }, draftUpdatedAt: 100 }));
        act(() => { composer = create(React.createElement(Composer)); });
        act(() => {
            apply('s', metadata({ draft: { ...lastMode, text: 'new desktop text' }, draftUpdatedAt: 200 }), 2);
            composer!.unmount();
            composer = undefined;
        });
        await vi.advanceTimersByTimeAsync(500);
        expect(session('s').draft).toBe('new desktop text');
        expect(mocks.emitWithAck).not.toHaveBeenCalled();
    });

    it('adopts the server winner when another edit has the same stamp as our acknowledged draft', async () => {
        apply('s', metadata({ draft: { ...lastMode, text: 'base' }, draftUpdatedAt: 100 }));
        rigComposerSetText('s', 'phone edit');
        const stamp = session('s').draftUpdatedAt!;
        await vi.advanceTimersByTimeAsync(500);
        apply('s', metadata({ draft: { ...lastMode, text: 'phone edit' }, draftUpdatedAt: stamp }), 2);
        apply('s', metadata({ draft: { ...lastMode, text: 'desktop edit' }, draftUpdatedAt: stamp }), 3);
        expect(session('s').draft).toBe('desktop edit');
        // A delayed metadata packet cannot rewind that winner.
        apply('s', metadata({ draft: { ...lastMode, text: 'phone edit' }, draftUpdatedAt: stamp }), 2);
        expect(session('s').draft).toBe('desktop edit');
    });

    it('adopts an equal-stamped conflict instead of retrying the losing draft', async () => {
        apply('s', metadata({ draft: { ...lastMode, text: 'base' }, draftUpdatedAt: 100 }));
        rigComposerSetText('s', 'phone edit');
        const stamp = session('s').draftUpdatedAt!;
        mocks.emitWithAck.mockResolvedValueOnce({
            result: 'version-mismatch', version: 2,
            metadata: JSON.stringify(metadata({ draft: { ...lastMode, text: 'desktop edit' }, draftUpdatedAt: stamp })),
        });
        await vi.advanceTimersByTimeAsync(500);
        expect(session('s').draft).toBe('desktop edit');
        expect(mocks.emitWithAck).toHaveBeenCalledTimes(1);
    });

    it('still flushes a legacy local draft on unmount', () => {
        apply('s', MetadataSchema.parse({ path: '/test', host: 'test', flavor: 'claude' }));
        storage.getState().updateSessionDraft('s', 'original');
        act(() => { composer = create(React.createElement(Composer)); });
        act(() => editInput('unsaved edit'));
        expect(session('s').draft).toBe('original');
        act(() => composer!.unmount());
        composer = undefined;
        expect(session('s').draft).toBe('unsaved edit');
    });

    it('opens with the latest lastMode after a cleared draft, including after a restart', () => {
        apply('s', metadata({ draft: null, draftUpdatedAt: 100 }));
        const latest = metadata({ draft: null, draftUpdatedAt: 100, lastMode: { ...lastMode, providerId: 'claude', effort: 'max', serviceTier: null } });
        apply('s', latest, 2);
        act(() => { composer = create(React.createElement(Composer)); });
        expect(session('s').modelMode).toBe('claude:shared-model');
        act(() => composer!.unmount());
        composer = undefined;
        storage.setState({ sessions: {} } as any);
        apply('s', latest, 2);
        expect(session('s').modelMode).toBe('claude:shared-model');
    });

    it('opens the composer from the draft, keeps typing local until a pause, and stamps at the edit', async () => {
        apply('s', metadata({ draft: { ...lastMode, permissionMode: 'read_only', text: 'hi' }, draftUpdatedAt: 20_000 }));
        expect(session('s')).toMatchObject({ draft: 'hi', permissionMode: 'read_only', modelMode: 'codex:shared-model', effortLevel: 'high', serviceTier: 'fast', draftUpdatedAt: 20_000 });
        const list = storage.getState().sessionListViewData;

        rigComposerSetText('s', 'hi t');
        // Later than anything seen, even when this device's clock lags the remote stamp.
        expect(session('s')).toMatchObject({ draft: 'hi t', draftUpdatedAt: 20_001 });
        // A composer-only edit does not rebuild the session list.
        expect(storage.getState().sessionListViewData).toBe(list);
        await vi.advanceTimersByTimeAsync(100);
        rigComposerSetText('s', 'hi there');
        expect(session('s').draftUpdatedAt).toBe(20_002);
        await vi.advanceTimersByTimeAsync(RIG_DRAFT_DEBOUNCE_MS - 1);
        expect(mocks.emitWithAck).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(writes()).toEqual([{
            sid: 's', expectedVersion: 1,
            metadata: expect.objectContaining({
                draft: { ...lastMode, permissionMode: 'read_only', text: 'hi there' },
                draftUpdatedAt: 20_002,
                lastMode,
            }),
        }]);
    });

    it('writes a picker change immediately with the whole draft and the fields the UI does not show', async () => {
        // Never edited, last ran on Codex at an effort the Claude model does not offer.
        apply('s', metadata({ lastMode: { ...lastMode, effort: 'medium' } }));
        expect(session('s')).toMatchObject({ draft: null, permissionMode: 'auto', modelMode: 'codex:shared-model', effortLevel: 'medium' });

        rigComposerSetMode('s', { modelMode: 'claude:shared-model', effortLevel: null });
        expect(session('s')).toMatchObject({ draft: '', modelMode: 'claude:shared-model', effortLevel: 'max', serviceTier: null, draftUpdatedAt: 10_000 });
        await settle();
        expect(writes()[0].metadata).toMatchObject({
            draft: { text: '', providerId: 'claude', modelId: 'shared-model', effort: 'max', serviceTier: null, permissionMode: 'auto' },
            draftUpdatedAt: 10_000,
            lastMode: { ...lastMode, effort: 'medium' },
        });

        // An empty-text edit also goes out at once and keeps the pickers.
        vi.setSystemTime(10_500);
        rigComposerSetText('s', 'x');
        rigComposerSetText('s', '');
        await settle();
        expect(writes()).toHaveLength(2);
        expect(writes()[1].metadata).toMatchObject({ draft: { text: '', providerId: 'claude', effort: 'max' }, draftUpdatedAt: 10_501 });
    });

    it('merges onto the newest metadata on conflict, and adopts a newer remote draft instead of resending', async () => {
        apply('s', metadata({}));
        rigComposerSetMode('s', { permissionMode: 'read_only' });
        const stamp = session('s').draftUpdatedAt!;

        // Somebody renamed the session first: keep their metadata, re-apply our draft.
        const renamed = { ...metadata({ draftUpdatedAt: 9_000, draft: { ...lastMode, text: 'old' } }), name: 'Renamed' };
        mocks.emitWithAck
            .mockResolvedValueOnce({ result: 'version-mismatch', version: 5, metadata: JSON.stringify(renamed) })
            .mockResolvedValueOnce({ result: 'success', version: 6 });
        await settle();
        expect(writes()).toHaveLength(2);
        expect(writes()[1]).toMatchObject({ expectedVersion: 5, metadata: { name: 'Renamed', draftUpdatedAt: stamp, draft: { permissionMode: 'read_only', text: '' } } });
        expect(session('s')).toMatchObject({ metadataVersion: 5, permissionMode: 'read_only', draft: '' });

        // The desktop typed after us: their draft wins and our stale text is not resent.
        mocks.emitWithAck.mockClear();
        vi.setSystemTime(30_000);
        rigComposerSetText('s', 'phone text');
        const newer = metadata({ draftUpdatedAt: 30_500, draft: { ...lastMode, permissionMode: 'full_access', text: 'desktop text' } });
        mocks.emitWithAck.mockResolvedValueOnce({ result: 'version-mismatch', version: 7, metadata: JSON.stringify(newer) });
        await vi.advanceTimersByTimeAsync(RIG_DRAFT_DEBOUNCE_MS);
        expect(mocks.emitWithAck).toHaveBeenCalledTimes(1);
        expect(session('s')).toMatchObject({ draft: 'desktop text', permissionMode: 'full_access', draftUpdatedAt: 30_500, metadataVersion: 7 });
    });

    it('lets neither an echo nor an older update reset text the user is typing', async () => {
        apply('s', metadata({ draftUpdatedAt: 100, draft: { ...lastMode, text: 'a' } }));
        rigComposerSetText('s', 'ab');
        rigComposerSetText('s', 'abc');
        const local = session('s').draftUpdatedAt!;

        // Unrelated metadata change still carrying the old stamp.
        apply('s', metadata({ draftUpdatedAt: 100, draft: { ...lastMode, text: 'a' }, name: 'busy' }), 3);
        expect(session('s')).toMatchObject({ draft: 'abc', draftUpdatedAt: local, metadata: { name: 'busy' } });
        // Echo of our own earlier write.
        apply('s', metadata({ draftUpdatedAt: local - 1, draft: { ...lastMode, text: 'ab' } }), 4);
        expect(session('s')).toMatchObject({ draft: 'abc', draftUpdatedAt: local });
        // Echo of the latest write changes nothing; a genuinely newer draft is adopted.
        apply('s', metadata({ draftUpdatedAt: local, draft: { ...lastMode, text: 'abc' } }), 5);
        expect(session('s').draft).toBe('abc');
        apply('s', metadata({ draftUpdatedAt: local + 1, draft: { ...lastMode, text: 'remote' } }), 6);
        expect(session('s')).toMatchObject({ draft: 'remote', draftUpdatedAt: local + 1 });
    });

    it('clears with a fresh stamp on send, cancels the pending typing write, and keeps the mode until lastMode confirms it', async () => {
        apply('s', metadata({ draftUpdatedAt: 100, draft: { ...lastMode, permissionMode: 'read_only', text: 'a' } }));
        rigComposerSetText('s', 'about to send');
        expect(session('s').draftUpdatedAt).toBe(10_000);
        rigComposerClear('s');
        expect(session('s')).toMatchObject({ draft: null, draftUpdatedAt: 10_001, permissionMode: 'read_only' });
        await vi.advanceTimersByTimeAsync(RIG_DRAFT_DEBOUNCE_MS * 2);
        expect(writes()).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ draft: null, draftUpdatedAt: 10_001, lastMode }) })]);

        // Echo of the clear with the daemon's previous lastMode: the captured mode stays.
        apply('s', metadata({ draftUpdatedAt: 10_001 }), 2);
        expect(session('s').permissionMode).toBe('read_only');
        // Nothing left to clear: no second write.
        rigComposerClear('s');
        await settle();
        expect(writes()).toHaveLength(1);
    });

    it('restores each session independently, sending only the local draft that is still ahead', async () => {
        apply('keep', metadata({ draftUpdatedAt: 5, draft: { ...lastMode, text: 'server keep' } }));
        apply('drop', metadata({ draftUpdatedAt: 5, draft: { ...lastMode, text: 'server drop' } }));
        mocks.emitWithAck.mockRejectedValue(new Error('offline'));
        rigComposerSetText('keep', 'offline keep');
        rigComposerSetText('drop', 'offline drop');
        await vi.advanceTimersByTimeAsync(RIG_DRAFT_DEBOUNCE_MS);
        const keepStamp = session('keep').draftUpdatedAt!;
        const remoteStamp = session('drop').draftUpdatedAt! + 10;
        expect(mocks.persisted.rig.keep).not.toHaveProperty('lastMode');

        storage.setState({ sessions: {} } as any);
        mocks.emitWithAck.mockReset();
        mocks.emitWithAck.mockResolvedValue({ result: 'success', version: 3 });
        apply('drop', metadata({ draftUpdatedAt: remoteStamp, draft: { ...lastMode, permissionMode: 'full_access', text: 'from desktop' } }));
        expect(session('drop')).toMatchObject({ draft: 'from desktop', permissionMode: 'full_access', draftUpdatedAt: remoteStamp });
        expect(mocks.persisted.rig.drop).toMatchObject({ text: 'from desktop', draftUpdatedAt: remoteStamp, permissionMode: 'full_access' });
        expect(mocks.persisted.rig.keep).toMatchObject({ text: 'offline keep', draftUpdatedAt: keepStamp });
        await settle();
        expect(mocks.emitWithAck).not.toHaveBeenCalled();

        apply('keep', metadata({ draftUpdatedAt: 5, draft: { ...lastMode, text: 'server keep' } }));
        expect(session('keep')).toMatchObject({ draft: 'offline keep', draftUpdatedAt: keepStamp });
        await settle();
        expect(writes()).toEqual([expect.objectContaining({
            sid: 'keep',
            metadata: expect.objectContaining({ draft: expect.objectContaining({ text: 'offline keep' }), draftUpdatedAt: keepStamp }),
        })]);
    });
});
