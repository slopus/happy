import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalArtifactCache } from './goalBoardArtifacts';
vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC: vi.fn() } }));
const ownership = vi.hoisted(() => ({ generation: 0, current: true, server: 'https://one.test' }));
vi.mock('@/auth/accountRuntime', () => ({ assertAccountRuntime: () => { if (!ownership.current) throw new Error('Account changed'); }, getRuntimeAccountSelection: () => null }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => ownership.server }));
vi.mock('./attachmentCacheContext', () => ({ attachmentCacheGeneration: () => ownership.generation }));
const request = { sessionId: 's1', featurePath: '/goal/f1', taskId: 't1', artifact: { id: 'a1', name: '全文.md', kind: 'text', relation: 'output', available: true, size: 99, modifiedAt: 1 } } as const;
const text = { success: true, kind: 'text', name: '全文.md', revision: 'r1', content: '# Full\n' + 'body\n'.repeat(3000) };
describe('Goal artifact loading', () => {
    let rpc: ReturnType<typeof vi.fn>;
    beforeEach(() => { ownership.generation = 0; ownership.current = true; ownership.server = 'https://one.test'; rpc = vi.fn(async () => text); });
    it('does not read until requested and sends only registered identity, retaining full content', async () => {
        const cache = new GoalArtifactCache(rpc);
        expect(rpc).not.toHaveBeenCalled();
        expect(await cache.open(request)).toEqual(text);
        expect(rpc).toHaveBeenCalledWith('s1', 'goalBoardArtifact', { featurePath: '/goal/f1', taskId: 't1', artifactId: 'a1' });
        await cache.open(request);
        expect(rpc).toHaveBeenCalledTimes(1);
    });
    it('rejects cached reads after the account runtime is frozen', async () => {
        const cache = new GoalArtifactCache(rpc);
        await cache.open(request);
        ownership.current = false;
        await expect(cache.open(request)).rejects.toThrow('Account changed');
    });
    it('does not reuse cached content across server changes', async () => {
        const cache = new GoalArtifactCache(rpc);
        await cache.open(request);
        ownership.server = 'https://two.test';
        await cache.open(request);
        expect(rpc).toHaveBeenCalledTimes(2);
    });
    it('clears cached content on account/attachment ownership invalidation', async () => {
        const cache = new GoalArtifactCache(rpc);
        await cache.open(request);
        ownership.generation += 1;
        await cache.open(request);
        expect(rpc).toHaveBeenCalledTimes(2);
    });
    it('rejects pending content from an expired ownership context', async () => {
        let finish!: (value: unknown) => void;
        rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const cache = new GoalArtifactCache(rpc);
        const pending = cache.open(request);
        ownership.generation += 1; finish(text);
        await expect(pending).rejects.toThrow('context expired');
    });
    it('separates sessions, tasks, features and file versions', async () => {
        const cache = new GoalArtifactCache(rpc);
        await cache.open(request);
        await cache.open({ ...request, sessionId: 's2' });
        await cache.open({ ...request, featurePath: '/goal/f2' });
        await cache.open({ ...request, taskId: 't2' });
        await cache.open({ ...request, artifact: { ...request.artifact, modifiedAt: 2 } });
        expect(rpc).toHaveBeenCalledTimes(5);
    });
    it('evicts least recently used entries within the count bound', async () => {
        const cache = new GoalArtifactCache(rpc, { maxEntries: 2 });
        await cache.open(request);
        await cache.open({ ...request, sessionId: 's2' });
        await cache.open({ ...request, sessionId: 's3' });
        await cache.open(request);
        expect(rpc).toHaveBeenCalledTimes(4);
    });
    it('does not cache beyond the memory budget', async () => {
        const cache = new GoalArtifactCache(rpc, { maxBytes: 100 });
        await cache.open(request); await cache.open(request);
        expect(rpc).toHaveBeenCalledTimes(2);
    });
    it('rejects stale responses and does not cache cancelled reads', async () => {
        let finish!: (value: unknown) => void;
        rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const cache = new GoalArtifactCache(rpc);
        const abort = new AbortController();
        const pending = cache.open(request, abort.signal);
        abort.abort(); finish(text);
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await cache.open(request);
        expect(rpc).toHaveBeenCalledTimes(2);
    });
    it.each([{ success: true, kind: 'text', content: 3 }, { success: true, kind: 'attachment', attachment: { ref: 'x' } }])('rejects malformed response %j', async response => {
        rpc.mockResolvedValue(response);
        await expect(new GoalArtifactCache(rpc).open(request)).rejects.toThrow('Invalid artifact response');
    });
    it('returns explicit backend errors and retries failures', async () => {
        rpc.mockResolvedValue({ success: false, error: 'File is missing' });
        const cache = new GoalArtifactCache(rpc);
        await expect(cache.open(request)).rejects.toThrow('File is missing');
        await expect(cache.open(request)).rejects.toThrow('File is missing');
        expect(rpc).toHaveBeenCalledTimes(2);
    });
    it('rejects oversized UTF-8 text', async () => {
        rpc.mockResolvedValue({ ...text, content: '中'.repeat(1024 * 1024) });
        await expect(new GoalArtifactCache(rpc).open(request)).rejects.toThrow('Artifact exceeds');
    });
    it('rejects unavailable files without issuing an RPC', async () => {
        await expect(new GoalArtifactCache(rpc).open({ ...request, artifact: { ...request.artifact, available: false } })).rejects.toThrow('unavailable');
        expect(rpc).not.toHaveBeenCalled();
    });
    it('loads a large text attachment outside RPC and caches its complete original', async () => {
        const content = '<!doctype html><h1>原始报告</h1>' + 'x'.repeat(4704647);
        const attachment = { ref: 'private/report', name: 'report.html', kind: 'file', size: new TextEncoder().encode(content).length, mimeType: 'text/html', encrypted: true };
        rpc.mockResolvedValue({ success: true, kind: 'attachment', attachment });
        const readText = vi.fn(async () => content);
        const cache = new GoalArtifactCache(rpc, { maxBytes: 16 * 1024 * 1024 }, readText);
        const result = await cache.open(request);
        expect(result.kind).toBe('text');
        if (result.kind !== 'text') throw new Error('Expected original text');
        expect(result.name).toBe('report.html');
        expect(result.content === content).toBe(true);
        await cache.open(request);
        expect(rpc).toHaveBeenCalledTimes(1);
        expect(readText).toHaveBeenCalledWith('s1', attachment, undefined);
    });
    it('rejects a late text attachment after account ownership changes', async () => {
        rpc.mockResolvedValue({ success: true, kind: 'attachment', attachment: { ref: 'private/report', name: 'report.html', kind: 'file', size: 50, mimeType: 'text/html', encrypted: true } });
        let finish!: (value: string) => void;
        const readText = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
        const pending = new GoalArtifactCache(rpc, {}, readText).open(request);
        await vi.waitFor(() => expect(readText).toHaveBeenCalledTimes(1));
        ownership.generation += 1;
        finish('STALE REPORT');
        await expect(pending).rejects.toThrow('context expired');
    });
    it.each(['image', 'audio', 'video', 'file'])('retains valid %s attachment metadata', async kind => {
        const response = { success: true, kind: 'attachment', attachment: { ref: 'private/ref', name: 'original', size: 100, mimeType: 'application/pdf', kind, encrypted: true } };
        rpc.mockResolvedValue(response);
        expect(await new GoalArtifactCache(rpc).open({ ...request, artifact: { ...request.artifact, kind: kind === 'file' ? 'pdf' : kind as 'image' | 'audio' | 'video' } })).toEqual(response);
    });
});
