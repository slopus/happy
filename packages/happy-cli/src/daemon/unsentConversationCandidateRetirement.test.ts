import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { decrypt, encrypt, decodeBase64, encodeBase64 } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import type { ConversationLaunchSnapshot } from './conversationSessionLaunch';
import type { TrackedSession } from './types';
import { retireUnsentConversationCandidate } from './unsentConversationCandidateRetirement';
import { NativeProcessTreeIdentityError, captureNativeProcessTree, awaitNativeProcessTreeExit } from './nativeProcessTree';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture(persisted = false) {
    const directory = await mkdtemp(join(tmpdir(), 'unsent-retirement-')); directories.push(directory); await chmod(directory, 0o700);
    const metadata: Metadata = { machineId: 'machine', path: '/project', flavor: 'codex', hostPid: 4001,
        host: 'fixture', homeDir: '/home', happyHomeDir: '/home/.happy', happyLibDir: '/lib', happyToolsDir: '/tools',
        parentSessionId: 'source', crossAgentRequestId: '00000000-0000-4000-8000-000000000001' };
    const owner: ConversationLaunchSnapshot = { id: 'target', metadata: { ...metadata }, active: true, seq: 0,
        agentState: { turnStatus: { status: 'completed', updatedAt: 1 } } };
    const retained: TrackedSession = { startedBy: persisted ? 'persisted' : 'daemon', pid: persisted ? 0 : 4001,
        ...(!persisted ? { childProcess: { pid: 4001 } as TrackedSession['childProcess'] } : {}), happySessionId: 'target',
        happySessionMetadataFromLocalWebhook: { ...metadata }, encryption: { encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'dataKey', seq: 0, metadataVersion: 1, agentStateVersion: 1 } };
    let user = false; let reservation = true;
    const verify = vi.fn(async () => { if (user) throw new Error('User delivery found'); if (!reservation) throw new Error('Reservation changed'); return owner; });
    const tree = { rootPid: 4001, processes: [{ pid: 4001, ppid: 99, pgid: 4001, startedAt: 'Sun Nov 29 01:00:00 2026' },
        { pid: 4002, ppid: 4001, pgid: 4002, startedAt: 'Sun Nov 29 01:00:01 2026' }] };
    const captureProcessTree = vi.fn(async () => structuredClone(tree));
    const awaitProcessTreeExit = vi.fn(async () => {});
    const callSessionRpc = vi.fn(async (_id: string, _key: unknown, method: string) => method === 'delegation-context'
        ? { agent: 'codex', hostPid: 4001 } : { success: true });
    const binding = { rootSessionId: 'root', sourceSessionId: 'source', requestId: metadata.crossAgentRequestId!,
        phase: 'ready' as const, targetSessionId: 'target', targetAgent: 'codex' as const };
    const input = { directory, binding, owner, machineId: 'machine', retained: () => retained, verify,
        callSessionRpc, captureProcessTree, awaitProcessTreeExit };
    return { input, tree, owner, retained, verify, captureProcessTree, awaitProcessTreeExit, callSessionRpc,
        path: join(directory, `${binding.requestId}.json`), deliver: () => { user = true; }, changeReservation: () => { reservation = false; } };
}
describe('proven unsent candidate retirement', () => {
    it('closes a real private fixture through encrypted RPC and observes its separate-PGID sidecar exit without signalling it', async () => {
        const f = await fixture(); const script = join(f.input.directory, 'fixture-worker.mjs');
        await writeFile(script, `import {spawn} from 'node:child_process';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
const key=Buffer.from(process.env.FIXTURE_WORKER_KEY,'base64');
const encode=data=>{const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
return Buffer.concat([Buffer.from([0]),nonce,cipher.update(JSON.stringify(data)),cipher.final(),cipher.getAuthTag()]).toString('base64');};
const sidecar=spawn(process.execPath,['-e',"process.stdin.resume();process.stdin.once('end',()=>process.exit(0));console.log('ready')"],{detached:true,stdio:['pipe','pipe','ignore']});
sidecar.stdout.once('data',()=>process.send({ready:true,pid:process.pid,sidecarPid:sidecar.pid}));
sidecar.once('exit',()=>process.exit(0));process.on('disconnect',()=>sidecar.stdin.end());
process.on('message',message=>{try{const b=Buffer.from(message.params,'base64'),d=createDecipheriv('aes-256-gcm',key,b.subarray(1,13));
d.setAuthTag(b.subarray(-16));JSON.parse(Buffer.concat([d.update(b.subarray(13,-16)),d.final()]).toString());
process.send({result:encode(message.method==='delegation-context'?{agent:'codex',hostPid:process.pid}:{success:true})},()=>{if(message.method==='killSession')sidecar.stdin.end();});
}catch{process.send({error:'fixture authentication failed'});}});\n`);
        const child = spawn(process.execPath, [script], { cwd: f.input.directory, detached: true,
            env: { ...process.env, FIXTURE_WORKER_KEY: encodeBase64(f.retained.encryption!.encryptionKey) },
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        const exited = once(child, 'exit');
        try {
            const [ready] = await once(child, 'message') as [{ pid: number; sidecarPid: number }];
            f.owner.metadata.hostPid = f.retained.happySessionMetadataFromLocalWebhook!.hostPid = ready.pid;
            f.owner.metadata.path = f.retained.happySessionMetadataFromLocalWebhook!.path = f.input.directory;
            f.retained.pid = ready.pid; f.retained.childProcess = child;
            const methods: string[] = []; const probe = vi.spyOn(process, 'kill');
            try {
                await retireUnsentConversationCandidate({ ...f.input, captureProcessTree: captureNativeProcessTree,
                    awaitProcessTreeExit: awaitNativeProcessTreeExit,
                    callSessionRpc: async (_id, encryption, method, body) => {
                        methods.push(method); const response = once(child, 'message') as Promise<[{ result: string }]>;
                        child.send({ method, params: encodeBase64(encrypt(encryption.encryptionKey, encryption.encryptionVariant, body)) });
                        const [wire] = await response; return decrypt(encryption.encryptionKey, encryption.encryptionVariant, decodeBase64(wire.result));
                    } });
                await exited;
                const proof = JSON.parse(await readFile(f.path, 'utf8'));
                expect(proof.payload.tree.processes).toContainEqual(expect.objectContaining({ pid: ready.sidecarPid, pgid: ready.sidecarPid }));
                expect(methods).toEqual(['delegation-context', 'killSession']);
                expect(probe.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
            } finally { probe.mockRestore(); }
        } finally {
            if (child.connected) child.disconnect();
            await exited;
        }
    }, 10000);
    it.each([false, true])('retires tracked/persisted=%s through encrypted ownership and recorded lifetimes, without a PGID signal', async persisted => {
        const f = await fixture(persisted); await retireUnsentConversationCandidate(f.input);
        expect(f.callSessionRpc.mock.calls.map(([, , method]) => method)).toEqual(['delegation-context', 'killSession']);
        expect(f.awaitProcessTreeExit).toHaveBeenCalledWith(f.tree);
        const proof = JSON.parse(await readFile(f.path, 'utf8'));
        expect(proof.payload.phase).toBe('exited'); expect(proof.payload.tree.processes).toHaveLength(2);
        expect(JSON.stringify(proof)).not.toContain(Buffer.from(f.retained.encryption!.encryptionKey).toString('base64'));
    });
    it('durably records the exact captured lifetimes before the single stop request', async () => {
        const f = await fixture();
        f.callSessionRpc.mockImplementation(async (_id, _key, method) => {
            if (method === 'delegation-context') return { agent: 'codex', hostPid: 4001 };
            const proof = JSON.parse(await readFile(f.path, 'utf8'));
            expect(proof.payload.phase).toBe('stop-requested'); expect(proof.payload.tree).toEqual(f.tree);
            expect((await stat(f.path)).mode & 0o777).toBe(0o600);
            return { success: true };
        });
        await retireUnsentConversationCandidate(f.input);
    });
    it.each(['unready', 'runtime-pid', 'runtime-agent', 'unavailable-runtime', 'parent'])('refuses %s authority before any stop', async failure => {
        const f = await fixture();
        if (failure === 'unready') (f.input.binding as { phase: string }).phase = 'starting';
        if (failure === 'parent') f.owner.metadata.parentSessionId = f.retained.happySessionMetadataFromLocalWebhook!.parentSessionId = 'foreign';
        if (failure === 'runtime-pid') f.callSessionRpc.mockResolvedValueOnce({ agent: 'codex', hostPid: 9001 });
        if (failure === 'runtime-agent') f.callSessionRpc.mockResolvedValueOnce({ agent: 'antigravity', hostPid: 4001 });
        if (failure === 'unavailable-runtime') f.callSessionRpc.mockRejectedValueOnce(new Error('Encrypted runtime unavailable'));
        await expect(retireUnsentConversationCandidate(f.input)).rejects.toThrow();
        expect(f.callSessionRpc.mock.calls.some(([, , method]) => method === 'killSession')).toBe(false);
        expect(f.captureProcessTree).not.toHaveBeenCalled();
    });
    it('rechecks input after the final asynchronous process inspection before sending stop', async () => {
        const f = await fixture(); let reads = 0;
        f.captureProcessTree.mockImplementation(async () => { if (++reads === 3) f.deliver(); return structuredClone(f.tree); });
        await expect(retireUnsentConversationCandidate(f.input)).rejects.toThrow('User delivery');
        expect(f.callSessionRpc.mock.calls.map(([, , method]) => method)).toEqual(['delegation-context']);
    });
    it.each(['key', 'variant', 'host', 'path', 'account', 'input', 'reservation', 'binding'] as const)('rejects changed %s after native identity before shutdown', async race => {
        const f = await fixture();
        f.callSessionRpc.mockImplementationOnce(async () => {
            if (race === 'key') f.retained.encryption!.encryptionKey = new Uint8Array(32).fill(8);
            if (race === 'variant') f.retained.encryption!.encryptionVariant = 'legacy';
            if (race === 'host') f.owner.metadata.hostPid = 9001;
            if (race === 'path') f.owner.metadata.path = '/other';
            if (race === 'account') f.owner.metadata.codexAccountProfileId = 'other';
            if (race === 'binding') f.owner.metadata.crossAgentRequestId = 'other';
            if (race === 'input') f.deliver(); if (race === 'reservation') f.changeReservation();
            return { agent: 'codex', hostPid: 4001 };
        });
        await expect(retireUnsentConversationCandidate(f.input)).rejects.toThrow();
        expect(f.callSessionRpc.mock.calls.map(([, , method]) => method)).toEqual(['delegation-context']);
        expect(f.awaitProcessTreeExit).not.toHaveBeenCalled();
    });
    it.each(['child', 'birth', 'parent', 'group'] as const)('does not seek a stable subtree or kill when %s changes before effect', async changed => {
        const f = await fixture();
        f.captureProcessTree.mockImplementationOnce(async () => structuredClone(f.tree));
        f.captureProcessTree.mockImplementationOnce(async () => {
            const tree = structuredClone(f.tree);
            if (changed === 'child') tree.processes.push({ pid: 4003, ppid: 4002, pgid: 4003, startedAt: 'Sun Nov 29 01:00:02 2026' });
            if (changed === 'birth') tree.processes[1].startedAt = 'Sun Nov 29 01:00:03 2026';
            if (changed === 'parent') tree.processes[1].ppid = 1;
            if (changed === 'group') tree.processes[1].pgid = 4001;
            return tree;
        });
        await expect(retireUnsentConversationCandidate(f.input)).rejects.toThrow(/subtree changed/);
        expect(f.captureProcessTree).toHaveBeenCalledTimes(2);
        expect(f.callSessionRpc.mock.calls.some(([, , method]) => method === 'killSession')).toBe(false);
    });
    it.each(['ack', 'exit'] as const)('recovers observation after lost %s and daemon restart without a second stop', async failure => {
        const f = await fixture();
        if (failure === 'ack') f.callSessionRpc.mockImplementation(async (_id, _key, method) => {
            if (method === 'killSession') throw new Error('ACK lost'); return { agent: 'codex', hostPid: 4001 };
        });
        else f.awaitProcessTreeExit.mockRejectedValueOnce(new Error('Captured sidecar remains alive'));
        await expect(retireUnsentConversationCandidate(f.input)).rejects.toThrow();
        f.retained.startedBy = 'persisted'; f.retained.pid = 0; f.retained.childProcess = undefined;
        f.callSessionRpc.mockClear(); f.captureProcessTree.mockClear();
        await retireUnsentConversationCandidate(f.input);
        expect(f.callSessionRpc).not.toHaveBeenCalled(); expect(f.captureProcessTree).not.toHaveBeenCalled();
        expect(JSON.parse(await readFile(f.path, 'utf8')).payload.phase).toBe('exited');
    });
    it.each(['signature', 'key', 'permissions', 'symlink'] as const)('refuses a corrupted or unsafe %s proof before any further effect', async failure => {
        const f = await fixture(); f.awaitProcessTreeExit.mockRejectedValueOnce(new Error('sidecar alive'));
        await expect(retireUnsentConversationCandidate(f.input)).rejects.toThrow();
        if (failure === 'signature') { const proof = JSON.parse(await readFile(f.path, 'utf8')); proof.payload.tree.processes = []; await writeFile(f.path, JSON.stringify(proof)); }
        if (failure === 'key') f.retained.encryption!.encryptionKey = new Uint8Array(32).fill(8);
        if (failure === 'permissions') await chmod(f.path, 0o644);
        if (failure === 'symlink') { await rm(f.path); await symlink('/nonexistent-proof', f.path); }
        f.callSessionRpc.mockClear(); f.captureProcessTree.mockClear();
        await expect(retireUnsentConversationCandidate(f.input)).rejects.toThrow();
        expect(f.callSessionRpc).not.toHaveBeenCalled(); expect(f.captureProcessTree).not.toHaveBeenCalled();
    });
    it('keeps a recorded late-input retirement pending instead of confirming cancellation', async () => {
        const f = await fixture(); f.awaitProcessTreeExit.mockImplementationOnce(async () => { f.deliver(); });
        await expect(retireUnsentConversationCandidate(f.input)).rejects.toThrow('User delivery');
        expect(JSON.parse(await readFile(f.path, 'utf8')).payload.phase).toBe('acknowledged');
    });
    it('durably preserves a newly observed descendant and refuses to forget it after restart', async () => {
        const f = await fixture();
        const observed = [{ pid: 4003, ppid: 4002, pgid: 4003, startedAt: 'Sun Nov 29 01:00:03 2026' }];
        f.awaitProcessTreeExit.mockRejectedValueOnce(new NativeProcessTreeIdentityError('new-descendant', observed));
        await expect(retireUnsentConversationCandidate(f.input)).rejects.toThrow(/descendant/);
        const proof = JSON.parse(await readFile(f.path, 'utf8'));
        expect(proof.payload.phase).toBe('unconfirmed'); expect(proof.payload.unconfirmed.observed).toEqual(observed);
        f.retained.startedBy = 'persisted'; f.retained.pid = 0; f.retained.childProcess = undefined;
        f.callSessionRpc.mockClear(); f.awaitProcessTreeExit.mockClear();
        await expect(retireUnsentConversationCandidate(f.input)).rejects.toThrow(/remains unconfirmed/);
        expect(f.callSessionRpc).not.toHaveBeenCalled(); expect(f.awaitProcessTreeExit).not.toHaveBeenCalled();
    });
    it('does not infer sidecar exit from a missing host without a recorded proof', async () => {
        const f = await fixture(true); f.captureProcessTree.mockRejectedValueOnce(new Error('Host lifetime missing'));
        await expect(retireUnsentConversationCandidate(f.input)).rejects.toThrow('Host lifetime');
        expect(f.callSessionRpc.mock.calls.some(([, , method]) => method === 'killSession')).toBe(false);
    });
});
