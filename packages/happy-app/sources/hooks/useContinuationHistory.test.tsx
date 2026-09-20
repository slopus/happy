import * as React from 'react';
import { act } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { useContinuationHistory } from './useContinuationHistory';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { ensureSessionHydratedWithRetry } from '@/sync/ensureSessionHydratedWithRetry';

vi.mock('@/sync/storage', async () => ({ storage: (await import('zustand')).create(() => ({ sessions: {}, sessionMessages: {} })) }));
vi.mock('@/sync/sync', () => ({ sync: {
    ensureMessagesLoaded: vi.fn().mockResolvedValue(undefined), loadOlderMessages: vi.fn().mockResolvedValue(undefined),
    loadNewerMessages: vi.fn().mockResolvedValue(undefined), jumpToLatestMessages: vi.fn().mockResolvedValue(undefined),
    getHistoryBoundarySeq: vi.fn().mockReturnValue(1), checkSessionExists: vi.fn().mockResolvedValue(true),
} }));
vi.mock('@/sync/ensureSessionHydratedWithRetry', () => ({ ensureSessionHydratedWithRetry: vi.fn().mockResolvedValue(true) }));
vi.mock('@/auth/accountRuntime', () => ({ accountRuntimeCurrent: () => true }));
vi.mock('@/components/tools/knownTools', () => ({ knownTools: {} }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
const store = storage as any;
const page = (overrides = {}) => ({ messages: [], isLoaded: true, hasMoreOlder: false, hasMoreNewer: false, isAtLatest: true, ...overrides });
function setWindow(id: string, changes: any) {
    store.setState((state: any) => ({ sessionMessages: { ...state.sessionMessages, [id]: { ...state.sessionMessages[id], ...changes } } }));
}
function seed(parents: Record<string, string | undefined>, windows: Record<string, any> = {}) {
    store.setState({ sessions: Object.fromEntries(Object.entries(parents).map(([id, parent]) => [id, { id, metadata: { continuationOfSessionId: parent } }])),
        sessionMessages: Object.fromEntries(Object.keys(parents).map(id => [id, page(windows[id])])) });
}
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
}
let latest: ReturnType<typeof useContinuationHistory>;
let renders: string[][];
function Probe({ id }: { id: string }) {
    latest = useContinuationHistory(id);
    renders.push(latest.sections.map(section => section.id));
    return null;
}
let renderer: any;
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.mocked(sync.checkSessionExists).mockResolvedValue(true);
    vi.mocked(ensureSessionHydratedWithRetry).mockResolvedValue(true);
    vi.mocked(sync.ensureMessagesLoaded).mockResolvedValue(undefined);
    vi.mocked(sync.loadOlderMessages).mockResolvedValue(undefined);
    vi.mocked(sync.loadNewerMessages).mockResolvedValue(undefined);
    vi.mocked(sync.jumpToLatestMessages).mockResolvedValue(undefined);
    renders = []; renderer = null;
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { if (renderer) act(() => renderer.unmount()); consoleError.mockRestore(); });
async function mount(id = 'new') { await act(async () => { renderer = TestRenderer.create(<Probe id={id} />); }); }

it('automatically hydrates parent history without copying messages', async () => {
    const message = { id: 'old-message', kind: 'user-text', text: 'original' };
    seed({ new: 'old', old: undefined }, { old: { messages: [message] } });
    await mount();
    expect(ensureSessionHydratedWithRetry).toHaveBeenCalledWith('old', expect.any(Function));
    expect(sync.ensureMessagesLoaded).toHaveBeenCalledWith('old');
    expect(latest.sections.map(s => s.id)).toEqual(['new', 'old']);
    expect(latest.sections[1].messages[0]).toBe(message);
    expect(store.getState().sessionMessages.new.messages).toEqual([]);
});

it('exhausts each session before loading an older ancestor across multiple continuations', async () => {
    seed({ new: 'middle', middle: 'old', old: undefined }, { middle: { hasMoreOlder: true } });
    await mount();
    await act(async () => latest.loadOlder());
    expect(sync.loadOlderMessages).toHaveBeenCalledWith('middle', undefined);
    expect(ensureSessionHydratedWithRetry).not.toHaveBeenCalledWith('old', expect.any(Function));
    act(() => setWindow('middle', { hasMoreOlder: false }));
    await act(async () => latest.loadOlder());
    expect(latest.sections.map(s => s.id)).toEqual(['new', 'middle', 'old']);
    expect(latest.hasMoreOlder).toBe(false);
});

it('hides the newer sessions while an old window has an unloaded tail, then reconnects after paging newer', async () => {
    seed({ new: 'old', old: undefined }, { old: { hasMoreOlder: true } });
    await mount();
    act(() => setWindow('old', { hasMoreNewer: true, isAtLatest: false }));
    expect(latest.sections.map(s => s.id)).toEqual(['old']);
    expect(latest.hasMoreNewer).toBe(true);
    vi.mocked(sync.loadNewerMessages).mockImplementation(async id => { setWindow(id, { hasMoreNewer: false, isAtLatest: true }); });
    await act(async () => latest.loadNewer());
    expect(sync.loadNewerMessages).toHaveBeenCalledWith('old', undefined);
    expect(latest.sections.map(s => s.id)).toEqual(['new', 'old']);
});

it('seeks to the latest parent window before joining it to the new conversation', async () => {
    seed({ new: 'old', old: undefined }, { old: { hasMoreNewer: true, isAtLatest: false } });
    vi.mocked(sync.jumpToLatestMessages).mockImplementation(async id => { setWindow(id, { hasMoreNewer: false, isAtLatest: true }); });
    await mount();
    expect(sync.jumpToLatestMessages).toHaveBeenCalledWith('old');
    expect(latest.sections.map(s => s.id)).toEqual(['new', 'old']);
});

it('reports missing parents and cycles explicitly', async () => {
    seed({ new: 'missing' });
    vi.mocked(ensureSessionHydratedWithRetry).mockResolvedValue(false);
    await mount();
    expect(latest.olderError).toBe('session.continueHistoryError');
    expect(latest.sections.map(s => s.id)).toEqual(['new']);
    act(() => renderer.unmount()); renderer = null;
    vi.mocked(ensureSessionHydratedWithRetry).mockResolvedValue(true);
    seed({ new: 'old', old: 'new' });
    await mount();
    await act(async () => latest.loadOlder());
    expect(latest.olderError).toBe('session.continueCycle');
    expect(latest.sections.map(s => s.id)).toEqual(['new', 'old']);
});

it('does not publish parent state after unmount or keep loading its messages', async () => {
    seed({ new: 'old', old: undefined });
    const pending = deferred();
    vi.mocked(ensureSessionHydratedWithRetry).mockImplementation(async () => { await pending.promise; return true; });
    await mount();
    act(() => renderer.unmount()); renderer = null;
    const count = renders.length;
    await act(async () => pending.resolve());
    expect(renders).toHaveLength(count);
    expect(sync.ensureMessagesLoaded).not.toHaveBeenCalled();
});

it('does not lose automatic parent loading when the initial page becomes loaded during a busy operation', async () => {
    seed({ new: 'old', old: undefined }, { new: { isLoaded: false } });
    const pending = deferred();
    vi.mocked(sync.ensureMessagesLoaded).mockImplementation(async id => { if (id === 'new') await pending.promise; });
    await mount();
    let loading!: Promise<void>;
    act(() => { loading = latest.loadOlder(); });
    act(() => setWindow('new', { isLoaded: true }));
    await act(async () => { pending.resolve(); await loading; });
    expect(latest.sections.map(s => s.id)).toEqual(['new', 'old']);
    expect(latest.loading).toBe(false);
});

it('allows the new route to load even while an old route request is still pending', async () => {
    seed({ new: 'old', old: undefined, other: 'ancestor', ancestor: undefined });
    const pending = deferred();
    vi.mocked(ensureSessionHydratedWithRetry).mockImplementation(async id => { if (id === 'old') await pending.promise; return true; });
    await mount();
    await act(async () => renderer.update(<Probe id="other" />));
    expect(latest.sections.map(s => s.id)).toEqual(['other', 'ancestor']);
    await act(async () => pending.resolve());
    expect(latest.sections.map(s => s.id)).toEqual(['other', 'ancestor']);
    expect(latest.loading).toBe(false);
});

it('passes the current source viewport through boundary paging', async () => {
    seed({ new: 'old', old: undefined }, { old: { hasMoreOlder: true } });
    await mount();
    const viewport = vi.fn();
    await act(async () => latest.loadOlder(viewport));
    expect(sync.loadOlderMessages).toHaveBeenCalledWith('old', viewport);
    act(() => setWindow('old', { hasMoreNewer: true }));
    await act(async () => latest.loadNewer(viewport));
    expect(sync.loadNewerMessages).toHaveBeenCalledWith('old', viewport);
});

it('does not silently join an unreadable parent whose sync completed without loading messages', async () => {
    seed({ new: 'old', old: undefined }, { old: { isLoaded: false } });
    await mount();
    expect(latest.olderError).toBe('session.continueHistoryError');
    expect(latest.sections.map(s => s.id)).toEqual(['new']);
});

it('stops retrying a parent confirmed unavailable by the server', async () => {
    seed({ new: 'missing' });
    vi.mocked(ensureSessionHydratedWithRetry).mockResolvedValue(false);
    vi.mocked(sync.checkSessionExists).mockResolvedValue(false);
    await mount();
    expect(latest.olderError).toBe('session.continueHistoryUnavailable');
    expect(latest.olderRetryable).toBe(false);
});
it('keeps failed availability probes retryable', async () => {
    seed({ new: 'missing' });
    vi.mocked(ensureSessionHydratedWithRetry).mockResolvedValue(false);
    vi.mocked(sync.checkSessionExists).mockRejectedValue(new Error('offline'));
    await mount();
    expect(latest.olderError).toBe('session.continueHistoryError');
    expect(latest.olderRetryable).toBe(true);
});
it('keeps transient hydration failures retryable and recovers after retry', async () => {
    seed({ new: 'old', old: undefined });
    vi.mocked(ensureSessionHydratedWithRetry).mockResolvedValueOnce(false);
    await mount();
    expect(latest.olderRetryable).toBe(true);
    await act(async () => latest.loadOlder());
    expect(latest.olderError).toBeNull();
    expect(latest.sections.map(s => s.id)).toEqual(['new', 'old']);
});

it('confirms server absence when message sync finishes without a readable parent', async () => {
    seed({ new: 'old', old: undefined }, { old: { isLoaded: false } });
    vi.mocked(sync.checkSessionExists).mockResolvedValue(false);
    await mount();
    expect(latest.olderError).toBe('session.continueHistoryUnavailable');
    expect(latest.olderRetryable).toBe(false);
});
