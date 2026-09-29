import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
    ackAutomationSync,
    claimAutomationRun,
    heartbeatAutomationRun,
    registerAutomationMachineKey,
    reportAutomationRun,
    resolveAutomationRunMcpContext,
    startAutomationRun,
    syncAutomations,
} from './automationExecutionService';

const now = new Date('2026-08-10T08:00:00.000Z');

function automation(patch: Record<string, unknown> = {}) {
    return {
        id: 'automation-1', projectId: 'project-1', ownerAccountId: 'owner-1', machineAccountId: 'account-1', machineId: 'machine-1',
        revision: 2, generation: 3, paused: false, deletedAt: null, enabledAt: new Date(0),
        runRequestedAt: null,
        legacyMigrationPending: false,
        payloadVersion: 1, payloadCiphertext: new Uint8Array([1]), machineKeyVersion: 4,
        machineKeyEnvelope: new Uint8Array([2]), viewerKeyVersion: 5,
        project: { automationViewerKeyVersion: 5 },
        targetMachine: { automationKeyVersion: 4 },
        ...patch,
    };
}

function makeTx() {
    const row = automation();
    return {
        machine: {
            updateMany: vi.fn(async () => ({ count: 1 })),
            findFirst: vi.fn(),
        },
        automationChange: { findMany: vi.fn(async () => [{
            seq: 9n, automationId: 'automation-1', revision: 2, generation: 3, kind: 'UPSERT',
            machineAccountId: 'account-1', machineId: 'machine-1', createdAt: now,
        }]) },
        automation: {
            findFirst: vi.fn(async () => row),
            findMany: vi.fn(async () => [row]),
            updateMany: vi.fn(async () => ({ count: 1 })),
        },
        automationRun: {
            updateMany: vi.fn(async () => ({ count: 1 })),
            createMany: vi.fn(async (_input: { data: object[]; skipDuplicates: boolean }) => ({ count: 1 })),
            findFirst: vi.fn(),
            findUnique: vi.fn(),
        },
        sessionFollowup: {
            findMany: vi.fn(async (): Promise<any[]> => []),
            updateMany: vi.fn(async () => ({ count: 1 })),
            findUnique: vi.fn(),
        },
        sessionFollowupChange: { create: vi.fn(async () => ({})) },
        sessionFollowupHistory: { create: vi.fn(async () => ({})) },
        session: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => null) },
    };
}

describe('automationExecutionService', () => {
    it('registers a persistent public key with account, machine, and version CAS', async () => {
        const tx = makeTx();
        await expect(registerAutomationMachineKey(tx as never, 'account-1', 'machine-1', {
            expectedKeyVersion: 3,
            publicKey: new Uint8Array(32),
            protocolVersion: 2,
        })).resolves.toEqual({ ok: true, value: { keyVersion: 4, invalidatedProjectIds: [], targetChanged: true } });
        expect(tx.machine.updateMany).toHaveBeenCalledWith({
            where: { id: 'machine-1', accountId: 'account-1', automationKeyVersion: 3 },
            data: {
                automationPublicKey: new Uint8Array(32),
                automationKeyVersion: { increment: 1 },
                automationProtocolVersion: 2,
            },
        });
        expect(tx.sessionFollowup.findMany).toHaveBeenCalledWith({ where: expect.objectContaining({
            machineAccountId: 'account-1', machineId: 'machine-1',
        }) });
    });

    it('updates the protocol capability without rotating an unchanged key', async () => {
        const tx = makeTx();
        const publicKey = new Uint8Array(32);
        tx.machine.findFirst.mockResolvedValue({
            automationPublicKey: publicKey,
            automationKeyVersion: 4,
            automationProtocolVersion: 1,
        });

        await expect(registerAutomationMachineKey(tx as never, 'account-1', 'machine-1', {
            expectedKeyVersion: 4,
            publicKey,
            protocolVersion: 2,
        })).resolves.toEqual({ ok: true, value: { keyVersion: 4, invalidatedProjectIds: [], targetChanged: true } });
        expect(tx.machine.updateMany).toHaveBeenCalledWith({
            where: { id: 'machine-1', accountId: 'account-1', automationKeyVersion: 4 },
            data: { automationProtocolVersion: 2 },
        });
    });

    it('reports an unchanged target when a restarted daemon re-registers the same key and protocol', async () => {
        const tx = makeTx();
        const publicKey = new Uint8Array(32);
        tx.machine.findFirst.mockResolvedValue({
            automationPublicKey: publicKey,
            automationKeyVersion: 4,
            automationProtocolVersion: 2,
        });

        await expect(registerAutomationMachineKey(tx as never, 'account-1', 'machine-1', {
            expectedKeyVersion: 4,
            publicKey,
            protocolVersion: 2,
        })).resolves.toEqual({ ok: true, value: { keyVersion: 4, invalidatedProjectIds: [], targetChanged: false } });
        expect(tx.machine.updateMany).not.toHaveBeenCalled();
    });

    it('generation-fences active follow-ups when the same key reports an unsupported protocol', async () => {
        const tx = makeTx();
        const publicKey = new Uint8Array(32);
        const followup = {
            id: 'followup-1', projectId: 'project-1', machineAccountId: 'account-1', machineId: 'machine-1',
            revision: 2, generation: 3, step: 4, status: 'WAITING', deletedAt: null,
            currentRound: 1, lastObservedSeq: 10,
        };
        tx.machine.findFirst.mockResolvedValue({
            automationPublicKey: publicKey,
            automationKeyVersion: 4,
            automationProtocolVersion: 4,
        });
        tx.sessionFollowup.findMany.mockResolvedValue([followup]);
        tx.sessionFollowup.findUnique.mockResolvedValue({
            ...followup,
            revision: 3,
            generation: 4,
            step: 5,
            status: 'FAILED',
            terminalCode: 'TARGET_MISMATCH',
        });

        await expect(registerAutomationMachineKey(tx as never, 'account-1', 'machine-1', {
            expectedKeyVersion: 4,
            publicKey,
            protocolVersion: 3,
        })).resolves.toEqual({
            ok: true,
            value: { keyVersion: 4, invalidatedProjectIds: ['project-1'], targetChanged: true },
        });
        expect(tx.sessionFollowup.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: 'followup-1', revision: 2, generation: 3, step: 4,
            }),
            data: expect.objectContaining({
                status: 'FAILED',
                terminalCode: 'TARGET_MISMATCH',
                generation: { increment: 1 },
            }),
        }));
        expect(tx.sessionFollowupHistory.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ terminalCode: 'TARGET_MISMATCH' }),
        });
    });

    it('recovers idempotently when the server committed the same key before the daemon saved its version', async () => {
        const tx = makeTx();
        const publicKey = new Uint8Array(32);
        tx.machine.updateMany.mockResolvedValue({ count: 0 });
        tx.machine.findFirst.mockResolvedValue({
            automationPublicKey: publicKey, automationKeyVersion: 4, automationProtocolVersion: 2,
        });

        await expect(registerAutomationMachineKey(tx as never, 'account-1', 'machine-1', {
            expectedKeyVersion: 3,
            publicKey,
            protocolVersion: 2,
        })).resolves.toEqual({ ok: true, value: { keyVersion: 4, invalidatedProjectIds: [], targetChanged: false } });
    });

    it('returns only machine-targeted deltas without the viewer envelope', async () => {
        const tx = makeTx();
        const result = await syncAutomations(tx as never, 'account-1', 'machine-1', { afterSeq: 0n, limit: 100 }, now);
        expect(tx.automationChange.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { machineAccountId: 'account-1', machineId: 'machine-1', seq: { gt: 0n } },
        }));
        expect(result).toEqual({ ok: true, value: expect.objectContaining({
            nextSeq: 9n,
            changes: [expect.objectContaining({ kind: 'UPSERT', payloadCiphertext: new Uint8Array([1]) })],
        }) });
        expect((result as any).value.changes[0].viewerKeyEnvelope).toBeUndefined();
        expect((result as any).value.changes[0].migrationPending).toBe(false);
    });

    it('claims only the current generation inside the due window and stores only a token hash', async () => {
        const tx = makeTx();
        const result = await claimAutomationRun(tx as never, 'account-1', 'machine-1', {
            automationId: 'automation-1', generation: 3, scheduledFor: new Date(now.getTime() - 30_000),
        }, now);
        expect(result).toEqual({ ok: true, value: expect.objectContaining({ runId: expect.any(String), claimToken: expect.any(String) }) });
        const data = tx.automationRun.createMany.mock.calls[0]![0].data[0] as any;
        expect(data.claimTokenHash).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(data.claimTokenHash).toString('base64url')).not.toBe((result as any).value.claimToken);

        await expect(claimAutomationRun(tx as never, 'account-1', 'machine-1', {
            automationId: 'automation-1', generation: 2, scheduledFor: now,
        }, now)).resolves.toEqual({ ok: false, error: 'claim-denied' });
    });

    it('accepts an older due time only when it exactly matches the durable run-now request', async () => {
        const tx = makeTx();
        const requestedAt = new Date(now.getTime() - 10 * 60_000);
        tx.automation.findFirst.mockResolvedValue(automation({ runRequestedAt: requestedAt }));

        await expect(claimAutomationRun(tx as never, 'account-1', 'machine-1', {
            automationId: 'automation-1', generation: 3, scheduledFor: requestedAt,
        }, now)).resolves.toEqual({
            ok: true,
            value: expect.objectContaining({ runId: expect.any(String) }),
        });
        await expect(claimAutomationRun(tx as never, 'account-1', 'machine-1', {
            automationId: 'automation-1', generation: 3,
            scheduledFor: new Date(requestedAt.getTime() + 1),
        }, now)).resolves.toEqual({ ok: false, error: 'claim-denied' });
    });

    it('does not revive a durable run-now request after fifteen minutes', async () => {
        const tx = makeTx();
        const requestedAt = new Date(now.getTime() - 15 * 60_000 - 1);
        tx.automation.findFirst.mockResolvedValue(automation({ runRequestedAt: requestedAt }));

        await expect(claimAutomationRun(tx as never, 'account-1', 'machine-1', {
            automationId: 'automation-1', generation: 3, scheduledFor: requestedAt,
        }, now)).resolves.toEqual({ ok: false, error: 'claim-denied' });
        expect(tx.automationRun.createMany).not.toHaveBeenCalled();
    });

    it('denies claims while legacy ownership is still staged', async () => {
        const tx = makeTx();
        tx.automation.findFirst.mockResolvedValue(automation({ legacyMigrationPending: true }));

        await expect(claimAutomationRun(tx as never, 'account-1', 'machine-1', {
            automationId: 'automation-1', generation: 3, scheduledFor: now,
        }, now)).resolves.toEqual({ ok: false, error: 'claim-denied' });
        expect(tx.automationRun.createMany).not.toHaveBeenCalled();
    });

    it('maps the database uniqueness fence to an already-claimed result', async () => {
        const tx = makeTx();
        tx.automationRun.createMany.mockResolvedValue({ count: 0 });
        tx.automationRun.findFirst.mockImplementation(async () => {
            if (tx.automationRun.createMany.mock.calls.length === 0) {
                throw new Error('current transaction is aborted');
            }
            return { id: 'existing-run' };
        });
        await expect(claimAutomationRun(tx as never, 'account-1', 'machine-1', {
            automationId: 'automation-1', generation: 3, scheduledFor: now,
        }, now)).resolves.toEqual({ ok: false, error: 'already-claimed' });
    });

    it('distinguishes an overlapping active run from the same scheduled slot', async () => {
        const tx = makeTx();
        tx.automationRun.createMany.mockResolvedValue({ count: 0 });
        tx.automationRun.findFirst.mockResolvedValue(null);

        await expect(claimAutomationRun(tx as never, 'account-1', 'machine-1', {
            automationId: 'automation-1', generation: 3, scheduledFor: now,
        }, now)).resolves.toEqual({ ok: false, error: 'active-run' });
    });

    it('cancels a claimed run when pause wins before start', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({
            id: 'run-1', status: 'CLAIMED', claimExpiresAt: new Date(now.getTime() + 60_000),
            automation: automation({ paused: true }),
        });
        await expect(startAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token',
        }, now)).resolves.toEqual({ ok: false, error: 'claim-cancelled' });
        expect(tx.automationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'CANCELLED', completedAt: now } }));
    });

    it('does not resurrect a run after its heartbeat lease expires', async () => {
        const tx = makeTx();
        tx.automationRun.updateMany.mockResolvedValue({ count: 0 });

        await expect(heartbeatAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token',
        }, now)).resolves.toEqual({ ok: false, error: 'run-not-running' });
        expect(tx.automationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ runLeaseExpiresAt: { gte: now } }),
        }));
    });

    it('resolves MCP context from the running claim without treating the machine account as the owner', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({
            id: 'run-1',
            automationId: 'automation-1',
            machineId: 'machine-1',
            status: 'RUNNING',
            runLeaseExpiresAt: new Date(now.getTime() + 60_000),
            automation: automation({ ownerAccountId: 'owner-2' }),
        });

        await expect(resolveAutomationRunMcpContext(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token',
        }, now)).resolves.toEqual({
            ok: true,
            value: {
                automationId: 'automation-1',
                ownerAccountId: 'owner-2',
                projectId: 'project-1',
                machineId: 'machine-1',
                runLeaseExpiresAt: now.getTime() + 60_000,
            },
        });
    });

    it('rejects a session link before that exact session is recorded by the terminal run report', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({
            id: 'run-1', automationId: 'automation-1', machineId: 'machine-1',
            status: 'RUNNING', runLeaseExpiresAt: new Date(now.getTime() + 60_000),
            sessionId: null, automation: automation({ ownerAccountId: 'owner-2' }),
        });
        await expect(resolveAutomationRunMcpContext(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', sessionId: 'session-1',
        }, now)).resolves.toEqual({ ok: false, error: 'run-not-running' });
        expect(tx.session.findFirst).not.toHaveBeenCalled();
    });

    it('allows a durable project link retry after the matching run report is terminal', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({
            id: 'run-1', automationId: 'automation-1', machineId: 'machine-1',
            status: 'COMPLETED', runLeaseExpiresAt: new Date(now.getTime() - 1),
            reportId: 'report-1', sessionId: 'session-1',
            automation: automation({ ownerAccountId: 'owner-2' }),
        });
        tx.session.findFirst.mockResolvedValue({ id: 'session-1' });

        await expect(resolveAutomationRunMcpContext(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', sessionId: 'session-1',
        }, now)).resolves.toEqual({
            ok: true,
            value: expect.objectContaining({ projectId: 'project-1', runLeaseExpiresAt: null }),
        });
    });

    it('rejects project link context for a foreign or mismatched session', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({
            id: 'run-1', automationId: 'automation-1', machineId: 'machine-1',
            status: 'COMPLETED', reportId: 'report-1', sessionId: 'session-1',
            runLeaseExpiresAt: new Date(now.getTime() - 1), automation: automation(),
        });

        await expect(resolveAutomationRunMcpContext(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', sessionId: 'other-session',
        }, now)).resolves.toEqual({ ok: false, error: 'run-not-running' });
        expect(tx.session.findFirst).not.toHaveBeenCalled();
    });

    it.each([
        { status: 'CLAIMED', runLeaseExpiresAt: null },
        { status: 'RUNNING', runLeaseExpiresAt: new Date(now.getTime() - 1) },
    ])('rejects MCP context when the claim is not an actively leased run', async (run) => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({
            id: 'run-1', automationId: 'automation-1', automation: automation(), ...run,
        });

        await expect(resolveAutomationRunMcpContext(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token',
        }, now)).resolves.toEqual({ ok: false, error: 'run-not-running' });
    });

    it('rejects MCP context when account, machine, run, or claim token does not match', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue(null);

        await expect(resolveAutomationRunMcpContext(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'forged-token',
        }, now)).resolves.toEqual({ ok: false, error: 'claim-not-found' });
    });

    it('returns an existing terminal result for the same report id', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({
            id: 'run-1', status: 'COMPLETED', reportId: 'report-1', outcome: 'WOKE', sessionId: 'session-1',
            automation: automation(),
        });
        await expect(reportAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', reportId: 'report-1', status: 'COMPLETED',
            outcome: 'WOKE', sessionId: 'session-1', detailCiphertext: null, failureCode: null,
        }, now)).resolves.toEqual({ ok: true, value: expect.objectContaining({ idempotent: true }) });
        expect(tx.automationRun.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a first completion report linked to a foreign session', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({ id: 'run-1', status: 'RUNNING', reportId: null });
        await expect(reportAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', reportId: 'report-1', status: 'COMPLETED',
            outcome: 'WOKE', sessionId: 'foreign-session', detailCiphertext: null, failureCode: null,
        }, now)).resolves.toEqual({ ok: false, error: 'report-conflict' });
        expect(tx.session.findFirst).toHaveBeenCalledWith({
            where: { id: 'foreign-session', accountId: 'account-1' }, select: { id: true },
        });
        expect(tx.automationRun.updateMany).not.toHaveBeenCalled();
    });

    it.each(['WOKE', 'SILENT'] as const)('rejects a %s report without a session link', async (outcome) => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({ id: 'run-1', status: 'RUNNING', reportId: null });

        await expect(reportAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', reportId: 'report-1', status: 'COMPLETED',
            outcome, sessionId: null, detailCiphertext: null, failureCode: null,
        }, now)).resolves.toEqual({ ok: false, error: 'report-conflict' });
        expect(tx.automationRun.updateMany).not.toHaveBeenCalled();
    });

    it('accepts a notify-only GitHub WOKE report with queue depth and no session', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({
            id: 'run-1', status: 'RUNNING', reportId: null,
            runLeaseExpiresAt: new Date(now.getTime() + 1_000),
            automation: automation(),
        });

        await expect(reportAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', reportId: 'report-1', status: 'COMPLETED',
            outcome: 'WOKE', sessionId: null, detailCiphertext: null, failureCode: null,
            notificationOnly: true,
            queueDepth: 2, queuePosition: 1, queueTotal: 3,
            queueEstimatedAt: new Date(now.getTime() + 1_000),
        }, now)).resolves.toEqual({
            ok: true,
            value: expect.objectContaining({ idempotent: false }),
        });
        expect(tx.automationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                queueDepth: 2, queuePosition: 1, queueTotal: 3,
                queueEstimatedAt: new Date(now.getTime() + 1_000),
            }),
        }));
    });

    it('does not infer a notify-only WOKE report from queue progress when intent is false', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({
            id: 'run-1', status: 'RUNNING', reportId: null,
            runLeaseExpiresAt: new Date(now.getTime() + 1_000),
            automation: automation(),
        });

        await expect(reportAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', reportId: 'report-1', status: 'COMPLETED',
            outcome: 'WOKE', sessionId: null, detailCiphertext: null, failureCode: null,
            notificationOnly: false, queueDepth: 2,
        }, now)).resolves.toEqual({ ok: false, error: 'report-conflict' });
        expect(tx.automationRun.updateMany).not.toHaveBeenCalled();
    });
    it('rejects inconsistent GitHub queue progress', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({ id: 'run-1', status: 'RUNNING', reportId: null });

        await expect(reportAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', reportId: 'report-1', status: 'COMPLETED',
            outcome: 'SKIPPED_GATE', sessionId: null, detailCiphertext: null, failureCode: null,
            queueDepth: 2, queuePosition: 4, queueTotal: 3, queueEstimatedAt: null,
        }, now)).resolves.toEqual({ ok: false, error: 'report-conflict' });
        expect(tx.automationRun.updateMany).not.toHaveBeenCalled();
    });

    it('maps a cross-run report id uniqueness conflict to report-conflict', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({ id: 'run-1', status: 'RUNNING', reportId: null });
        tx.automationRun.updateMany.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate report', {
            code: 'P2002',
            clientVersion: 'test',
        }));

        await expect(reportAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', reportId: 'report-used-by-another-run', status: 'COMPLETED',
            outcome: 'WOKE', sessionId: null, detailCiphertext: null, failureCode: null,
        }, now)).resolves.toEqual({ ok: false, error: 'report-conflict' });
    });

    it('marks a report after the run lease deadline as late', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({
            id: 'run-1', status: 'RUNNING', reportId: null,
            runLeaseExpiresAt: new Date(now.getTime() - 1),
            automation: automation(),
        });
        tx.session.findFirst.mockResolvedValue({ id: 'session-1' } as never);

        await reportAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', reportId: 'report-1', status: 'COMPLETED',
            outcome: 'WOKE', sessionId: 'session-1', detailCiphertext: null, failureCode: null,
        }, now);
        expect(tx.automationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ lateReport: true }),
        }));
    });

    it('persists a safe precondition failure code with a failed run', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({
            id: 'run-1', status: 'RUNNING', reportId: null, runLeaseExpiresAt: new Date(now.getTime() + 1_000),
            automation: automation(),
        });

        await reportAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', reportId: 'report-1', status: 'FAILED',
            outcome: 'ERROR', sessionId: null, detailCiphertext: null,
            failureCode: 'TOOL_INVENTORY_EMPTY',
        }, now);

        expect(tx.automationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ failureCode: 'TOOL_INVENTORY_EMPTY' }),
        }));
    });

    it('persists a safe degraded code only for a completed WOKE run', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({
            id: 'run-1', status: 'RUNNING', reportId: null, runLeaseExpiresAt: new Date(now.getTime() + 1_000),
            automation: automation(),
        });
        tx.session.findFirst.mockResolvedValue({ id: 'session-1' } as never);

        await reportAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', reportId: 'report-1', status: 'COMPLETED',
            outcome: 'WOKE', sessionId: 'session-1', detailCiphertext: null, failureCode: null,
            degradedCode: 'GRANT_MISSING',
        }, now);

        expect(tx.automationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ degradedCode: 'GRANT_MISSING' }),
        }));
    });

    it('rejects a degraded code on a non-WOKE run', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({ id: 'run-1', status: 'RUNNING', reportId: null });

        await expect(reportAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', reportId: 'report-1', status: 'FAILED',
            outcome: 'ERROR', sessionId: null, detailCiphertext: null, failureCode: 'GRANT_MISSING',
            degradedCode: 'GRANT_MISSING',
        }, now)).resolves.toEqual({ ok: false, error: 'report-conflict' });
        expect(tx.automationRun.updateMany).not.toHaveBeenCalled();
    });

    it.each([
        { status: 'COMPLETED', outcome: 'ERROR' },
        { status: 'FAILED', outcome: 'WOKE' },
    ] as const)('rejects an invalid $status and $outcome report pair', async ({ status, outcome }) => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({ id: 'run-1', status: 'RUNNING', reportId: null });
        await expect(reportAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', reportId: 'report-1', status,
            outcome, sessionId: null, detailCiphertext: null, failureCode: null,
        }, now)).resolves.toEqual({ ok: false, error: 'report-conflict' });
        expect(tx.automationRun.updateMany).not.toHaveBeenCalled();
    });

    // specs/automation-request-surge R1/R2 — the surge came from project-scoped
    // automation traffic being announced as an account-wide invalidation. The
    // service, not the client, must name the affected projects, and an
    // acknowledgement that changed nothing must name none.
    it('reports the affected projects of the acknowledgements that actually advanced', async () => {
        const tx = makeTx();
        tx.automation.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });
        tx.automation.findMany.mockResolvedValue([{ projectId: 'project-9' }] as never);

        await expect(ackAutomationSync(tx as never, 'account-1', 'machine-1', [
            { automationId: 'automation-1', revision: 2 },
            { automationId: 'automation-2', revision: 7 },
        ], now)).resolves.toEqual({
            ok: true,
            value: { acknowledged: 1, affectedProjectIds: ['project-9'] },
        });
        expect(tx.automation.findMany).toHaveBeenCalledWith({
            where: {
                id: { in: ['automation-1'] },
                machineAccountId: 'account-1',
                machineId: 'machine-1',
            },
            select: { projectId: true },
        });
    });

    it('reports no affected project when every acknowledgement is a no-op', async () => {
        const tx = makeTx();
        tx.automation.updateMany.mockResolvedValue({ count: 0 });

        await expect(ackAutomationSync(tx as never, 'account-1', 'machine-1', [
            { automationId: 'automation-1', revision: 2 },
        ], now)).resolves.toEqual({
            ok: true,
            value: { acknowledged: 0, affectedProjectIds: [] },
        });
        expect(tx.automation.findMany).not.toHaveBeenCalled();
    });

    it('does not trust a repeated automation id for more affected projects than rows changed', async () => {
        const tx = makeTx();
        tx.automation.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });
        tx.automation.findMany.mockResolvedValue([{ projectId: 'project-9' }] as never);

        await expect(ackAutomationSync(tx as never, 'account-1', 'machine-1', [
            { automationId: 'automation-1', revision: 2 },
            { automationId: 'automation-1', revision: 2 },
        ], now)).resolves.toEqual({
            ok: true,
            value: { acknowledged: 1, affectedProjectIds: ['project-9'] },
        });
        expect(tx.automation.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ id: { in: ['automation-1'] } }),
        }));
    });

    it('names the authoritative project of a claimed run', async () => {
        const tx = makeTx();
        tx.automation.findFirst.mockResolvedValue(automation({ projectId: 'project-7' }));

        const result = await claimAutomationRun(tx as never, 'account-1', 'machine-1', {
            automationId: 'automation-1', generation: 3, scheduledFor: new Date(now.getTime() - 30_000),
        }, now);
        expect(result).toEqual({ ok: true, value: expect.objectContaining({ projectId: 'project-7' }) });
    });

    it('names the authoritative project of a started run', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({
            id: 'run-1', status: 'CLAIMED', generation: 3,
            claimExpiresAt: new Date(now.getTime() + 60_000),
            automation: automation({ projectId: 'project-7' }),
        });

        await expect(startAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token',
        }, now)).resolves.toEqual({ ok: true, value: expect.objectContaining({ projectId: 'project-7' }) });
    });

    it('names the authoritative project of a reported run', async () => {
        const tx = makeTx();
        tx.automationRun.findFirst.mockResolvedValue({
            id: 'run-1', status: 'RUNNING', reportId: null,
            runLeaseExpiresAt: new Date(now.getTime() + 1_000),
            automation: automation({ projectId: 'project-7' }),
        });

        await expect(reportAutomationRun(tx as never, 'account-1', 'machine-1', {
            runId: 'run-1', claimToken: 'token', reportId: 'report-1', status: 'FAILED',
            outcome: 'ERROR', sessionId: null, detailCiphertext: null,
            failureCode: 'TOOL_INVENTORY_EMPTY',
        }, now)).resolves.toEqual({ ok: true, value: expect.objectContaining({
            idempotent: false, projectId: 'project-7',
        }) });
    });

});
