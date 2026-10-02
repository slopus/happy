import { describe, expect, it, vi } from 'vitest';
import { canSendStagedMessageNow, createMessageStagingQueue, type StagingSession, type StagingSnapshot } from './messageStagingQueue';

function setup(initial?: StagingSnapshot) {
    let session: StagingSession = { connected: true, state: 'running', turnId: 'old', supportsSteer: true };
    const send = vi.fn(async (_message: unknown): Promise<void> => undefined);
    const steer = vi.fn(async (): Promise<void> => undefined);
    const save = vi.fn();
    const queue = createMessageStagingQueue({
        load: () => initial ?? { messages: [], barriers: {} }, save,
        session: () => session, send, steer,
    });
    return { queue, send, steer, save,
        update(next: Partial<StagingSession>) { session = { ...session, ...next }; queue.refresh(); },
        add(id: string) { queue.enqueue({ id, sessionId: 's', text: id, modeMeta: { model: 'chosen' } }); },
    };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('message staging queue', () => {
    it('does not advance during the cold-start queued-to-running handoff', async () => {
        const t = setup();
        t.update({ state: 'idle', turnId: undefined });
        t.add('1'); t.add('2'); t.add('3');
        await tick();
        t.update({ state: 'running' }); // CLI queue accepted 1, no native turn yet
        t.update({ state: 'idle' }); // old CLI briefly clears queuedMessages
        await tick();
        expect(t.send).toHaveBeenCalledTimes(1);
        expect(t.queue.getSnapshot().messages.map(m => m.id)).toEqual(['2', '3']);

        t.update({ state: 'running', turnId: 'turn-1' });
        t.add('8');
        await t.queue.steer('8');
        expect(t.steer).toHaveBeenCalledWith(expect.objectContaining({ id: '8' }), 'turn-1');
        expect(t.send).toHaveBeenCalledTimes(1);
        t.update({ state: 'completed' });
        await tick();
        expect(t.send).toHaveBeenCalledTimes(2);
        t.update({ state: 'running' }); // pending 2 still carries completed turn-1
        t.update({ state: 'completed' });
        await tick();
        expect(t.send).toHaveBeenCalledTimes(2);
        t.update({ state: 'running', turnId: 'turn-2' });
        t.update({ state: 'completed' });
        await tick();
        expect(t.send).toHaveBeenCalledTimes(3);
    });

    it('allows a new user submission to retry a failed turn', async () => {
        const t = setup();
        t.update({ state: 'failed' });
        t.add('retry');
        await tick();
        expect(t.send).toHaveBeenCalledTimes(1);
        t.add('next');
        await tick();
        expect(t.send).toHaveBeenCalledTimes(1);
    });

    it('releases the barrier after a cancelled turn missed while backgrounded', async () => {
        const t = setup();
        t.update({ state: 'idle' });
        t.add('a'); t.add('b');
        await tick();
        t.update({ state: 'idle', turnId: 'cancelled-new-turn', terminal: true });
        await tick();
        expect(t.send).toHaveBeenCalledTimes(2);
    });

    it('does not leave a phantom turn barrier when a failed submission is removed', async () => {
        const t = setup();
        t.send.mockRejectedValueOnce(new Error('upload failed'));
        t.add('a'); t.add('b');
        t.update({ state: 'completed' });
        await tick();
        t.queue.remove('a');
        await tick();
        expect(t.send).toHaveBeenCalledTimes(2);
    });
    it('holds messages while busy, deletes without sending, and sends one per completed turn', async () => {
        const t = setup();
        t.add('a'); t.add('b'); t.add('c');
        t.queue.remove('b');
        expect(t.send).not.toHaveBeenCalled();
        t.update({ state: 'completed' });
        await tick();
        expect(t.send.mock.calls.map(c => c[0])).toHaveLength(1);
        expect(t.queue.getSnapshot().messages.map(m => m.id)).toEqual(['c']);
        t.queue.refresh(); t.queue.refresh();
        await tick();
        expect(t.send).toHaveBeenCalledTimes(1);
        t.update({ state: 'running', turnId: 'a-turn' });
        t.update({ state: 'completed' });
        await tick();
        expect(t.send).toHaveBeenCalledTimes(2);
        expect(t.queue.getSnapshot().messages).toEqual([]);
    });

    it('does not let rapid consecutive sends overtake the pending first turn', async () => {
        const t = setup();
        t.update({ state: 'idle' });
        t.add('a'); t.add('b');
        await tick();
        expect(t.send).toHaveBeenCalledTimes(1);
        t.update({ state: 'completed', turnId: 'a-turn' });
        await tick();
        expect(t.send).toHaveBeenCalledTimes(2);
    });

    it('guides the same turn without sending a new turn, then drains the remaining queue', async () => {
        const t = setup();
        t.add('a'); t.add('b');
        await t.queue.steer('b');
        expect(t.steer).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), 'old');
        expect(t.send).not.toHaveBeenCalled();
        expect(t.queue.getSnapshot().messages.map(m => m.id)).toEqual(['a']);
        t.update({ state: 'running' });
        expect(t.send).not.toHaveBeenCalled();
        t.update({ state: 'completed' });
        await tick();
        expect(t.send).toHaveBeenCalledTimes(1);
    });

    it('retains rejected guidance and never silently interrupts or starts a replacement turn', async () => {
        const t = setup();
        t.add('a'); t.add('b');
        t.steer.mockRejectedValueOnce(new Error('turn mismatch'));
        await t.queue.steer('a');
        expect(t.queue.getSnapshot().messages[0].status).toBe('failed');
        expect(t.send).not.toHaveBeenCalled();
        t.update({ state: 'completed' });
        await tick();
        expect(t.send).not.toHaveBeenCalled();
    });

    it('keeps slash commands queued instead of sending them as model guidance', async () => {
        const t = setup();
        t.queue.enqueue({ id: 'command', sessionId: 's', text: '/skills', modeMeta: {} });
        await t.queue.steer('command');
        expect(t.steer).not.toHaveBeenCalled();
        expect(t.queue.getSnapshot().messages[0].status).toBe('queued');
        t.update({ state: 'completed' });
        await tick();
        expect(t.send).toHaveBeenCalledTimes(1);
        t.add('after-command');
        t.update({ state: 'completed', terminal: true, turnId: 'codex-command-new' });
        await tick();
        expect(t.send).toHaveBeenCalledTimes(2);
    });

    it('keeps messages queued when an old CLI cannot steer, then sends after completion', async () => {
        const t = setup();
        t.update({ supportsSteer: false });
        t.add('a');
        await t.queue.steer('a');
        expect(t.steer).not.toHaveBeenCalled();
        expect(t.send).not.toHaveBeenCalled();
        expect(t.queue.getSnapshot().messages[0].status).toBe('queued');
        t.update({ state: 'completed' });
        await tick();
        expect(t.send).toHaveBeenCalledTimes(1);
    });

    it('keeps guidance queued until a native turn ID arrives', async () => {
        const t = setup();
        t.update({ state: 'permission_required', turnId: undefined });
        t.add('a');
        await t.queue.steer('a');
        expect(t.queue.getSnapshot()).toEqual(expect.objectContaining({ barriers: {}, messages: [expect.objectContaining({ status: 'queued' })] }));
        expect(t.steer).not.toHaveBeenCalled();
        t.update({ turnId: 'active' });
        await t.queue.steer('a');
        expect(t.steer).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'active');
    });

    it('allows an old CLI failed message to be retried after the task finishes', async () => {
        const t = setup({ messages: [{ id: 'a', sessionId: 's', text: 'a', modeMeta: {}, status: 'failed' }], barriers: {} });
        t.update({ supportsSteer: false });
        await t.queue.steer('a');
        expect(t.queue.getSnapshot().messages[0].status).toBe('failed');
        expect(t.send).not.toHaveBeenCalled();
        t.update({ state: 'completed' });
        await t.queue.steer('a');
        expect(t.send).toHaveBeenCalledTimes(1);
        expect(t.queue.getSnapshot().messages).toEqual([]);
    });

    it('retains failed messages and blocks later messages until manual action', async () => {
        const t = setup();
        t.send.mockRejectedValueOnce(new Error('upload failed'));
        t.add('a'); t.add('b');
        t.update({ state: 'completed' });
        await tick();
        expect(t.queue.getSnapshot().messages[0].status).toBe('failed');
        t.queue.refresh();
        expect(t.send).toHaveBeenCalledTimes(1);
        await t.queue.steer('a');
        expect(t.send).toHaveBeenCalledTimes(2);
    });

    it('waits through disconnection, permissions and failures', async () => {
        const t = setup();
        t.add('a');
        t.update({ connected: false, state: 'completed' });
        t.update({ connected: true, state: 'permission_required' });
        t.update({ state: 'failed' });
        expect(t.send).not.toHaveBeenCalled();
        t.update({ state: 'completed' });
        await tick();
        expect(t.send).toHaveBeenCalledTimes(1);
    });

    it('does not automatically retry an ambiguous sending record after reload', async () => {
        const t = setup({ messages: [{ id: 'a', sessionId: 's', text: 'a', modeMeta: {}, status: 'sending' }], barriers: {} });
        t.update({ state: 'completed' });
        await tick();
        expect(t.send).not.toHaveBeenCalled();
        expect(t.queue.getSnapshot().messages[0].status).toBe('failed');
    });

    it('handles an entire fast turn occurring before send resolves', async () => {
        const t = setup();
        let accepted!: () => void;
        t.send.mockImplementationOnce(() => new Promise<void>(r => { accepted = r; }));
        t.add('a'); t.add('b');
        t.update({ state: 'completed' });
        t.update({ state: 'running', turnId: 'a-turn' });
        t.update({ state: 'completed' });
        accepted(); await tick();
        expect(t.send).toHaveBeenCalledTimes(2);
    });
});

// Availability is shared with the queue-row button, including manual recovery.
describe('send-now availability', () => {
    it('requires an active native turn while busy, but allows idle slash commands', () => {
        const busy: StagingSession = { connected: true, state: 'running', supportsSteer: true };
        expect(canSendStagedMessageNow({ text: 'a' }, busy)).toBe(false);
        expect(canSendStagedMessageNow({ text: 'a' }, { ...busy, turnId: 't' })).toBe(true);
        expect(canSendStagedMessageNow({ text: '/skills' }, { ...busy, turnId: 't' })).toBe(false);
        expect(canSendStagedMessageNow({ text: '/skills' }, { ...busy, state: 'idle', supportsSteer: false })).toBe(true);
        expect(canSendStagedMessageNow({ text: 'retry' }, { ...busy, state: 'failed', supportsSteer: false })).toBe(true);
        expect(canSendStagedMessageNow({ text: 'retry' }, { ...busy, state: 'idle', connected: false })).toBe(false);
    });
});
