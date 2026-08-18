import { beforeEach, describe, expect, it, vi } from 'vitest';

const { emitWithAck, encryptRaw, decryptRaw, applySessions, sessions } = vi.hoisted(() => ({
    emitWithAck: vi.fn(),
    // Identity crypto so assertions can read the metadata that would go on the wire.
    encryptRaw: vi.fn(async (value: unknown) => value),
    decryptRaw: vi.fn(async (value: unknown) => value),
    applySessions: vi.fn(),
    sessions: {} as Record<string, any>,
}));

vi.mock('./apiSocket', () => ({
    apiSocket: { emitWithAck, machineRPC: vi.fn() },
}));

vi.mock('./sync', () => ({
    sync: {
        encryption: { getSessionEncryption: () => ({ encryptRaw, decryptRaw }) },
        refreshSessions: vi.fn(),
    },
}));

vi.mock('./storage', () => ({
    storage: {
        getState: () => ({
            sessions,
            // Mirrors the real optimistic write so the retry path sees it.
            applySessions: (updated: any[]) => {
                applySessions(updated);
                updated.forEach((session) => { sessions[session.id] = session; });
            },
        }),
    },
}));

const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('sessionSetArchived', () => {
    beforeEach(() => {
        emitWithAck.mockReset();
        applySessions.mockReset();
        encryptRaw.mockClear();
        decryptRaw.mockClear();
        Object.keys(sessions).forEach((key) => delete sessions[key]);
        sessions['s1'] = { id: 's1', metadata: { summary: 'keep me' }, metadataVersion: 1 };
    });

    it('archives optimistically and pushes archivedAt into metadata', async () => {
        emitWithAck.mockResolvedValue({ result: 'success', version: 2 });

        const { sessionSetArchived } = await import('./ops');
        sessionSetArchived('s1', true);

        expect(applySessions).toHaveBeenCalledTimes(1);
        expect(typeof sessions['s1'].metadata.archivedAt).toBe('number');

        await flush();
        expect(emitWithAck).toHaveBeenCalledWith('update-metadata', expect.objectContaining({
            sid: 's1',
            expectedVersion: 1,
            metadata: expect.objectContaining({ archivedAt: expect.any(Number), summary: 'keep me' }),
        }));
    });

    it('leaves the agent lifecycle alone — archiving is only about the list', async () => {
        emitWithAck.mockResolvedValue({ result: 'success', version: 2 });

        const { sessionSetArchived } = await import('./ops');
        sessionSetArchived('s1', true);
        await flush();

        const pushed = emitWithAck.mock.calls[0][1].metadata;
        expect(pushed).not.toHaveProperty('lifecycleState');
        expect(pushed).not.toHaveProperty('lifecycleStateSince');
    });

    it('keeps the archive through a metadata version conflict', async () => {
        emitWithAck
            .mockResolvedValueOnce({ result: 'version-mismatch', version: 7, metadata: { summary: 'server' } })
            .mockResolvedValueOnce({ result: 'success', version: 8 });

        const { sessionSetArchived } = await import('./ops');
        sessionSetArchived('s1', true);
        await flush();

        expect(emitWithAck).toHaveBeenCalledTimes(2);
        expect(emitWithAck).toHaveBeenLastCalledWith('update-metadata', expect.objectContaining({
            expectedVersion: 7,
            metadata: expect.objectContaining({ archivedAt: expect.any(Number), summary: 'server' }),
        }));
    });

    it('drops the replay when the session was un-archived while the push was in flight', async () => {
        emitWithAck
            .mockResolvedValueOnce({ result: 'version-mismatch', version: 7, metadata: { summary: 'server' } })
            .mockResolvedValueOnce({ result: 'success', version: 8 });

        const { sessionSetArchived } = await import('./ops');
        sessionSetArchived('s1', true);
        sessions['s1'] = { ...sessions['s1'], metadata: { ...sessions['s1'].metadata, archivedAt: null } };
        await flush();

        expect(emitWithAck).toHaveBeenCalledTimes(1);
    });

    it('guards the optimistic value against stale inbound updates until the push settles', async () => {
        let resolvePush: (value: unknown) => void = () => {};
        emitWithAck.mockImplementation(() => new Promise((resolve) => { resolvePush = resolve; }));

        const { sessionSetArchived } = await import('./ops');
        const { isMetadataPushPending } = await import('./metadataPushPending');

        sessionSetArchived('s1', true);
        await flush();
        expect(isMetadataPushPending('s1', 'archivedAt')).toBe(true);

        resolvePush({ result: 'success', version: 2 });
        await flush();
        expect(isMetadataPushPending('s1', 'archivedAt')).toBe(false);
    });

    it('un-archives by writing an explicit null', async () => {
        sessions['s1'].metadata.archivedAt = 1700000000000;
        emitWithAck.mockResolvedValue({ result: 'success', version: 2 });

        const { sessionSetArchived } = await import('./ops');
        sessionSetArchived('s1', false);
        await flush();

        expect(sessions['s1'].metadata.archivedAt).toBeNull();
        expect(emitWithAck).toHaveBeenCalledWith('update-metadata', expect.objectContaining({
            metadata: expect.objectContaining({ archivedAt: null }),
        }));
    });

    it('does nothing when the session is already in the requested state', async () => {
        const { sessionSetArchived } = await import('./ops');
        sessionSetArchived('s1', false);

        expect(applySessions).not.toHaveBeenCalled();
        expect(emitWithAck).not.toHaveBeenCalled();
    });

    // Regression: marking the field pending before the optimistic write made
    // applySessions resolve archivedAt back to its pre-change value, so the row
    // stayed in the list until the server echoed the change back.
    it('applies the optimistic write before the field is marked pending', async () => {
        emitWithAck.mockResolvedValue({ result: 'success', version: 2 });

        const { isMetadataPushPending } = await import('./metadataPushPending');
        const pendingDuringWrite: boolean[] = [];
        applySessions.mockImplementation(() => {
            pendingDuringWrite.push(isMetadataPushPending('s1', 'archivedAt'));
        });

        const { sessionSetArchived } = await import('./ops');
        sessionSetArchived('s1', true);

        expect(pendingDuringWrite).toEqual([false]);
        expect(isMetadataPushPending('s1', 'archivedAt')).toBe(true);
        await flush();
    });

    it('pins and archives without clobbering each other', async () => {
        emitWithAck.mockResolvedValue({ result: 'success', version: 2 });

        const { sessionSetArchived, sessionSetPinned } = await import('./ops');
        sessionSetPinned('s1', true);
        sessionSetArchived('s1', true);
        await flush();

        expect(typeof sessions['s1'].metadata.pinnedAt).toBe('number');
        expect(typeof sessions['s1'].metadata.archivedAt).toBe('number');
    });
});
