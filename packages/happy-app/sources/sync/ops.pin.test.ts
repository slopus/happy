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

describe('sessionSetPinned', () => {
    beforeEach(() => {
        emitWithAck.mockReset();
        applySessions.mockReset();
        encryptRaw.mockClear();
        decryptRaw.mockClear();
        Object.keys(sessions).forEach((key) => delete sessions[key]);
        sessions['s1'] = { id: 's1', metadata: { summary: 'keep me' }, metadataVersion: 1 };
    });

    it('pins optimistically and pushes pinnedAt into metadata', async () => {
        emitWithAck.mockResolvedValue({ result: 'success', version: 2 });

        const { sessionSetPinned } = await import('./ops');
        sessionSetPinned('s1', true);

        expect(applySessions).toHaveBeenCalledTimes(1);
        expect(typeof sessions['s1'].metadata.pinnedAt).toBe('number');

        await flush();
        expect(emitWithAck).toHaveBeenCalledWith('update-metadata', expect.objectContaining({
            sid: 's1',
            expectedVersion: 1,
            metadata: expect.objectContaining({ pinnedAt: expect.any(Number), summary: 'keep me' }),
        }));
    });

    it('keeps the pin through a metadata version conflict', async () => {
        emitWithAck
            .mockResolvedValueOnce({ result: 'version-mismatch', version: 7, metadata: { summary: 'server' } })
            .mockResolvedValueOnce({ result: 'success', version: 8 });

        const { sessionSetPinned } = await import('./ops');
        sessionSetPinned('s1', true);
        await flush();

        // The retry must replay pinnedAt onto the server's newer metadata —
        // dropping it left the row pinned locally and unpinned everywhere else.
        expect(emitWithAck).toHaveBeenCalledTimes(2);
        expect(emitWithAck).toHaveBeenLastCalledWith('update-metadata', expect.objectContaining({
            expectedVersion: 7,
            metadata: expect.objectContaining({ pinnedAt: expect.any(Number), summary: 'server' }),
        }));
    });

    it('drops the replay when the user unpinned while the push was in flight', async () => {
        emitWithAck
            .mockResolvedValueOnce({ result: 'version-mismatch', version: 7, metadata: { summary: 'server' } })
            .mockResolvedValueOnce({ result: 'success', version: 8 });

        const { sessionSetPinned } = await import('./ops');
        sessionSetPinned('s1', true);
        sessions['s1'] = { ...sessions['s1'], metadata: { ...sessions['s1'].metadata, pinnedAt: null } };
        await flush();

        expect(emitWithAck).toHaveBeenCalledTimes(1);
    });

    it('guards the optimistic value against stale inbound updates until the push settles', async () => {
        let resolvePush: (value: unknown) => void = () => {};
        emitWithAck.mockImplementation(() => new Promise((resolve) => { resolvePush = resolve; }));

        const { sessionSetPinned } = await import('./ops');
        const { isMetadataPushPending } = await import('./metadataPushPending');

        sessionSetPinned('s1', true);
        // The push only reaches the socket after the encrypt await, so let it
        // get there before handing it a result.
        await flush();
        expect(isMetadataPushPending('s1', 'pinnedAt')).toBe(true);

        resolvePush({ result: 'success', version: 2 });
        await flush();
        expect(isMetadataPushPending('s1', 'pinnedAt')).toBe(false);
    });

    // Regression: marking the field pending before the optimistic write made
    // applySessions resolve pinnedAt back to its pre-change value, so the pin
    // only showed up once the server echoed it back.
    it('applies the optimistic write before the field is marked pending', async () => {
        emitWithAck.mockResolvedValue({ result: 'success', version: 2 });

        const { isMetadataPushPending } = await import('./metadataPushPending');
        const pendingDuringWrite: boolean[] = [];
        applySessions.mockImplementation(() => {
            pendingDuringWrite.push(isMetadataPushPending('s1', 'pinnedAt'));
        });

        const { sessionSetPinned } = await import('./ops');
        sessionSetPinned('s1', true);

        expect(pendingDuringWrite).toEqual([false]);
        expect(isMetadataPushPending('s1', 'pinnedAt')).toBe(true);
        await flush();
    });

    it('unpins by writing an explicit null', async () => {
        sessions['s1'].metadata.pinnedAt = 1700000000000;
        emitWithAck.mockResolvedValue({ result: 'success', version: 2 });

        const { sessionSetPinned } = await import('./ops');
        sessionSetPinned('s1', false);
        await flush();

        expect(sessions['s1'].metadata.pinnedAt).toBeNull();
        expect(emitWithAck).toHaveBeenCalledWith('update-metadata', expect.objectContaining({
            metadata: expect.objectContaining({ pinnedAt: null }),
        }));
    });

    it('does nothing when the session is already in the requested state', async () => {
        const { sessionSetPinned } = await import('./ops');
        sessionSetPinned('s1', false);

        expect(applySessions).not.toHaveBeenCalled();
        expect(emitWithAck).not.toHaveBeenCalled();
    });
});
