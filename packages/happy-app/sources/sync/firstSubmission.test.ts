import { describe, expect, it, vi } from 'vitest';
import { FirstSubmissionOwner } from './firstSubmission';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}
const input = { text: 'original', prompt: 'generated', machineId: 'machine', path: '/work', agent: 'codex' as const, worktreeKey: null, attachments: [{ id: 'a', name: 'a.png' }] };
function fixture() {
    const disk = new Map<string, string>();
    let current = true;
    const effects: string[] = [];
    const receipt = { type: 'queued' as const, sessionId: 'session', localIds: ['local'] };
    const deps = {
        save: vi.fn(async (scope: string, value: string) => { disk.set(scope, value); }),
        read: (scope: string) => disk.get(scope),
        spawn: vi.fn(async () => { effects.push('spawn'); return { type: 'success' as const, sessionId: 'session' }; }),
        hydrate: vi.fn(async () => true),
        configure: vi.fn(),
        send: vi.fn(async () => { effects.push('send'); return receipt; }),
        project: vi.fn(async (_receipt: typeof receipt) => true),
        accepted: vi.fn(),
        metric: vi.fn(),
    };
    const owner = new FirstSubmissionOwner(deps);
    owner.activate('account/server', () => current);
    return { owner, deps, disk, effects, receipt, invalidate: () => { current = false; } };
}
describe('recoverable first submission', () => {
    it.each(['error', 'cancelled'])('allows an explicit new submission after a %s without restoring old text', async type => {
        const f = fixture(); f.deps.spawn.mockResolvedValueOnce({ type } as any);
        await f.owner.submit(input, { images: [] });
        expect(await f.owner.submit({ ...input, text: 'new request', prompt: 'new request', attachments: [] }, { images: [] })).toBe(true);
        expect(f.owner.getSnapshot()).toMatchObject({ text: 'new request', phase: 'ready', attachments: [] });
        expect(f.deps.send).toHaveBeenCalledExactlyOnceWith('session', expect.objectContaining({ prompt: 'new request' }), expect.anything(), expect.any(Function));
    });
    it('allows fresh input after refresh without replaying the interrupted message', async () => {
        const f = fixture();
        f.disk.set('account/server', JSON.stringify({ ...input, version: 1, scope: 'account/server', phase: 'sending', sessionId: 'old-session' }));
        f.owner.activate('account/server', () => true);
        expect(f.effects).toEqual([]);
        expect(await f.owner.submit({ ...input, prompt: 'fresh input', attachments: [] }, { images: [] })).toBe(true);
        expect(f.deps.send).toHaveBeenCalledExactlyOnceWith('session', expect.objectContaining({ prompt: 'fresh input' }), expect.anything(), expect.any(Function));
    });
    it('preserves the old recovery and receipt if saving a replacement fails', async () => {
        const f = fixture(); f.deps.project.mockResolvedValueOnce(false);
        await f.owner.submit(input, { images: [] });
        const saved = f.disk.get('account/server');
        const previous = f.owner.getSnapshot();
        f.deps.save.mockRejectedValueOnce(new Error('quota'));
        const released = vi.fn();
        expect(await f.owner.submit({ ...input, text: 'new request' }, { images: [], released })).toBe(false);
        expect(f.owner.getSnapshot()).toBe(previous);
        expect(f.disk.get('account/server')).toBe(saved);
        expect(released).not.toHaveBeenCalled();
        expect(await f.owner.retry()).toBe(true);
        expect(f.effects).toEqual(['spawn', 'send']);
    });
    it('does not reuse the old accepted receipt after a replacement is saved', async () => {
        const f = fixture(); f.deps.project.mockResolvedValueOnce(false);
        await f.owner.submit(input, { images: [] });
        f.deps.save.mockImplementation(async (scope, value) => {
            if (JSON.parse(value)?.phase === 'spawning') throw new Error('quota');
            f.disk.set(scope, value);
        });
        expect(await f.owner.submit({ ...input, text: 'new request' }, { images: [] })).toBe(false);
        expect(f.owner.getSnapshot()).toMatchObject({ text: 'new request', phase: 'failed' });
        expect(f.owner.getSnapshot()?.sessionId).toBeUndefined();
        expect(f.owner.getSnapshot()?.retry).toBeUndefined();
        expect(await f.owner.retry()).toBe(false);
        expect(f.deps.project).toHaveBeenCalledTimes(1);
    });
    it('blocks retry and replacement while a recovery record is being cleared', async () => {
        const f = fixture(); f.deps.project.mockResolvedValueOnce(false);
        await f.owner.submit(input, { images: [] });
        const cleared = deferred<void>();
        f.deps.save.mockImplementationOnce(() => cleared.promise);
        const dismissing = f.owner.dismiss();
        expect(await f.owner.retry()).toBe(false);
        expect(await f.owner.submit(input, { images: [] })).toBe(false);
        cleared.resolve();
        expect(await dismissing).toBe(true);
        expect(f.owner.getSnapshot()).toBeNull();
        expect(f.effects).toEqual(['spawn', 'send']);
    });
    it('retains restored text across refresh without sending and replaces it only after durable submission', async () => {
        const f = fixture(); f.deps.spawn.mockResolvedValueOnce({ type: 'error' } as any);
        await f.owner.submit(input, { images: [] });
        expect(await f.owner.restore('original and newer edit', [], f.owner.getSnapshot())).toBe(true);
        f.owner.activate('account/server', () => true);
        expect(f.owner.getSnapshot()).toMatchObject({ phase: 'restored', text: 'original and newer edit', attachments: [] });
        expect(f.effects).toEqual([]);
        f.deps.save.mockRejectedValueOnce(new Error('quota'));
        await f.owner.submit({ ...input, text: 'replacement' }, { images: [] });
        f.owner.activate('account/server', () => true);
        expect(f.owner.getSnapshot()?.text).toBe('original and newer edit');
        expect(f.effects).toEqual([]);
    });
    it('retains the old record and does not unlock submission when restore persistence fails', async () => {
        const f = fixture(); f.deps.project.mockResolvedValue(false);
        await f.owner.submit(input, { images: [] });
        f.deps.save.mockRejectedValueOnce(new Error('quota'));
        expect(await f.owner.restore('restored', [], f.owner.getSnapshot())).toBe(false);
        expect(f.owner.getSnapshot()?.text).toBe('original');
    });
    it('requires reselected attachments after a normal restore and refresh, until explicitly omitted', async () => {
        const f = fixture(); f.deps.spawn.mockResolvedValueOnce({ type: 'error' } as any);
        await f.owner.submit(input, { images: [] });
        await f.owner.restore(input.text, input.attachments);
        f.owner.activate('account/server', () => true);
        expect(await f.owner.submit({ ...input, attachments: [] }, { images: [] })).toBe(false);
        expect(f.effects).toEqual([]);
        await f.owner.restore(input.text, []);
        expect(await f.owner.submit({ ...input, attachments: [] }, { images: [] })).toBe(true);
        expect(f.effects).toEqual(['spawn', 'send']);
    });
    it('does not apply a delayed restore completion after account replacement', async () => {
        const f = fixture(); f.deps.spawn.mockResolvedValueOnce({ type: 'error' } as any);
        await f.owner.submit(input, { images: [] });
        const saved = deferred<void>(); f.deps.save.mockImplementationOnce(() => saved.promise);
        const restoring = f.owner.restore('old text', []);
        f.owner.activate('other', () => true);
        saved.resolve();
        expect(await restoring).toBe(false);
        expect(f.owner.getSnapshot()).toBeNull();
    });
    it('saves before releasing or spawning and blocks same-tick duplicate submissions', async () => {
        const f = fixture(); const saved = deferred<void>();
        f.deps.save.mockImplementationOnce(() => saved.promise);
        const released = vi.fn();
        const submitted = f.owner.submit(input, { images: [], released });
        expect(await f.owner.submit(input, { images: [], released })).toBe(false);
        expect(f.effects).toEqual([]); expect(released).not.toHaveBeenCalled();
        saved.resolve(); await submitted;
        expect(released).toHaveBeenCalledTimes(1);
        expect(f.effects).toEqual(['spawn', 'send']);
        expect(f.owner.getSnapshot()?.phase).toBe('ready');
    });
    it('does not release or call RPC when durable saving fails', async () => {
        const f = fixture(); f.deps.save.mockRejectedValue(new Error('quota'));
        const released = vi.fn();
        expect(await f.owner.submit(input, { images: [], released })).toBe(false);
        expect(f.effects).toEqual([]); expect(released).not.toHaveBeenCalled();
        expect(f.owner.getSnapshot()?.failure).toBe('storage');
    });
    it('keeps original text and attachments while hydration is delayed and retries the known session only', async () => {
        const f = fixture(); const hydration = deferred<boolean>();
        f.deps.hydrate.mockImplementationOnce(() => hydration.promise);
        const promise = f.owner.submit(input, { images: [] });
        await vi.waitFor(() => expect(f.owner.getSnapshot()?.phase).toBe('hydrating'));
        expect(f.owner.getSnapshot()?.text).toBe('original');
        hydration.resolve(false); await promise;
        expect(f.owner.getSnapshot()?.retry).toBe('hydrate');
        await f.owner.retry();
        expect(f.effects).toEqual(['spawn', 'send']);
        expect(f.deps.hydrate.mock.calls).toEqual([['session'], ['session']]);
    });
    it('retries projection with the actual receipt without hydrating or sending again', async () => {
        const f = fixture(); f.deps.project.mockResolvedValueOnce(false);
        await f.owner.submit(input, { images: [] });
        expect(f.owner.getSnapshot()?.retry).toBe('project');
        await f.owner.retry();
        expect(f.effects).toEqual(['spawn', 'send']);
        expect(f.deps.hydrate).toHaveBeenCalledTimes(1);
        expect(f.deps.project.mock.calls[1][0]).toBe(f.receipt);
    });
    it.each(['spawning', 'sending', 'projecting', 'ready', 'hydrating'])('refresh at %s never automatically spawns or resends', async phase => {
        const f = fixture();
        f.disk.set('account/server', JSON.stringify({ ...input, version: 1, scope: 'account/server', phase, sessionId: phase === 'spawning' ? undefined : 'session' }));
        f.owner.activate('account/server', () => true);
        expect(f.owner.getSnapshot()?.failure).toBe('interrupted');
        await f.owner.retry();
        expect(f.effects).toEqual([]);
        expect(f.owner.getSnapshot()?.attachments).toEqual([{ id: 'a', name: 'a.png' }]);
    });
    it('fences late spawn completions after scope invalidation', async () => {
        const f = fixture(); const spawning = deferred<{ type: 'success'; sessionId: string }>();
        f.deps.spawn.mockImplementationOnce(() => spawning.promise);
        const promise = f.owner.submit(input, { images: [] });
        await vi.waitFor(() => expect(f.owner.getSnapshot()?.phase).toBe('spawning'));
        f.invalidate(); spawning.resolve({ type: 'success', sessionId: 'session' }); await promise;
        expect(f.deps.hydrate).not.toHaveBeenCalled(); expect(f.deps.send).not.toHaveBeenCalled();
    });
    it('continues without subscribers and reveals the ready session on remount', async () => {
        const f = fixture(); const projection = deferred<boolean>();
        f.deps.project.mockImplementationOnce(() => projection.promise);
        const unsubscribe = f.owner.subscribe(() => undefined);
        const promise = f.owner.submit(input, { images: [] });
        await vi.waitFor(() => expect(f.owner.getSnapshot()?.phase).toBe('projecting'));
        unsubscribe(); projection.resolve(true); await promise;
        expect(f.owner.getSnapshot()?.phase).toBe('ready');
        expect(f.deps.accepted).toHaveBeenCalledTimes(1);
    });
    it('only clears a finished recovery record explicitly and keeps it when disk clearing fails', async () => {
        const f = fixture(); await f.owner.submit(input, { images: [] });
        f.deps.save.mockRejectedValueOnce(new Error('quota'));
        expect(await f.owner.dismiss()).toBe(false);
        expect(f.owner.getSnapshot()).not.toBeNull();
        expect(f.owner.getSnapshot()?.retry).toBe('project');
        expect(await f.owner.dismiss()).toBe(true);
        expect(f.owner.getSnapshot()).toBeNull();
    });
    it('does not expose old-account state after activating a new scope', async () => {
        const f = fixture(); await f.owner.submit(input, { images: [] });
        f.owner.activate('different', () => true);
        expect(f.owner.getSnapshot()).toBeNull();
    });
    it('retries a rejected upload once without recreating or reconfiguring the session', async () => {
        const f = fixture(); f.deps.send.mockRejectedValueOnce(new Error('upload'));
        await f.owner.submit(input, { images: [] });
        expect(f.owner.getSnapshot()?.retry).toBe('send');
        await f.owner.retry();
        expect(f.effects).toEqual(['spawn', 'send']);
        expect(f.deps.configure).toHaveBeenCalledTimes(1);
    });
    it('never persists API environment values or blob URIs', async () => {
        const f = fixture();
        await f.owner.submit({ ...input, environmentVariables: { KEY: 'secret' } } as any,
            { environmentVariables: { KEY: 'secret' }, images: [{ id: 'a', uri: 'blob:private' } as any] });
        const saved = [...f.disk.values()].join('');
        expect(saved).not.toContain('secret'); expect(saved).not.toContain('blob:');
    });
    it('refuses stale restore actions from a previous account', async () => {
        const f = fixture(); await f.owner.submit(input, { images: [] });
        const old = f.owner.getSnapshot();
        f.owner.activate('other', () => true);
        await f.owner.submit(input, { images: [] });
        expect(await f.owner.dismiss(old)).toBe(false);
        expect(f.owner.getSnapshot()?.scope).toBe('other');
    });
    it('never resends if accepted-draft cleanup throws', async () => {
        const f = fixture(); f.deps.accepted.mockImplementation(() => { throw new Error('cleanup'); });
        f.deps.project.mockResolvedValueOnce(false);
        await f.owner.submit(input, { images: [] }); await f.owner.retry();
        expect(f.effects).toEqual(['spawn', 'send']);
        expect(f.owner.getSnapshot()?.phase).toBe('ready');
    });
    it('keeps directory cancellation recoverable without sending or automatic retry', async () => {
        const f = fixture(); f.deps.spawn.mockResolvedValueOnce({ type: 'cancelled' } as any);
        await f.owner.submit(input, { images: [] }); await f.owner.retry();
        expect(f.owner.getSnapshot()?.failure).toBe('cancelled');
        expect(f.deps.send).not.toHaveBeenCalled();
    });
    it('retains the live receipt when persisting projection progress fails', async () => {
        const f = fixture();
        f.deps.save.mockImplementation(async (scope, value) => {
            if (JSON.parse(value)?.phase === 'projecting') throw new Error('quota');
            f.disk.set(scope, value);
        });
        await f.owner.submit(input, { images: [] });
        expect(f.owner.getSnapshot()?.retry).toBe('project');
        f.deps.save.mockImplementation(async (scope, value) => { f.disk.set(scope, value); });
        await f.owner.retry();
        expect(f.effects).toEqual(['spawn', 'send']);
    });
});
