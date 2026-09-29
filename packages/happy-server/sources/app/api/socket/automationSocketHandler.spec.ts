import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const services = vi.hoisted(() => ({
    ackAutomationSync: vi.fn(),
    claimAutomationRun: vi.fn(),
    heartbeatAutomationRun: vi.fn(),
    registerAutomationMachineKey: vi.fn(),
    reportAutomationRun: vi.fn(),
    startAutomationRun: vi.fn(),
    syncAutomations: vi.fn(),
    emitAutomationUpdate: vi.fn(),
    emitProjectAutomationUpdate: vi.fn(),
    claimSessionFollowup: vi.fn(),
    deliverSessionFollowupMessage: vi.fn(),
    reportSessionFollowupEvaluation: vi.fn(),
    syncSessionFollowups: vi.fn(),
    emitSessionFollowupMessageUpdate: vi.fn(),
}));
vi.mock('@/app/automation/automationExecutionService', () => services);
vi.mock('@/app/automation/sessionFollowupExecutionService', () => services);
vi.mock('@/app/automation/automationUpdate', () => ({
    emitAutomationUpdate: services.emitAutomationUpdate,
    emitProjectAutomationUpdate: services.emitProjectAutomationUpdate,
}));
vi.mock('@/app/automation/sessionFollowupUpdate', () => ({
    emitSessionFollowupMessageUpdate: services.emitSessionFollowupMessageUpdate,
}));
vi.mock('@/storage/inTx', () => ({ inTx: (callback: (tx: unknown) => unknown) => callback({}) }));

import { automationSocketHandler } from './automationSocketHandler';

describe('automationSocketHandler', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.SAYCODE_AUTOMATION_ENABLED = 'true';
    });
    afterEach(() => delete process.env.SAYCODE_AUTOMATION_ENABLED);

    it('fails closed when the global rollout flag is disabled', async () => {
        process.env.SAYCODE_AUTOMATION_ENABLED = 'false';
        const handlers = new Map<string, Function>();
        const socket = { on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)) };
        automationSocketHandler('account-1', 'machine-1', socket as never);

        const callback = vi.fn();
        await handlers.get('automation-sync')!({ afterSeq: '0', limit: 100 }, callback);
        expect(callback).toHaveBeenCalledWith({ ok: false, error: 'feature-disabled' });
        expect(services.syncAutomations).not.toHaveBeenCalled();
    });

    it('registers the machine-only surface and ignores body identity fields', async () => {
        const handlers = new Map<string, Function>();
        const socket = { on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)) };
        services.syncAutomations.mockResolvedValue({
            ok: true,
            value: { serverTime: new Date(10), nextSeq: 2n, changes: [{
                seq: 2n, kind: 'UPSERT', payloadCiphertext: new Uint8Array([1]), machineKeyEnvelope: new Uint8Array([2]),
            }] },
        });
        automationSocketHandler('account-1', 'machine-1', socket as never);

        expect([...handlers.keys()].sort()).toEqual([
            'automation-claim', 'automation-key-register', 'automation-run-heartbeat',
            'automation-run-report', 'automation-run-start', 'automation-sync', 'automation-sync-ack',
            'session-followup-claim', 'session-followup-deliver', 'session-followup-evaluate',
            'session-followup-sync',
        ]);
        const callback = vi.fn();
        await handlers.get('automation-sync')!({ afterSeq: '0', limit: 100, machineId: 'foreign' }, callback);
        expect(services.syncAutomations).toHaveBeenCalledWith({}, 'account-1', 'machine-1', { afterSeq: 0n, limit: 100 });
        expect(callback).toHaveBeenCalledWith({ ok: true, value: expect.objectContaining({
            nextSeq: '2',
            changes: [expect.objectContaining({ payloadCiphertext: 'AQ==', machineKeyEnvelope: 'Ag==' })],
        }) });
    });

    it('registers run-now protocol support and treats an older daemon as version 1', async () => {
        const handlers = new Map<string, Function>();
        const socket = { on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)) };
        services.registerAutomationMachineKey.mockResolvedValue({
            ok: true,
            value: { keyVersion: 4, invalidatedProjectIds: ['project-1'] },
        });
        automationSocketHandler('account-1', 'machine-1', socket as never);
        const key = Buffer.from(new Uint8Array(32)).toString('base64');

        await handlers.get('automation-key-register')!({
            expectedKeyVersion: 3, publicKey: key, protocolVersion: 2,
        }, vi.fn());
        expect(services.registerAutomationMachineKey).toHaveBeenLastCalledWith(
            {}, 'account-1', 'machine-1', expect.objectContaining({ protocolVersion: 2 }),
        );

        await handlers.get('automation-key-register')!({ expectedKeyVersion: 3, publicKey: key }, vi.fn());
        expect(services.registerAutomationMachineKey).toHaveBeenLastCalledWith(
            {}, 'account-1', 'machine-1', expect.objectContaining({ protocolVersion: 1 }),
        );
        expect(services.emitProjectAutomationUpdate).toHaveBeenCalledWith(
            'project-1', { projectId: 'project-1', reason: 'sync' }, 'account-1',
        );
    });

    it('accepts a safe automation failure code and rejects unstructured values', async () => {
        const handlers = new Map<string, Function>();
        const socket = { on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)) };
        services.reportAutomationRun.mockResolvedValue({
            ok: true, value: { idempotent: false, projectId: 'project-1' },
        });
        automationSocketHandler('account-1', 'machine-1', socket as never);

        const accepted = vi.fn();
        await handlers.get('automation-run-report')!({
            runId: 'run-1', claimToken: 'claim', reportId: 'report-1', status: 'FAILED',
            outcome: 'ERROR', sessionId: null, detailCiphertext: null,
            failureCode: 'CONNECTOR_RUNTIME_UNAVAILABLE',
            degradedCode: null,
        }, accepted);
        expect(services.reportAutomationRun).toHaveBeenCalledWith(
            {}, 'account-1', 'machine-1', expect.objectContaining({
                failureCode: 'CONNECTOR_RUNTIME_UNAVAILABLE',
                degradedCode: null,
            }),
        );

        const degraded = vi.fn();
        await handlers.get('automation-run-report')!({
            runId: 'run-2', claimToken: 'claim', reportId: 'report-2', status: 'COMPLETED',
            outcome: 'WOKE', sessionId: 'session-1', detailCiphertext: null, failureCode: null,
            degradedCode: 'GRANT_MISSING',
            notificationOnly: true,
            queueDepth: 2, queuePosition: 1, queueTotal: 3, queueEstimatedAt: 1234,
        }, degraded);
        expect(services.reportAutomationRun).toHaveBeenLastCalledWith(
            {}, 'account-1', 'machine-1', expect.objectContaining({
                degradedCode: 'GRANT_MISSING', notificationOnly: true,
                queueDepth: 2, queuePosition: 1, queueTotal: 3,
                queueEstimatedAt: new Date(1234),
            }),
        );

        const rejected = vi.fn();
        await handlers.get('automation-run-report')!({
            runId: 'run-2', claimToken: 'claim', reportId: 'report-2', status: 'FAILED',
            outcome: 'ERROR', sessionId: null, detailCiphertext: null,
            failureCode: 'secret: do not log',
        }, rejected);
        expect(rejected).toHaveBeenCalledWith({ ok: false, error: 'invalid-input' });
    });

    it('binds session follow-up delivery to the authenticated machine socket', async () => {
        const handlers = new Map<string, Function>();
        const socket = { on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)) };
        services.deliverSessionFollowupMessage.mockResolvedValue({
            ok: true,
            value: {
                followup: { projectId: 'project-1', sessionId: 'session-1' },
                idempotent: false,
                messageSeq: 12,
                deliveredMessage: {
                    id: 'message-1', localId: 'local-1',
                    createdAt: new Date(10), updatedAt: new Date(11),
                },
            },
        });
        automationSocketHandler('account-1', 'machine-1', socket as never);
        const callback = vi.fn();
        await handlers.get('session-followup-deliver')!({
            wireVersion: 1,
            followupId: 'followup-1', generation: 2, step: 3, claimToken: 'claim',
            expectedSeq: 11, localId: 'local-1', contentCiphertext: 'AQ==',
            machineId: 'foreign-machine',
        }, callback);
        expect(services.deliverSessionFollowupMessage).toHaveBeenCalledWith(
            {}, 'account-1', 'machine-1', expect.objectContaining({ followupId: 'followup-1' }),
        );
        expect(callback).toHaveBeenCalledWith({ ok: true, value: expect.objectContaining({ messageSeq: 12 }) });
        expect(services.emitSessionFollowupMessageUpdate).toHaveBeenCalledWith({
            userId: 'account-1', sessionId: 'session-1', id: 'message-1', seq: 12,
            localId: 'local-1', contentCiphertext: 'AQ==',
            createdAt: new Date(10), updatedAt: new Date(11),
        });
        expect(services.emitProjectAutomationUpdate).toHaveBeenCalledWith(
            'project-1',
            { projectId: 'project-1', reason: 'sync' },
            'account-1',
        );
    });

    it('rejects follow-up payloads outside the shared versioned wire contract', async () => {
        const handlers = new Map<string, Function>();
        const socket = { on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)) };
        automationSocketHandler('account-1', 'machine-1', socket as never);

        const invalidCiphertext = vi.fn();
        await handlers.get('session-followup-deliver')!({
            wireVersion: 1,
            followupId: 'followup-1', generation: 2, step: 3, claimToken: 'claim',
            expectedSeq: 11, localId: 'local-1', contentCiphertext: 'not base64!',
        }, invalidCiphertext);
        expect(invalidCiphertext).toHaveBeenCalledWith({ ok: false, error: 'invalid-input' });

        const controlPlaneCode = vi.fn();
        await handlers.get('session-followup-evaluate')!({
            wireVersion: 1,
            followupId: 'followup-1', generation: 2, step: 3, claimToken: 'claim',
            decision: 'TERMINATE', observedSeq: 12, terminalCode: 'STOPPED',
        }, controlPlaneCode);
        expect(controlPlaneCode).toHaveBeenCalledWith({ ok: false, error: 'invalid-input' });
        expect(services.deliverSessionFollowupMessage).not.toHaveBeenCalled();
        expect(services.reportSessionFollowupEvaluation).not.toHaveBeenCalled();
    });

    // specs/automation-request-surge R1/R2 — a project-scoped automation change must
    // never be announced as `projectId: null`, which every Desktop client reads as
    // "invalidate every project". The project ids come from the authorized service
    // result, never from the socket payload.
    function bind() {
        const handlers = new Map<string, Function>();
        const socket = { on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)) };
        automationSocketHandler('account-1', 'machine-1', socket as never);
        return handlers;
    }

    it('invalidates only the projects the acknowledgement actually advanced', async () => {
        const handlers = bind();
        services.ackAutomationSync.mockResolvedValue({
            ok: true,
            value: { acknowledged: 2, affectedProjectIds: ['project-1', 'project-2'] },
        });

        await handlers.get('automation-sync-ack')!({
            items: [{ automationId: 'automation-1', revision: 2 }],
            projectId: 'attacker-supplied-project',
        }, vi.fn());

        expect(services.emitAutomationUpdate).not.toHaveBeenCalled();
        expect(services.emitProjectAutomationUpdate.mock.calls).toEqual([
            ['project-1', { projectId: 'project-1', reason: 'sync' }, 'account-1'],
            ['project-2', { projectId: 'project-2', reason: 'sync' }, 'account-1'],
        ]);
    });

    it('emits nothing for an acknowledgement that changed no automation', async () => {
        const handlers = bind();
        services.ackAutomationSync.mockResolvedValue({
            ok: true,
            value: { acknowledged: 0, affectedProjectIds: [] },
        });

        const callback = vi.fn();
        await handlers.get('automation-sync-ack')!({
            items: [{ automationId: 'automation-1', revision: 2 }],
        }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: true, value: { acknowledged: 0, affectedProjectIds: [] } });
        expect(services.emitAutomationUpdate).not.toHaveBeenCalled();
        expect(services.emitProjectAutomationUpdate).not.toHaveBeenCalled();
    });

    it('emits nothing when an acknowledgement fails', async () => {
        const handlers = bind();
        services.ackAutomationSync.mockResolvedValue({ ok: false, error: 'sync-failed' });

        await handlers.get('automation-sync-ack')!({
            items: [{ automationId: 'automation-1', revision: 2 }],
        }, vi.fn());

        expect(services.emitAutomationUpdate).not.toHaveBeenCalled();
        expect(services.emitProjectAutomationUpdate).not.toHaveBeenCalled();
    });

    it('scopes a claimed run to the project the service resolved', async () => {
        const handlers = bind();
        services.claimAutomationRun.mockResolvedValue({
            ok: true,
            value: { runId: 'run-1', claimToken: 'token', projectId: 'project-7' },
        });

        await handlers.get('automation-claim')!({
            automationId: 'automation-1', generation: 3, scheduledFor: 1000,
            projectId: 'attacker-supplied-project',
        }, vi.fn());

        expect(services.emitAutomationUpdate).not.toHaveBeenCalled();
        expect(services.emitProjectAutomationUpdate).toHaveBeenCalledWith(
            'project-7',
            { projectId: 'project-7', automationId: 'automation-1', reason: 'run' },
            'account-1',
        );
    });

    it('scopes a started run to the project the service resolved', async () => {
        const handlers = bind();
        services.startAutomationRun.mockResolvedValue({
            ok: true,
            value: { runLeaseExpiresAt: new Date(10), projectId: 'project-7' },
        });

        await handlers.get('automation-run-start')!({ runId: 'run-1', claimToken: 'token' }, vi.fn());

        expect(services.emitAutomationUpdate).not.toHaveBeenCalled();
        expect(services.emitProjectAutomationUpdate).toHaveBeenCalledWith(
            'project-7',
            { projectId: 'project-7', runId: 'run-1', reason: 'run' },
            'account-1',
        );
    });

    it('scopes a reported run to its project and stays silent on an idempotent replay', async () => {
        const handlers = bind();
        services.reportAutomationRun.mockResolvedValue({
            ok: true, value: { idempotent: false, projectId: 'project-7' },
        });
        const report = {
            runId: 'run-1', claimToken: 'token', reportId: 'report-1', status: 'FAILED',
            outcome: 'ERROR', sessionId: null, detailCiphertext: null,
            failureCode: 'TOOL_INVENTORY_EMPTY',
        };

        await handlers.get('automation-run-report')!(report, vi.fn());
        expect(services.emitProjectAutomationUpdate).toHaveBeenCalledWith(
            'project-7',
            { projectId: 'project-7', runId: 'run-1', reason: 'run' },
            'account-1',
        );

        services.emitProjectAutomationUpdate.mockClear();
        services.emitAutomationUpdate.mockClear();
        services.reportAutomationRun.mockResolvedValue({
            ok: true, value: { idempotent: true, projectId: 'project-7' },
        });

        await handlers.get('automation-run-report')!(report, vi.fn());
        expect(services.emitProjectAutomationUpdate).not.toHaveBeenCalled();
        expect(services.emitAutomationUpdate).not.toHaveBeenCalled();
    });

    it('keeps the machine-key rotation account-wide', async () => {
        const handlers = bind();
        services.registerAutomationMachineKey.mockResolvedValue({
            ok: true, value: { keyVersion: 4, invalidatedProjectIds: [], targetChanged: true },
        });

        await handlers.get('automation-key-register')!({
            expectedKeyVersion: 3,
            publicKey: Buffer.from(new Uint8Array(32)).toString('base64'),
        }, vi.fn());

        expect(services.emitAutomationUpdate).toHaveBeenCalledWith(
            'account-1', { projectId: null, reason: 'machine-key' },
        );
    });

    // 데몬은 소켓에 붙을 때마다 같은 키를 다시 등록한다. 계정 전체 이벤트는 그 계정의 모든
    // Desktop 이 전 프로젝트를 다시 읽게 하므로, CLI 일괄 업데이트처럼 데몬 여러 대가
    // 재접속하는 구간에 요청 폭주를 만든다 — 대상이 실제로 바뀐 경우에만 보낸다.
    it('stays silent account-wide when a reconnecting daemon re-registers an unchanged key', async () => {
        const handlers = bind();
        services.registerAutomationMachineKey.mockResolvedValue({
            ok: true, value: { keyVersion: 4, invalidatedProjectIds: ['project-1'], targetChanged: false },
        });
        const callback = vi.fn();

        await handlers.get('automation-key-register')!({
            expectedKeyVersion: 4,
            publicKey: Buffer.from(new Uint8Array(32)).toString('base64'),
        }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: true, value: expect.objectContaining({ keyVersion: 4 }) });
        expect(services.emitAutomationUpdate).not.toHaveBeenCalled();
        expect(services.emitProjectAutomationUpdate).toHaveBeenCalledWith(
            'project-1', { projectId: 'project-1', reason: 'sync' }, 'account-1',
        );
    });

});
