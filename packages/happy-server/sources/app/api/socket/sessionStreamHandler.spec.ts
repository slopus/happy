import { describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { sessionStreamHandler } from '@/app/api/socket/sessionStreamHandler';
import { db } from '@/storage/db';

vi.mock('@/storage/db', () => ({ db: { session: {
    findUnique: async ({ where }: { where: { id: string; accountId: string } }) => (
        where.id === 'session' && where.accountId === 'owner' ? { id: 'session' } : null
    ),
} } }));

function setup(userId = 'owner', type: 'session-scoped' | 'user-scoped' = 'session-scoped', sid = 'session') {
    const listeners = new Map<string, (...args: any[]) => unknown>();
    const sent: unknown[] = [];
    const socket = {
        connected: true,
        on: (name: string, handler: (...args: any[]) => unknown) => listeners.set(name, handler),
        broadcast: { volatile: { to: (rooms: string[]) => ({ emit: (event: string, payload: unknown) => sent.push({ rooms, event, payload }) }) } },
    } as unknown as Socket;
    const connection = type === 'session-scoped'
        ? { connectionType: type, socket, userId, sessionId: sid }
        : { connectionType: type, socket, userId };
    sessionStreamHandler(userId, socket, connection);
    return { sent, socket, receive: (payload: unknown) => listeners.get('session-stream')!(payload) };
}

const payload = { sid: 'session', content: { t: 'encrypted', c: 'YWJj' } };

describe('session stream authorization and transient routing', () => {
    it('bounds a slow ownership lookup queue and retains the latest cumulative snapshots', async () => {
        const socket = setup();
        let resolveLookup!: (value: { id: string }) => void;
        const lookup = vi.spyOn(db.session, 'findUnique').mockImplementationOnce(() => new Promise(resolve => { resolveLookup = resolve; }) as any);
        const sends = Array.from({ length: 100 }, (_, index) => socket.receive({ ...payload, content: { t: 'encrypted', c: `${index}`.padEnd(200_000, 'x') } }));
        resolveLookup({ id: 'session' });
        await Promise.all(sends);
        const snapshots = socket.sent.map((event: any) => event.payload.content.c);
        expect(snapshots.length).toBeLessThanOrEqual(8);
        expect(snapshots.reduce((total: number, text: string) => total + text.length, 0)).toBeLessThanOrEqual(900 * 1024);
        expect(snapshots.at(-1)).toBe('99'.padEnd(200_000, 'x'));
        lookup.mockRestore();
    });
    it('keeps stream arrival order while the owner lookup is pending', async () => {
        const socket = setup();
        let resolveLookup!: (value: { id: string }) => void;
        const lookup = vi.spyOn(db.session, 'findUnique').mockImplementationOnce(() => new Promise(resolve => {
            resolveLookup = resolve;
        }) as any);
        const first = socket.receive(payload);
        const secondPayload = { ...payload, content: { t: 'encrypted', c: 'ZGVm' } };
        const second = socket.receive(secondPayload);
        await Promise.resolve();
        expect(socket.sent).toEqual([]);
        resolveLookup({ id: 'session' });
        await Promise.all([first, second]);
        expect(socket.sent.map((event: any) => event.payload)).toEqual([payload, secondPayload]);
        lookup.mockRestore();
    });
    it('forwards ciphertext only to the owner session and owner user rooms', async () => {
        const socket = setup();
        await socket.receive(payload);
        expect(socket.sent).toEqual([{ rooms: ['user:owner:session:session', 'user:owner:user-scoped'], event: 'session-stream', payload }]);
    });

    it.each([
        ['intruder', 'session-scoped', 'session'],
        ['owner', 'user-scoped', 'session'],
        ['owner', 'session-scoped', 'another-session'],
    ] as const)('rejects sender %s with %s scope bound to %s', async (user, type, sid) => {
        const socket = setup(user, type, sid);
        await socket.receive(payload);
        expect(socket.sent).toEqual([]);
    });

    it('rejects plaintext, oversized envelopes and disconnected senders', async () => {
        const socket = setup();
        await socket.receive({ sid: 'session', content: { t: 'text', c: 'private' } });
        await socket.receive({ sid: 'session', content: { t: 'encrypted', c: 'x'.repeat(1024 * 1024) } });
        socket.socket.connected = false;
        await socket.receive(payload);
        expect(socket.sent).toEqual([]);
    });
});
