import { logger } from '@/ui/logger';
import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as signEd25519 } from 'node:crypto';

import { canonicalLessonDigest, createLessonGrantVerifier, lessonGrantAudience } from './lessonGrantVerifier';
import { createLessonHostSupervisor } from './lessonHostSupervisor';

const AUDIENCE = lessonGrantAudience('https://studio.example');
const pair = generateKeyPairSync('ed25519');
const publicKeyBase64 = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function grant(request: Record<string, unknown>, claims: Record<string, unknown>) {
    const now = Date.now();
    const payload = Buffer.from(JSON.stringify({
        v: 1, aud: AUDIENCE, op: request.operation, digest: canonicalLessonDigest(request),
        userId: 'u1', machineId: 'm1', capabilities: ['lesson.read', 'lesson.manage'],
        iat: now, expiresAt: now + 60_000, ...claims,
    }), 'utf8').toString('base64url');
    return `${payload}.${signEd25519(null, Buffer.from(payload, 'utf8'), pair.privateKey).toString('base64url')}`;
}

const snapshot = { version: 1, projectId: 'p1', requestId: 'r1', operation: 'snapshot' };

function supervisorFor(open: ReturnType<typeof vi.fn>) {
    // The module under test creates runtimes through `createLessonHostRuntime`;
    // the spy stands in for the store so the routing decision is what is tested.
    vi.doMock('./lessonHostRuntime', () => ({
        LESSON_HOST_RPC_METHOD: 'lesson-host-v1',
        fetchLessonGrantPublicKey: async () => null,
        createLessonHostRuntime: open,
    }));
    return createLessonHostSupervisor({
        routeVerifier: () => createLessonGrantVerifier({
            publicKeyBase64, machineId: 'm1', audience: AUDIENCE, now: () => 1_500,
        }),
        machineId: () => 'm1',
        studioBaseUrl: () => 'https://studio.example',
        studioToken: () => 'token',
        settingsPathFor: (projectId) => `/tmp/${projectId}.json`,
    });
}

describe('createLessonHostSupervisor routing', () => {
    it('retries an unavailable routing key without trusting an unsigned request', async () => {
        const loadRouteVerifier = vi.fn(async () => null);
        const supervisor = createLessonHostSupervisor({
            routeVerifier: () => null, loadRouteVerifier,
            machineId: () => 'm1', studioBaseUrl: () => 'https://studio.example',
            studioToken: () => 'token', settingsPathFor: () => '/tmp/not-opened.json',
        });
        expect(await supervisor.handle(snapshot)).toEqual({ ok: false, reason: 'permission_denied' });
        expect(loadRouteVerifier).toHaveBeenCalledOnce();
        await supervisor.handle(snapshot);
        expect(loadRouteVerifier).toHaveBeenCalledOnce();
        await supervisor.close();
    });

    it('refuses a request with no verifiable grant rather than routing on its body', async () => {
        const supervisor = supervisorFor(vi.fn());
        expect(await supervisor.handle({ ...snapshot, grantEnvelope: 'nonsense' }))
            .toEqual({ ok: false, reason: 'permission_denied' });
        await supervisor.close();
    });

    it('refuses a request carrying no envelope at all', async () => {
        const supervisor = supervisorFor(vi.fn());
        expect(await supervisor.handle(snapshot))
            .toEqual({ ok: false, reason: 'permission_denied' });
        await supervisor.close();
    });

    it('refuses when the daemon has no routing key yet', async () => {
        const supervisor = createLessonHostSupervisor({
            routeVerifier: () => null,
            machineId: () => 'm1',
            studioBaseUrl: () => 'https://studio.example',
            studioToken: () => 'token',
            settingsPathFor: () => '/tmp/x.json',
        });
        expect(await supervisor.handle({
            ...snapshot, grantEnvelope: grant(snapshot, { projectId: 'p1', workspaceDir: '/ws/p1' }),
        })).toEqual({ ok: false, reason: 'permission_denied' });
        await supervisor.close();
    });

    it('never opens a workspace the request supplied, only the one signed', async () => {
        /*
         * The attack this closes: a caller holds a genuine grant for project A
         * and points the request body at project B's directory. The body is not
         * consulted — `workspaceDir` comes out of the signature.
         */
        const supervisor = supervisorFor(vi.fn());
        const forged = { ...snapshot, workspaceDir: '/ws/victim' } as Record<string, unknown>;
        const envelope = grant(forged, { projectId: 'p1', workspaceDir: '/ws/p1' });
        // The body field is part of the digest, so tampering is caught outright;
        // and even a matching digest would not make the body a path source.
        expect(await supervisor.handle({ ...forged, grantEnvelope: envelope, workspaceDir: '/ws/victim' }))
            .toMatchObject({ ok: false });
        await supervisor.close();
    });

    it('does not hand a runtime to a turn for a project no grant has opened', () => {
        const supervisor = supervisorFor(vi.fn());
        expect(supervisor.openedRuntimeFor('p1')).toBeNull();
    });

    it('opens a cold project by asking the studio, not by guessing a path', async () => {
        const requestSnapshotGrant = vi.fn(async (projectId: string) => grant(
            { version: 1, projectId, requestId: `open:${projectId}`, operation: 'snapshot' },
            { projectId, workspaceDir: '/ws/p1' },
        ));
        const supervisor = createLessonHostSupervisor({
            routeVerifier: () => createLessonGrantVerifier({
                publicKeyBase64, machineId: 'm1', audience: AUDIENCE, now: () => 1_500,
            }),
            requestSnapshotGrant,
            machineId: () => 'm1',
            studioBaseUrl: () => 'https://studio.example',
            studioToken: () => 'token',
            settingsPathFor: (projectId) => `/tmp/${projectId}.json`,
        });
        // No UI click first: the daemon asks, the studio decides and signs.
        await supervisor.ensureOpen('p1');
        expect(requestSnapshotGrant).toHaveBeenCalledWith('p1');
        await supervisor.close();
    });

    it('refuses a cold open when the studio declines', async () => {
        const supervisor = createLessonHostSupervisor({
            routeVerifier: () => createLessonGrantVerifier({
                publicKeyBase64, machineId: 'm1', audience: AUDIENCE, now: () => 1_500,
            }),
            requestSnapshotGrant: async () => null,
            machineId: () => 'm1',
            studioBaseUrl: () => 'https://studio.example',
            studioToken: () => 'token',
            settingsPathFor: () => '/tmp/x.json',
        });
        expect(await supervisor.ensureOpen('p1')).toBeNull();
        await supervisor.close();
    });

    it('refuses a cold open whose grant names another project', async () => {
        const supervisor = createLessonHostSupervisor({
            routeVerifier: () => createLessonGrantVerifier({
                publicKeyBase64, machineId: 'm1', audience: AUDIENCE, now: () => 1_500,
            }),
            // A real signature, for the wrong project.
            requestSnapshotGrant: async () => grant(
                { version: 1, projectId: 'p2', requestId: 'open:p2', operation: 'snapshot' },
                { projectId: 'p2', workspaceDir: '/ws/p2' },
            ),
            machineId: () => 'm1',
            studioBaseUrl: () => 'https://studio.example',
            studioToken: () => 'token',
            settingsPathFor: () => '/tmp/x.json',
        });
        expect(await supervisor.ensureOpen('p1')).toBeNull();
        await supervisor.close();
    });
});

describe('authorization lease', () => {
    const openRequest = { version: 1, projectId: 'p1', requestId: 'open:p1', operation: 'snapshot' };

    function leaseFixture(requestSnapshotGrant: (projectId: string) => Promise<string | null>) {
        return createLessonHostSupervisor({
            routeVerifier: () => createLessonGrantVerifier({
                publicKeyBase64, machineId: 'm1', audience: AUDIENCE,
            }),
            requestSnapshotGrant,
            machineId: () => 'm1',
            studioBaseUrl: () => 'https://studio.example',
            studioToken: () => 'token',
            settingsPathFor: (projectId) => `/tmp/${projectId}.json`,
        });
    }

    it('refuses to authorize a project that was never opened', async () => {
        const supervisor = leaseFixture(async () => null);
        expect(await supervisor.authorize('p1', 50)).toBeNull();
        await supervisor.close();
    });

    it('uses a recovered routing key for cold open and expired lease renewal', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
        const loadRouteVerifier = vi.fn(async () => createLessonGrantVerifier({
            publicKeyBase64, machineId: 'm1', audience: AUDIENCE,
        }));
        const requestSnapshotGrant = vi.fn(async (projectId: string) => grant(
            { ...openRequest, projectId },
            { projectId, workspaceDir: '/ws/p1', expiresAt: Date.now() + 1_000 },
        ));
        const supervisor = createLessonHostSupervisor({
            routeVerifier: () => null, loadRouteVerifier, requestSnapshotGrant,
            machineId: () => 'm1', studioBaseUrl: () => 'https://studio.example',
            studioToken: () => 'token', settingsPathFor: () => '/tmp/recovered-key.json',
        });
        try {
            await supervisor.ensureOpen('p1');
            expect(loadRouteVerifier).toHaveBeenCalledOnce();
            expect(supervisor.openedUserId('p1')).toBe('u1');
            clock.mockReturnValue(12_000);
            expect(await supervisor.authorize('p1', 200)).toBe('u1');
            expect(requestSnapshotGrant).toHaveBeenCalledTimes(2);
            expect(loadRouteVerifier).toHaveBeenCalledOnce();
        } finally {
            clock.mockRestore();
            await supervisor.close();
        }
    });

    it('renews an expired read lease using the exact signed snapshot request', async () => {
        let issued = 0;
        const supervisor = leaseFixture(async (projectId) => {
            issued += 1;
            return grant({ ...openRequest, projectId }, {
                projectId, workspaceDir: '/ws/p1',
                iat: Date.now(), expiresAt: Date.now() + (issued === 1 ? 30 : 30_000),
            });
        });
        await supervisor.ensureOpen('p1');
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(await supervisor.authorize('p1', 200)).toBe('u1');
        expect(issued).toBe(2);
        await supervisor.close();
    });

    it('stops authorizing once the caller\'s access is revoked', async () => {
        let issued = 0;
        const supervisor = leaseFixture(async (projectId) => {
            issued += 1;
            // The second answer is the studio refusing: access was withdrawn
            // after the project was opened, which nothing local can observe.
            if (issued > 1) return null;
            // Valid, but only just: the lease it carries ages out immediately.
            return grant(
                { ...openRequest, projectId },
                { projectId, workspaceDir: '/ws/p1', iat: Date.now(), expiresAt: Date.now() + 30 },
            );
        });
        await supervisor.ensureOpen('p1');
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(await supervisor.authorize('p1', 200)).toBeNull();
        // It went back to the studio rather than trusting the expired lease.
        expect(issued).toBeGreaterThan(1);
        await supervisor.close();
    });

    it('never extends a lease locally when the studio cannot be reached', async () => {
        let issued = 0;
        const supervisor = leaseFixture(async (projectId) => {
            issued += 1;
            if (issued > 1) throw new Error('network down');
            return grant(
                { ...openRequest, projectId },
                { projectId, workspaceDir: '/ws/p1', iat: Date.now(), expiresAt: Date.now() + 30 },
            );
        });
        await supervisor.ensureOpen('p1');
        await new Promise((resolve) => setTimeout(resolve, 40));
        // An unreachable studio is not permission to carry on.
        expect(await supervisor.authorize('p1', 100)).toBeNull();
        await supervisor.close();
    });
});

describe('lease renewal diagnostics', () => {
    const openRequest = { version: 1, projectId: 'p1', requestId: 'open:p1', operation: 'snapshot' };

    function shortLeaseFixture(renew: () => Promise<string | null>) {
        let issued = 0;
        return createLessonHostSupervisor({
            routeVerifier: () => createLessonGrantVerifier({ publicKeyBase64, machineId: 'm1', audience: AUDIENCE }),
            requestSnapshotGrant: async (projectId) => {
                issued += 1;
                if (issued > 1) return renew();
                return grant({ ...openRequest, projectId }, { projectId, workspaceDir: '/ws/p1', iat: Date.now(), expiresAt: Date.now() + 30 });
            },
            machineId: () => 'm1',
            studioBaseUrl: () => 'https://studio.example',
            studioToken: () => 'secret-token',
            settingsPathFor: (projectId) => `/tmp/${projectId}.json`,
        });
    }

    it('logs why a lease renewal was refused and how long it took', async () => {
        const debug = vi.spyOn(logger, 'debug');
        const supervisor = shortLeaseFixture(async () => null);
        try {
            await supervisor.ensureOpen('p1');
            await new Promise((resolve) => setTimeout(resolve, 40));
            expect(await supervisor.authorize('p1', 200)).toBeNull();
            expect(debug.mock.calls.map(([line]) => String(line)))
                .toContainEqual(expect.stringMatching(/^\[lesson-host\] lease renewal failed \(no-grant\) \d+ms$/));
        } finally {
            debug.mockRestore();
            await supervisor.close();
        }
    });

    it('logs a lease renewal that outlasts the authorize budget', async () => {
        const debug = vi.spyOn(logger, 'debug');
        const supervisor = shortLeaseFixture(() => new Promise((resolve) => setTimeout(() => resolve(null), 80)));
        try {
            await supervisor.ensureOpen('p1');
            await new Promise((resolve) => setTimeout(resolve, 40));
            expect(await supervisor.authorize('p1', 10)).toBeNull();
            const lines = debug.mock.calls.map(([line]) => String(line));
            expect(lines).toContain('[lesson-host] lease renewal exceeded the 10ms authorize budget');
            expect(lines.join('\n')).not.toContain('secret-token');
        } finally {
            debug.mockRestore();
            await supervisor.close();
        }
    });
});

describe('lease isolation and bounded refresh', () => {
    const openRequest = { version: 1, projectId: 'p1', requestId: 'open:p1', operation: 'snapshot' };

    it('does not let another caller\'s grant extend the host identity\'s lease', async () => {
        let issued = 0;
        const supervisor = createLessonHostSupervisor({
            routeVerifier: () => createLessonGrantVerifier({
                publicKeyBase64, machineId: 'm1', audience: AUDIENCE,
            }),
            requestSnapshotGrant: async (projectId) => {
                issued += 1;
                if (issued > 1) return null;
                return grant(
                    { ...openRequest, projectId },
                    { projectId, workspaceDir: '/ws/p1', iat: Date.now(), expiresAt: Date.now() + 30 },
                );
            },
            machineId: () => 'm1',
            studioBaseUrl: () => 'https://studio.example',
            studioToken: () => 'token',
            settingsPathFor: (projectId) => `/tmp/${projectId}.json`,
        });
        await supervisor.ensureOpen('p1');

        // A second person with genuine access to the same project.
        const other = { version: 1, projectId: 'p1', requestId: 'r-other', operation: 'snapshot' };
        await supervisor.handle({
            ...other,
            grantEnvelope: grant(other, {
                projectId: 'p1', workspaceDir: '/ws/p1', userId: 'someone-else',
                iat: Date.now(), expiresAt: Date.now() + 60_000,
            }),
        });

        await new Promise((resolve) => setTimeout(resolve, 40));
        // Their long-lived grant must not keep the first caller's host alive.
        expect(await supervisor.authorize('p1', 200)).toBeNull();
        await supervisor.close();
    });

    it('bounds a joiner on the same deadline as the caller that started the refresh', async () => {
        let issued = 0;
        const supervisor = createLessonHostSupervisor({
            routeVerifier: () => createLessonGrantVerifier({
                publicKeyBase64, machineId: 'm1', audience: AUDIENCE,
            }),
            requestSnapshotGrant: async (projectId) => {
                issued += 1;
                if (issued > 1) {
                    // A studio that never answers the renewal.
                    return new Promise<string | null>(() => {});
                }
                return grant(
                    { ...openRequest, projectId },
                    { projectId, workspaceDir: '/ws/p1', iat: Date.now(), expiresAt: Date.now() + 30 },
                );
            },
            machineId: () => 'm1',
            studioBaseUrl: () => 'https://studio.example',
            studioToken: () => 'token',
            settingsPathFor: (projectId) => `/tmp/${projectId}.json`,
        });
        await supervisor.ensureOpen('p1');
        await new Promise((resolve) => setTimeout(resolve, 40));

        const started = Date.now();
        const first = supervisor.authorize('p1', 60);
        const joiner = supervisor.authorize('p1', 60);
        expect(await first).toBeNull();
        expect(await joiner).toBeNull();
        // The joiner did not inherit an unbounded wait from the first caller.
        expect(Date.now() - started).toBeLessThan(500);
        await supervisor.close();
    });
});
