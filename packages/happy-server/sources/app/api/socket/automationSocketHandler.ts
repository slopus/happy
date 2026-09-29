import type { Socket } from 'socket.io';
import {
    ackAutomationSync,
    claimAutomationRun,
    heartbeatAutomationRun,
    registerAutomationMachineKey,
    reportAutomationRun,
    startAutomationRun,
    syncAutomations,
} from '@/app/automation/automationExecutionService';
import { inTx } from '@/storage/inTx';
import { isServerBackedAutomationEnabled } from '@/app/automation/automationRollout';
import { emitAutomationUpdate, emitProjectAutomationUpdate } from '@/app/automation/automationUpdate';
import {
    claimSessionFollowup,
    deliverSessionFollowupMessage,
    reportSessionFollowupEvaluation,
    syncSessionFollowups,
} from '@/app/automation/sessionFollowupExecutionService';
import { emitSessionFollowupMessageUpdate } from '@/app/automation/sessionFollowupUpdate';
import {
    sessionFollowupClaimRequestSchema,
    sessionFollowupDeliverRequestSchema,
    sessionFollowupEvaluationRequestSchema,
    sessionFollowupSyncRequestSchema,
} from '@slopus/happy-wire';

type Callback = (response: { ok: boolean; value?: unknown; error?: string }) => void;

function requiredString(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) throw new Error('invalid-input');
    return value;
}

function integer(value: unknown, min: number, max: number): number {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error('invalid-input');
    return value as number;
}

function bytes(value: unknown, maxBytes: number, exactBytes?: number): Uint8Array<ArrayBuffer> {
    const raw = new Uint8Array(Buffer.from(requiredString(value), 'base64'));
    if (raw.byteLength > maxBytes || (exactBytes !== undefined && raw.byteLength !== exactBytes)) throw new Error('invalid-input');
    return raw;
}

function wire(value: unknown): unknown {
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Date) return value.getTime();
    if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
    if (Array.isArray(value)) return value.map(wire);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wire(item)]));
    }
    return value;
}

async function answer(
    callback: Callback,
    operation: () => Promise<{ ok: boolean; value?: unknown; error?: string }>,
    onSuccess?: (value: unknown) => Promise<void>,
) {
    try {
        const result = await operation();
        if (result.ok && onSuccess) await onSuccess(result.value);
        callback(result.ok ? { ok: true, value: wire(result.value) } : { ok: false, error: result.error });
    } catch {
        callback({ ok: false, error: 'invalid-input' });
    }
}

export function automationSocketHandler(accountId: string, machineId: string, socket: Socket): void {
    const on = (event: string, handler: (data: any, callback: Callback) => Promise<void>) => (socket as any).on(
        event,
        async (data: any, callback: Callback) => {
            if (!isServerBackedAutomationEnabled()) {
                callback({ ok: false, error: 'feature-disabled' });
                return;
            }
            await handler(data, callback);
        },
    );

    on('automation-key-register', async (data, callback) => answer(callback, () => inTx((tx) => registerAutomationMachineKey(tx, accountId, machineId, {
        expectedKeyVersion: integer(data?.expectedKeyVersion, 0, Number.MAX_SAFE_INTEGER),
        publicKey: bytes(data?.publicKey, 32, 32),
        protocolVersion: data?.protocolVersion === undefined
            ? 1
            : integer(data.protocolVersion, 1, Number.MAX_SAFE_INTEGER),
    })), async (value) => {
        const result = value as { invalidatedProjectIds?: string[]; targetChanged?: boolean };
        // 계정 전체 이벤트는 그 계정의 모든 Desktop 이 전 프로젝트를 다시 읽게 한다. 재접속한
        // 데몬의 같은 키 재등록까지 보내면 CLI 일괄 업데이트 때 요청이 폭주한다.
        if (result.targetChanged) await emitAutomationUpdate(accountId, { projectId: null, reason: 'machine-key' });
        await Promise.all((result.invalidatedProjectIds ?? []).map((projectId) =>
            emitProjectAutomationUpdate(projectId, { projectId, reason: 'sync' }, accountId),
        ));
    }));

    on('automation-sync', async (data, callback) => answer(callback, () => {
        const afterSeq = BigInt(requiredString(data?.afterSeq));
        if (afterSeq < 0n) throw new Error('invalid-input');
        return inTx((tx) => syncAutomations(tx, accountId, machineId, {
            afterSeq,
            limit: integer(data?.limit, 1, 500),
        }));
    }));

    on('automation-sync-ack', async (data, callback) => answer(callback, () => {
        if (!Array.isArray(data?.items) || data.items.length > 500) throw new Error('invalid-input');
        const items = data.items.map((item: any) => ({
            automationId: requiredString(item?.automationId),
            revision: integer(item?.revision, 1, Number.MAX_SAFE_INTEGER),
        }));
        return inTx((tx) => ackAutomationSync(tx, accountId, machineId, items));
    }, async (value) => {
        // specs/automation-request-surge — an acknowledgement that advanced nothing
        // announces nothing, and one that did announces only its own projects.
        const { affectedProjectIds } = value as { affectedProjectIds: string[] };
        await Promise.all(affectedProjectIds.map((projectId) =>
            emitProjectAutomationUpdate(projectId, { projectId, reason: 'sync' }, accountId),
        ));
    }));

    on('automation-claim', async (data, callback) => answer(callback, () => inTx((tx) => claimAutomationRun(tx, accountId, machineId, {
        automationId: requiredString(data?.automationId),
        generation: integer(data?.generation, 1, Number.MAX_SAFE_INTEGER),
        scheduledFor: new Date(integer(data?.scheduledFor, 0, Number.MAX_SAFE_INTEGER)),
    })), (value) => {
        const { projectId } = value as { projectId: string };
        return emitProjectAutomationUpdate(projectId, {
            projectId,
            automationId: requiredString(data?.automationId),
            reason: 'run',
        }, accountId);
    }));

    on('automation-run-start', async (data, callback) => answer(callback, () => inTx((tx) => startAutomationRun(tx, accountId, machineId, {
        runId: requiredString(data?.runId), claimToken: requiredString(data?.claimToken),
    })), (value) => {
        const { projectId } = value as { projectId: string };
        return emitProjectAutomationUpdate(projectId, {
            projectId,
            runId: requiredString(data?.runId),
            reason: 'run',
        }, accountId);
    }));

    on('automation-run-heartbeat', async (data, callback) => answer(callback, () => inTx((tx) => heartbeatAutomationRun(tx, accountId, machineId, {
        runId: requiredString(data?.runId), claimToken: requiredString(data?.claimToken),
    }))));

    on('automation-run-report', async (data, callback) => answer(callback, () => {
        const status = data?.status === 'COMPLETED' || data?.status === 'FAILED' ? data.status : null;
        const outcomes = ['WOKE', 'SILENT', 'SKIPPED_GATE', 'ERROR'] as const;
        const outcome = outcomes.find((candidate) => candidate === data?.outcome);
        if (!status || !outcome) throw new Error('invalid-input');
        const failureCode = data?.failureCode === null || data?.failureCode === undefined
            ? null
            : typeof data?.failureCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(data.failureCode)
                ? data.failureCode
                : (() => { throw new Error('invalid-input'); })();
        const degradedCode = data?.degradedCode === null || data?.degradedCode === undefined
            ? null
            : typeof data?.degradedCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(data.degradedCode)
                ? data.degradedCode
                : (() => { throw new Error('invalid-input'); })();
        return inTx((tx) => reportAutomationRun(tx, accountId, machineId, {
            runId: requiredString(data?.runId),
            claimToken: requiredString(data?.claimToken),
            reportId: requiredString(data?.reportId),
            status,
            outcome,
            sessionId: data?.sessionId === null ? null : requiredString(data?.sessionId),
            detailCiphertext: data?.detailCiphertext === null ? null : bytes(data?.detailCiphertext, 128 * 1024),
            failureCode,
            degradedCode,
            notificationOnly: data?.notificationOnly === undefined
                ? undefined
                : typeof data.notificationOnly === 'boolean'
                    ? data.notificationOnly
                    : (() => { throw new Error('invalid-input'); })(),
            queueDepth: data?.queueDepth === null || data?.queueDepth === undefined
                ? null
                : integer(data.queueDepth, 0, 10_000),
            queuePosition: data?.queuePosition === null || data?.queuePosition === undefined
                ? null
                : integer(data.queuePosition, 0, 10_000),
            queueTotal: data?.queueTotal === null || data?.queueTotal === undefined
                ? null
                : integer(data.queueTotal, 0, 10_000),
            queueEstimatedAt: data?.queueEstimatedAt === null || data?.queueEstimatedAt === undefined
                ? null
                : new Date(integer(data.queueEstimatedAt, 0, Number.MAX_SAFE_INTEGER)),
        }));
    }, async (value) => {
        // A replayed report is the same terminal state the clients already have.
        const { idempotent, projectId } = value as { idempotent: boolean; projectId: string };
        if (idempotent) return;
        await emitProjectAutomationUpdate(projectId, {
            projectId,
            runId: requiredString(data?.runId),
            reason: 'run',
        }, accountId);
    }));

    on('session-followup-sync', async (data, callback) => answer(callback, () => {
        const input = sessionFollowupSyncRequestSchema.parse(data);
        return inTx((tx) => syncSessionFollowups(tx, accountId, machineId, {
            afterSeq: BigInt(input.afterSeq),
            limit: input.limit,
        }));
    }));

    on('session-followup-claim', async (data, callback) => answer(callback, () => {
        const input = sessionFollowupClaimRequestSchema.parse(data);
        return inTx((tx) => claimSessionFollowup(tx, accountId, machineId, {
            followupId: input.followupId,
            generation: input.generation,
            step: input.step,
        }));
    }));

    on('session-followup-evaluate', async (data, callback) => answer(callback, () => {
        const input = sessionFollowupEvaluationRequestSchema.parse(data);
        return inTx((tx) => reportSessionFollowupEvaluation(tx, accountId, machineId, {
            followupId: input.followupId,
            generation: input.generation,
            step: input.step,
            claimToken: input.claimToken,
            decision: input.decision,
            observedSeq: input.observedSeq,
            ...(input.terminalCode ? { terminalCode: input.terminalCode } : {}),
        }));
    }, (value) => {
        const followup = value as { projectId?: string };
        return followup.projectId
            ? emitProjectAutomationUpdate(
                followup.projectId,
                { projectId: followup.projectId, reason: 'sync' },
                accountId,
            )
            : emitAutomationUpdate(accountId, { projectId: null, reason: 'sync' });
    }));

    on('session-followup-deliver', async (data, callback) => answer(callback, () => {
        const input = sessionFollowupDeliverRequestSchema.parse(data);
        return inTx((tx) => deliverSessionFollowupMessage(tx, accountId, machineId, {
            followupId: input.followupId,
            generation: input.generation,
            step: input.step,
            claimToken: input.claimToken,
            expectedSeq: input.expectedSeq,
            localId: input.localId,
            contentCiphertext: input.contentCiphertext,
        }));
    }, async (value) => {
        const result = value as {
            messageSeq?: number | null;
            deliveredMessage?: {
                id: string;
                localId: string | null;
                createdAt: Date;
                updatedAt: Date;
            } | null;
            followup?: { projectId?: string; sessionId?: string };
        };
        if (result.followup?.projectId) {
            await emitProjectAutomationUpdate(
                result.followup.projectId,
                { projectId: result.followup.projectId, reason: 'sync' },
                accountId,
            );
        } else {
            await emitAutomationUpdate(accountId, { projectId: null, reason: 'sync' });
        }
        if (result.deliveredMessage && result.messageSeq !== null && result.messageSeq !== undefined
            && result.followup?.sessionId) {
            await emitSessionFollowupMessageUpdate({
                userId: accountId,
                sessionId: result.followup.sessionId,
                seq: result.messageSeq,
                contentCiphertext: requiredString(data?.contentCiphertext),
                ...result.deliveredMessage,
            });
        }
    }));
}
