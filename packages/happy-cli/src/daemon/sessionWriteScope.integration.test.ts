import { describe, expect, it } from 'vitest';
import { SandboxConfigSchema } from '@/persistence';
import { eventually, SessionWriteScopeFixture } from '@/testing/sessionWriteScopeFixture';
import type { ScopeRequest } from './sessionWriteScope';

describe.skipIf(process.env.HAPPY_SCOPE_SERVER_INTEGRATION !== '1' || !['darwin', 'linux'].includes(process.platform)).each([
    { provider: 'codex' as const, encryptionVariant: 'legacy' as const },
    { provider: 'codex' as const, encryptionVariant: 'dataKey' as const },
    { provider: 'claude' as const, encryptionVariant: 'legacy' as const },
    { provider: 'claude' as const, encryptionVariant: 'dataKey' as const },
])('real standalone/daemon/$provider/$encryptionVariant scope replacement', ({ provider, encryptionVariant }) => {
    it('preserves identity, encrypted history, queued input and another session across approval/revoke with lost response', async () => {
        const fixture = new SessionWriteScopeFixture({ provider, encryptionVariant });
        try {
            await fixture.start();
            const config = SandboxConfigSchema.parse({ sessionIsolation: 'strict', networkMode: 'custom', allowedDomains: ['127.0.0.1', 'localhost', fixture.modelHost] });
            const id = await fixture.spawnSession(fixture.project, config);
            const other = await fixture.spawnSession(fixture.otherProject, config);
            await fixture.send(id, 'scope-marker-before');
            await fixture.waitReply(id, 'scope-marker-before');
            await fixture.send(other, 'scope-marker-other');
            await fixture.waitReply(other, 'scope-marker-other');
            const otherBefore = await fixture.session(other);
            if (encryptionVariant === 'dataKey') {
                expect(fixture.sessionKey(id).equals(fixture.sessionKey(other))).toBe(false);
                expect(fixture.sessionKey(id).equals(fixture.machineKey)).toBe(false);
            }
            const otherPid = (await fixture.children()).find(child => child.happySessionId === other)!.pid;
            const identity = await fixture.session(id);
            expect(identity.metadata[fixture.providerIdentityField]).toBeTruthy();
            expect((await fixture.savedSession(id)).encryptionVariant).toBe(encryptionVariant);
            const requested = await fixture.scopeRequest(id, fixture.tools);
            const original = (await fixture.children()).find(child => child.happySessionId === id)!;
            const before = await fixture.messages(id);
            expect((await fixture.control('/session-write-scope/decide', { ...fixture.approval(requested), signature: 'unsigned' })).status).toBe(409);
            expect((await fixture.control('/session-runtime', { sessionId: id, hostPid: original.pid, thinking: false, lastProcessedSeq: 999999 })).status).toBe(403);
            const decision = fixture.discardApprovalResponse(requested);
            // Observe real old-root absence, then store a message while replacement is still in progress.
            await eventually(async () => {
                try { process.kill(original.pid, 0); return undefined; }
                catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
            }, 'owned old root exit');
            const frozen = await fixture.savedSession(id);
            const queued = await fixture.send(id, 'scope-marker-queued');
            expect(frozen.lastProcessedSeq).toBeLessThan(queued.seq);
            await decision;
            const listed = await fixture.control('/session-write-scope', { action: 'list', sessionId: id });
            expect(listed.body.requests.find((value: ScopeRequest) => value.id === requested.id))
                .toMatchObject({ profileApplied: true, grantActive: true, state: 'cleanup-unresolved' });
            const renewed = (await fixture.children()).find(child => child.happySessionId === id)!;
            expect(renewed.pid).not.toBe(original.pid);
            expect(() => process.kill(original.pid, 0)).toThrow();
            expect((await fixture.messages(id)).slice(0, before.length)).toEqual(before);
            await fixture.waitReply(id, 'scope-marker-queued');
            expect((await fixture.savedSession(id)).encryptionKey).toBe(fixture.sessionKey(id).toString('base64'));
            expect((await fixture.session(id)).dataEncryptionKey).toBe(identity.dataEncryptionKey);
            expect((await fixture.session(id)).metadata[fixture.providerIdentityField]).toBe(identity.metadata[fixture.providerIdentityField]);
            expect((await fixture.session(id)).metadata.sandbox.extraWritePaths).toContain(fixture.tools);
            expect((await fixture.control('/session-write-scope/decide', fixture.approval(requested))).status).toBe(409);
            const revoke = await fixture.scopeRequest(id, fixture.tools, 'revoke');
            const revoked = await fixture.control('/session-write-scope/decide', fixture.approval(revoke));
            expect(revoked.body.result).toMatchObject({ profileApplied: true, state: 'cleanup-unresolved' });
            expect((await fixture.session(id)).metadata.sandbox.extraWritePaths).not.toContain(fixture.tools);
            expect((await fixture.control('/session-write-scope', { action: 'list', sessionId: id })).body.requests
                .find((value: ScopeRequest) => value.id === requested.id).grantActive).toBe(false);
            await fixture.send(id, 'scope-marker-after-revoke');
            await fixture.waitReply(id, 'scope-marker-after-revoke');
            const transcript = await fixture.messages(id);
            expect(transcript.slice(0, before.length)).toEqual(before);
            expect(transcript.every(message => message.content.t === 'encrypted' && fixture.decode(message.content.c, id) !== null)).toBe(true);
            expect(new Set(transcript.map(message => message.id)).size).toBe(transcript.length);
            for (const marker of ['scope-marker-before', 'scope-marker-queued', 'scope-marker-after-revoke']) {
                expect(transcript.filter(message => fixture.decode(message.content.c, id)?.content?.ev?.text === `fixture reply ${marker}`)).toHaveLength(1);
            }
            expect((await fixture.children()).find(child => child.happySessionId === other)!.pid).toBe(otherPid);
            const otherAfter = await fixture.session(other);
            for (const key of ['sandbox', 'dangerouslySkipPermissions', 'path', 'hostPid', fixture.providerIdentityField]) {
                expect(otherAfter.metadata[key]).toEqual(otherBefore.metadata[key]);
            }
            expect((await fixture.control('/session-write-scope', { action: 'list', sessionId: other })).body.requests).toEqual([]);
            if (provider === 'codex') expect(fixture.modelRequests).toHaveLength(4);
            expect(fixture.failures).toEqual([]);
        } catch (error) {
            console.error('Scope integration failed:', error, 'model requests:', fixture.modelRequests.length, await fixture.diagnostics()); throw error;
        } finally { await fixture.close(); }
    });
    it('fails closed while storage is disconnected and expires pending/grants on a new daemon incarnation', async () => {
        const fixture = new SessionWriteScopeFixture({ provider, encryptionVariant });
        try {
            await fixture.start();
            const config = SandboxConfigSchema.parse({ sessionIsolation: 'strict', networkMode: 'custom', allowedDomains: ['127.0.0.1', 'localhost', fixture.modelHost] });
            const id = await fixture.spawnSession(fixture.project, config);
            await fixture.send(id, 'scope-marker-recovery-before');
            await fixture.waitReply(id, 'scope-marker-recovery-before');
            const grant = await fixture.scopeRequest(id, fixture.tools);
            const applied = await fixture.control('/session-write-scope/decide', fixture.approval(grant));
            expect(applied.body.result).toMatchObject({ profileApplied: true, grantActive: true });
            await fixture.send(id, 'scope-marker-recovery-applied');
            await fixture.waitReply(id, 'scope-marker-recovery-applied');
            const pending = await fixture.scopeRequest(id, fixture.otherTools);
            const waiting = await fixture.scopeRequest(id, fixture.tools);
            const pid = (await fixture.children()).find(child => child.happySessionId === id)!.pid;
            const requestsBeforeFault = fixture.modelRequests.length;
            await fixture.stopServer();
            await fixture.waitDaemonConnection(false);
            const failed = await fixture.control('/session-write-scope/decide', fixture.approval(pending));
            expect(failed.body.result, JSON.stringify(failed.body.result)).toMatchObject({ profileApplied: false, grantActive: false, state: 'cleanup-unresolved' });
            expect((await fixture.children()).find(child => child.happySessionId === id)!.pid).toBe(pid);
            expect(() => process.kill(pid, 0)).not.toThrow();
            await eventually(async () => (await fixture.diagnostics()).includes('Shutdown blocked; retaining API and provider ownership') ? true : undefined,
                'storage failure holds runtime ownership');
            await fixture.startServer();
            await fixture.waitDaemonConnection(true);
            await fixture.send(id, 'scope-marker-recovery-queued');
            expect(fixture.modelRequests).toHaveLength(requestsBeforeFault);
            const history = await fixture.messages(id);
            const identity = await fixture.session(id);
            const saved = await fixture.savedSession(id);
            expect(JSON.parse(saved.agentEnvironment.HAPPY_PROJECT_SANDBOX_CONFIG).extraWritePaths).not.toContain(fixture.tools);
            await fixture.terminateFaultedFixtureSession(id);
            await fixture.stopDaemon();
            fixture.incarnation = 'restarted-' + fixture.incarnation;
            await fixture.startDaemon();
            const recovered = await fixture.control('/session-write-scope', { action: 'list', sessionId: id });
            expect(recovered.body.requests.find((request: ScopeRequest) => request.id === grant.id))
                .toMatchObject({ state: 'cleanup-unresolved', grantActive: false });
            expect(recovered.body.requests.find((request: ScopeRequest) => request.id === waiting.id))
                .toMatchObject({ state: 'expired', grantActive: false });
            expect((await fixture.control('/session-write-scope/decide', fixture.approval(waiting))).status).toBe(409);
            expect(await fixture.resumeSession(id)).toBe(id);
            await fixture.waitReply(id, 'scope-marker-recovery-queued');
            await fixture.send(id, 'scope-marker-recovery-resumed');
            await fixture.waitReply(id, 'scope-marker-recovery-resumed');
            expect((await fixture.savedSession(id)).encryptionKey).toBe(saved.encryptionKey);
            expect((await fixture.savedSession(id)).encryptionVariant).toBe(encryptionVariant);
            const resumed = await fixture.session(id);
            expect(resumed.dataEncryptionKey).toBe(identity.dataEncryptionKey);
            expect(resumed.metadata[fixture.providerIdentityField]).toBe(identity.metadata[fixture.providerIdentityField]);
            expect((await fixture.session(id)).metadata.sandbox.extraWritePaths).not.toContain(fixture.tools);
            expect((await fixture.messages(id)).slice(0, history.length)).toEqual(history);
            const transcript = await fixture.messages(id);
            for (const marker of ['scope-marker-recovery-before', 'scope-marker-recovery-applied', 'scope-marker-recovery-queued', 'scope-marker-recovery-resumed']) {
                expect(transcript.filter(message => fixture.decode(message.content.c, id)?.content?.ev?.text === `fixture reply ${marker}`)).toHaveLength(1);
            }
            if (provider === 'codex') expect(fixture.modelRequests).toHaveLength(4);
            expect(fixture.failures).toEqual([]);
        } catch (error) {
            console.error('Scope recovery failed:', error, await fixture.diagnostics()); throw error;
        } finally { await fixture.close(); }
    });
});
