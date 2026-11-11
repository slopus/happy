import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { createProjectGoalRuntime } from './projectGoalRuntime';
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
const key = new Uint8Array(32).fill(7);
const encode = (value: unknown) => encodeBase64(encrypt(key, 'legacy', value));
const ready = { role: 'agent', content: { type: 'event', data: { type: 'ready' } } };
const metadata = { host: 'fixture', path: '/archive/feature/tasks/task', machineId: 'machine' };
const row = (id: string, seq: number, meta = metadata) => ({ id, seq, metadata: encode(meta), updatedAt: 1, active: false });
const runtime = () => createProjectGoalRuntime({ serverUrl: 'http://relay.test', token: 'fixture', machineId: 'machine', legacyKey: key,
    findSession: () => ({ encryption: { encryptionKey: key, encryptionVariant: 'legacy', seq: 0, metadataVersion: 0, agentStateVersion: 0 }, pid: 1, startedBy: 'test' }) });
beforeEach(() => { vi.mocked(axios.get).mockReset(); vi.mocked(axios.post).mockReset(); });
describe('production project relay adapter', () => {
    it('includes old tasks beyond the first 150 sessions and excludes another machine/directory', async () => {
        vi.mocked(axios.get).mockImplementation(async (url, config) => {
            if (String(url).endsWith('/v2/sessions')) return { data: config?.params?.cursor
                ? { sessions: [row('old-task', 1), row('blank-chat', 1), row('wrong-machine', 1, { ...metadata, machineId: 'other' })], hasNext: false }
                : { sessions: Array.from({ length: 200 }, (_, i) => row(`unrelated-${i}`, 0, { ...metadata, path: '/elsewhere' })), hasNext: true, nextCursor: 'cursor_v1_old' } };
            const content = String(url).includes('blank-chat') ? ready : { role: 'user', content: { type: 'text', text: 'Execute' } };
            return { data: { messages: [{ seq: 1, content: { t: 'encrypted', c: encode(content) } }] } };
        });
        const history = await runtime().history('/archive/feature', [{ id: 'task', title: 'Task', directory: metadata.path }]);
        expect(history.map(session => [session.sessionId, session.executed])).toEqual([['old-task', true], ['blank-chat', false]]);
        expect(vi.mocked(axios.get).mock.calls.filter(call => String(call[0]).endsWith('/v2/sessions'))).toHaveLength(2);
    });
    it('explicit Goal bindings isolate sibling Tasks and retain a scope binding without a Task id', async () => {
        vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [
            row('sibling', 0, { ...metadata, goalBoard: { featurePath: '/archive/feature', taskId: 'sibling' } } as any),
            row('global', 0, { ...metadata, goalBoard: { featurePath: '/archive/feature' } } as any),
        ], hasNext: false } });
        expect(await runtime().history('/archive/feature', [{ id: 'task', directory: metadata.path }])).toEqual([]);
        expect((await runtime().history('/archive/feature', [{ id: '', directory: metadata.path }])).map(session => session.sessionId)).toEqual(['global']);
    });
    it('a broken pagination cursor cannot be mistaken for complete history', async () => {
        vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [], hasNext: true, nextCursor: 'same' } });
        await expect(runtime().history('/archive/feature', [])).rejects.toThrow('could not be verified');
        expect(axios.get).toHaveBeenCalledTimes(2);
    });
    it('missing transcript sequences cannot establish an empty discussion', async () => {
        vi.mocked(axios.get).mockImplementation(async url => ({ data: String(url).endsWith('/v2/sessions')
            ? { sessions: [row('partial', 2)], hasNext: false }
            : { messages: [{ seq: 2, content: { t: 'encrypted', c: encode(ready) } }, { seq: 2, content: { t: 'encrypted', c: encode(ready) } }] } }));
        expect((await runtime().history('/archive/feature', [{ id: 'task', directory: metadata.path }]))[0].executed).toBe(true);
    });
    it('submits exactly one encrypted user message carrying a stable relay deduplication ID', async () => {
        vi.mocked(axios.post).mockResolvedValue({ data: { messages: [{ localId: 'goal-first:task' }] } });
        await runtime().send('session', 'Read the real task Prompt', 'goal-first:task');
        expect(axios.post).toHaveBeenCalledTimes(1);
        const [url, body] = vi.mocked(axios.post).mock.calls[0];
        expect(url).toBe('http://relay.test/v3/sessions/session/messages');
        const message = (body as any).messages[0];
        expect(message.localId).toBe('goal-first:task');
        expect(decrypt(key, 'legacy', decodeBase64(message.content))).toMatchObject({ role: 'user', content: { text: 'Read the real task Prompt' }, meta: { sentFrom: 'paws-goal-project' } });
    });
});
