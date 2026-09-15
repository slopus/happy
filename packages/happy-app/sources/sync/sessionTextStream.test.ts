import { describe, expect, it, vi } from 'vitest';
import { SessionTextStream, type SessionTextPreview } from './sessionTextStream';
import type { NormalizedMessage } from './typesRaw';

const envelope = (sid = 's') => ({ sid, content: { t: 'encrypted', c: 'ciphertext' } });
const delta = (text: string, itemId = 'item', turnId = 'turn') => ({ type: 'text-delta', turnId, itemId, text, delta: text });
const final = (turnId = 'turn', itemId = 'item'): NormalizedMessage => ({
    id: 'durable', localId: null, createdAt: 5, role: 'agent', isSidechain: false,
    content: [{ type: 'text', text: 'authoritative', uuid: 'durable', parentUUID: null }],
    streamKey: { turnId, itemId },
} as NormalizedMessage);
function fixture() {
    let visible: readonly SessionTextPreview[] = [];
    const stream = new SessionTextStream(value => { visible = value; });
    stream.activate('s');
    return { stream, get visible() { return visible; }, send: (text: string, item = 'item', turn = 'turn') =>
        stream.receive(envelope(), async () => delta(text, item, turn)) };
}
describe('session text previews', () => {
    it('shows cumulative content immediately and replaces rather than appends', async () => {
        const f = fixture();
        await f.send('Hello');
        expect(f.visible.map(p => p.text)).toEqual(['Hello']);
        const createdAt = f.visible[0].createdAt;
        await f.send('Hello world');
        expect(f.visible.map(p => p.text)).toEqual(['Hello world']);
        expect(f.visible[0].createdAt).toBe(createdAt);
    });
    it('does not regress on duplicate, reordered or inconsistent cumulative snapshots', async () => {
        const f = fixture();
        await f.send('Hello world');
        await f.send('Hello');
        await f.send('Different longer text');
        expect(f.visible.map(p => p.text)).toEqual(['Hello world']);
    });
    it('discards decryptions from a previous route including a same-session remount', async () => {
        const f = fixture();
        let finish!: (value: unknown) => void;
        const pending = f.stream.receive(envelope(), () => new Promise(resolve => { finish = resolve; }));
        f.stream.activate('s');
        finish(delta('old account/route'));
        await pending;
        expect(f.visible).toEqual([]);
        await f.send('fresh');
        expect(f.visible[0].text).toBe('fresh');
    });
    it('only decrypts valid encrypted events for the active session', async () => {
        const f = fixture();
        const decrypt = vi.fn(async () => delta('private'));
        await f.stream.receive(envelope('other'), decrypt);
        await f.stream.receive({ sid: 's', content: { t: 'text', c: 'plain' } }, decrypt);
        expect(decrypt).not.toHaveBeenCalled();
        await f.stream.receive(envelope(), async () => ({ ...delta('x'), turnId: '' }));
        await f.stream.receive(envelope(), async () => { throw new Error('secret'); });
        await f.stream.receive(envelope(), decrypt, () => false);
        expect(f.visible).toEqual([]);
    });
    it('closes only the exact final item and never resurrects it from a late delta', async () => {
        const f = fixture();
        await f.send('Hello'); await f.send('Other', 'other');
        f.stream.observeDurable('s', [final()]);
        expect(f.visible.map(p => p.itemId)).toEqual(['other']);
        await f.send('Hello late');
        expect(f.visible.map(p => p.itemId)).toEqual(['other']);
    });
    it('remembers finals seen before previews and isolates turns and sessions', async () => {
        const f = fixture();
        f.stream.observeDurable('other', [final()]);
        f.stream.observeDurable('s', [final('old')]);
        await f.send('current');
        expect(f.visible[0].text).toBe('current');
        f.stream.observeDurable('s', [final()]);
        await f.send('late');
        expect(f.visible).toEqual([]);
    });
    it('clears completed, cancelled and failed root turns but ignores sidechains', async () => {
        const f = fixture();
        await f.send('working');
        const terminal = { id: 'end', localId: null, createdAt: 6, role: 'event', content: { type: 'ready', terminal: true },
            isSidechain: true, streamKey: { turnId: 'turn' } } as NormalizedMessage;
        f.stream.observeDurable('s', [terminal]);
        expect(f.visible).toHaveLength(1);
        f.stream.observeDurable('s', [{ ...terminal, isSidechain: false }]);
        await f.send('late terminal');
        expect(f.visible).toEqual([]);
    });
    it('drops in-flight work on disconnect but retains final tombstones for reconnect', async () => {
        const f = fixture();
        f.stream.observeDurable('s', [final()]);
        await f.send('working', 'other');
        f.stream.interrupt();
        expect(f.visible).toEqual([]);
        await f.send('late final');
        await f.send('reconnected', 'other');
        expect(f.visible.map(p => p.text)).toEqual(['reconnected']);
    });
    it('bounds aggregate UTF-8 text and active items without dropping existing previews', async () => {
        const f = fixture();
        await f.send('界'.repeat(180_000));
        await f.send('界'.repeat(180_000), 'too-large');
        expect(f.visible).toHaveLength(1);
        for (let i = 0; i < 255; i++) await f.send('x', `item-${i}`);
        await f.send('overflow', 'overflow');
        expect(f.visible).toHaveLength(256);
        expect(f.visible.some(p => p.itemId === 'overflow')).toBe(false);
        await f.send('xy', 'item-0');
        expect(f.visible.find(p => p.itemId === 'item-0')?.text).toBe('xy');
    });
    it('bounds concurrent decryptions and rejects results whose ownership changes while decrypting', async () => {
        const f = fixture();
        let current = true;
        const finishes: Array<(value: unknown) => void> = [];
        const decrypt = vi.fn(() => new Promise(resolve => finishes.push(resolve)));
        const pending = Array.from({ length: 9 }, () => f.stream.receive(envelope(), decrypt, () => current));
        expect(decrypt).toHaveBeenCalledTimes(8);
        current = false;
        finishes.forEach(resolve => resolve(delta('stale')));
        await Promise.all(pending);
        expect(f.visible).toEqual([]);
        await f.send('fresh');
        expect(f.visible[0].text).toBe('fresh');
    });
    it('fails closed when terminal bookkeeping reaches its bound until the next route', async () => {
        const f = fixture();
        f.stream.observeDurable('s', Array.from({ length: 4097 }, (_, i) => final(`turn-${i}`)));
        await f.send('late');
        expect(f.visible).toEqual([]);
        f.stream.activate('s');
        await f.send('fresh');
        expect(f.visible[0].text).toBe('fresh');
    });
});
