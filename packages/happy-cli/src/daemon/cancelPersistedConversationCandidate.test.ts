import { describe, expect, it, vi, type MockInstance } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encrypt, decrypt, decodeBase64, encodeBase64 } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import type { TrackedSession } from './types';
import type { ConversationLaunchSnapshot } from './conversationSessionLaunch';
import { cancelPersistedConversationCandidate } from './cancelPersistedConversationCandidate';
import { verifyNativeProcessGroup, awaitNativeProcessGroupExit } from './nativeProcessGroup';

function fixture() {
    const metadata: Metadata = { machineId: 'machine', path: '/project', flavor: 'antigravity', hostPid: 4001,
        host: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happy', happyLibDir: '/lib', happyToolsDir: '/tools',
        parentSessionId: 'source', crossAgentRequestId: 'request' };
    const owner: ConversationLaunchSnapshot = { id: 'target', metadata: { ...metadata }, active: true, seq: 0,
        agentState: { turnStatus: { status: 'completed', updatedAt: 1 } } };
    const retained: TrackedSession = { startedBy: 'persisted', pid: 0, happySessionId: owner.id,
        happySessionMetadataFromLocalWebhook: { ...metadata }, encryption: { encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'dataKey', seq: 0, metadataVersion: 1, agentStateVersion: 1 } };
    let reservation = true;
    let userInput = false;
    const verify = vi.fn(async () => {
        if (!reservation) throw new Error('reservation changed');
        if (userInput) throw new Error('user delivery found');
        return owner;
    });
    const callSessionRpc = vi.fn(async (_id: string, _encryption: unknown, method: string) => method === 'delegation-context'
        ? { agent: 'antigravity', hostPid: 4001 } : { success: true });
    const verifyProcessGroup = vi.fn(async () => true);
    const awaitProcessGroupExit = vi.fn(async () => {});
    const input = { owner, machineId: 'machine', retained: () => retained, verify, callSessionRpc, verifyProcessGroup, awaitProcessGroupExit };
    return { input, owner, retained, verify, callSessionRpc, verifyProcessGroup, awaitProcessGroupExit,
        cancelReservation: () => { reservation = false; }, deliverInput: () => { userInput = true; } };
}

describe('persisted live conversation candidate cancellation', () => {
    it('reopens a persisted identity and stops its real isolated fixture worker through encrypted RPC only', async () => {
        const directory = await fs.mkdtemp(join(tmpdir(), 'persisted-candidate-test-'));
        const script = join(directory, 'worker.mjs');
        await fs.writeFile(script, `import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
const key = Buffer.from(process.env.FIXTURE_WORKER_KEY, 'base64');
const encode = data => { const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce);
 const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
 return Buffer.concat([Buffer.from([0]), nonce, encrypted, cipher.getAuthTag()]).toString('base64'); };
process.on('message', message => { try {
 const bytes = Buffer.from(message.params, 'base64'); const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1,13));
 decipher.setAuthTag(bytes.subarray(-16)); JSON.parse(Buffer.concat([decipher.update(bytes.subarray(13,-16)), decipher.final()]).toString());
 const result = message.method === 'delegation-context' ? {agent:'antigravity',hostPid:process.pid} : {success:true};
 process.send({result:encode(result)}, () => { if(message.method === 'killSession') process.exit(0); });
 } catch { process.send({error:'request authentication failed'}); } });
process.send({ready:true,pid:process.pid});\n`);
        const f = fixture();
        const child = spawn(process.execPath, [script], { cwd: directory, detached: true,
            env: { ...process.env, FIXTURE_WORKER_KEY: encodeBase64(f.retained.encryption!.encryptionKey) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        const exited = once(child, 'exit');
        let probe: MockInstance<typeof process.kill> | undefined;
        try {
            const [ready] = await once(child, 'message') as [{ ready: boolean; pid: number }];
            expect(ready.ready).toBe(true);
            f.retained.happySessionMetadataFromLocalWebhook!.hostPid = f.owner.metadata.hostPid = ready.pid;
            f.retained.happySessionMetadataFromLocalWebhook!.path = f.owner.metadata.path = directory;
            const registry = join(directory, 'sessions.json');
            await fs.writeFile(registry, JSON.stringify({ sessionId: f.owner.id, metadata: f.retained.happySessionMetadataFromLocalWebhook,
                encryption: { ...f.retained.encryption, encryptionKey: encodeBase64(f.retained.encryption!.encryptionKey) } }), { mode: 0o600 });
            const saved = JSON.parse(await fs.readFile(registry, 'utf8'));
            const reopened: TrackedSession = { startedBy: 'persisted', pid: 0, happySessionId: saved.sessionId,
                happySessionMetadataFromLocalWebhook: saved.metadata, encryption: { ...saved.encryption, encryptionKey: decodeBase64(saved.encryption.encryptionKey) } };
            const methods: string[] = [];
            probe = vi.spyOn(process, 'kill');
            await cancelPersistedConversationCandidate({ ...f.input, retained: () => reopened,
                verifyProcessGroup: verifyNativeProcessGroup, awaitProcessGroupExit: awaitNativeProcessGroupExit,
                callSessionRpc: async (_sessionId, encryption, method, body) => {
                    methods.push(method);
                    const response = once(child, 'message') as Promise<[{ result: string }]>;
                    child.send({ method, params: encodeBase64(encrypt(encryption.encryptionKey, encryption.encryptionVariant, body)) });
                    const [wire] = await response;
                    return decrypt(encryption.encryptionKey, encryption.encryptionVariant, decodeBase64(wire.result));
                } });
            await exited;
            expect(methods).toEqual(['delegation-context', 'killSession']);
            expect(probe.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
        } finally {
            probe?.mockRestore();
            if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
            await fs.rm(directory, { recursive: true, force: true });
        }
    }, 10_000);

    it('uses the retained key to attest the worker and asks it to exit only after repeated fresh proof', async () => {
        const f = fixture(); await cancelPersistedConversationCandidate(f.input);
        expect(f.callSessionRpc.mock.calls.map(([, , method]) => method)).toEqual(['delegation-context', 'killSession']);
        expect(f.verify).toHaveBeenCalledTimes(3);
        expect(f.verifyProcessGroup).toHaveBeenCalledExactlyOnceWith(4001);
        expect(f.awaitProcessGroupExit).toHaveBeenCalledExactlyOnceWith(4001);
        expect(f.retained.startedBy).toBe('persisted'); expect(f.retained.pid).toBe(0); expect(f.retained.childProcess).toBeUndefined();
    });

    it.each(['pid', 'agent', 'machine', 'path', 'request', 'key-length', 'claude'])('rejects a retained %s mismatch before a kill request', async field => {
        const f = fixture();
        if (field === 'pid') f.owner.metadata.hostPid = 4999;
        if (field === 'agent') f.owner.metadata.flavor = 'codex';
        if (field === 'machine') f.owner.metadata.machineId = 'other';
        if (field === 'path') f.owner.metadata.path = '/other';
        if (field === 'request') f.owner.metadata.crossAgentRequestId = 'other';
        if (field === 'key-length') f.retained.encryption!.encryptionKey = new Uint8Array(31);
        if (field === 'claude') f.retained.happySessionMetadataFromLocalWebhook!.flavor = f.owner.metadata.flavor = 'claude';
        await expect(cancelPersistedConversationCandidate(f.input)).rejects.toThrow();
        expect(f.callSessionRpc.mock.calls.some(([, , method]) => method === 'killSession')).toBe(false);
        expect(f.awaitProcessGroupExit).not.toHaveBeenCalled();
    });

    it.each(['wrong-pid', 'wrong-agent', 'missing-rpc', 'missing-ack', 'lost-ack', 'lingering-group', 'unknown-group'])('keeps %s cancellation unconfirmed', async failure => {
        const f = fixture();
        if (failure === 'wrong-pid') f.callSessionRpc.mockResolvedValueOnce({ agent: 'antigravity', hostPid: 4999 });
        if (failure === 'wrong-agent') f.callSessionRpc.mockResolvedValueOnce({ agent: 'codex', hostPid: 4001 });
        if (failure === 'missing-rpc') f.callSessionRpc.mockRejectedValueOnce(new Error('Method not found'));
        if (failure === 'missing-ack') f.callSessionRpc.mockImplementation(async (_id, _key, method) => method === 'delegation-context'
            ? { agent: 'antigravity', hostPid: 4001 } : { success: false });
        if (failure === 'lost-ack') f.callSessionRpc.mockImplementation(async (_id, _key, method) => {
            if (method === 'killSession') throw new Error('acknowledgement lost');
            return { agent: 'antigravity', hostPid: 4001 };
        });
        if (failure === 'lingering-group') f.awaitProcessGroupExit.mockRejectedValueOnce(new Error('group remains'));
        if (failure === 'unknown-group') f.verifyProcessGroup.mockResolvedValueOnce(false);
        await expect(cancelPersistedConversationCandidate(f.input)).rejects.toThrow();
        if (failure !== 'missing-ack' && failure !== 'lost-ack' && failure !== 'lingering-group') {
            expect(f.callSessionRpc.mock.calls.some(([, , method]) => method === 'killSession')).toBe(false);
        }
    });

    it.each(['key', 'owner', 'input', 'reservation'])('rechecks %s after encrypted identity and before any kill', async race => {
        const f = fixture();
        f.callSessionRpc.mockImplementationOnce(async () => {
            if (race === 'key') f.retained.encryption!.encryptionKey = new Uint8Array(32).fill(8);
            if (race === 'owner') f.owner.metadata.hostPid = 4999;
            if (race === 'input') f.deliverInput();
            if (race === 'reservation') f.cancelReservation();
            return { agent: 'antigravity', hostPid: 4001 };
        });
        await expect(cancelPersistedConversationCandidate(f.input)).rejects.toThrow();
        expect(f.callSessionRpc).toHaveBeenCalledTimes(1);
        expect(f.verifyProcessGroup).not.toHaveBeenCalled();
    });

    it('rechecks complete input and reservation proof after asynchronous process inspection', async () => {
        const f = fixture();
        f.verifyProcessGroup.mockImplementationOnce(async () => { f.deliverInput(); return true; });
        await expect(cancelPersistedConversationCandidate(f.input)).rejects.toThrow('user delivery');
        expect(f.callSessionRpc).toHaveBeenCalledTimes(1);
        expect(f.awaitProcessGroupExit).not.toHaveBeenCalled();
    });
});
