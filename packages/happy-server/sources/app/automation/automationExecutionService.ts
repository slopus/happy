import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Prisma, type AutomationRunOutcome, type Prisma as PrismaTypes } from '@prisma/client';
import { AUTOMATION_SESSION_FOLLOWUP_PROTOCOL_VERSION } from '@slopus/happy-wire';
import { invalidateSessionFollowups } from './sessionFollowupInvalidationService';

type Tx = PrismaTypes.TransactionClient;
type Binary = Uint8Array<ArrayBuffer>;

export type AutomationExecutionError =
    | 'key-version-conflict'
    | 'sync-failed'
    | 'claim-denied'
    | 'already-claimed'
    | 'active-run'
    | 'claim-not-found'
    | 'claim-cancelled'
    | 'claim-expired'
    | 'run-not-running'
    | 'report-conflict';

type Result<T> = { ok: true; value: T } | { ok: false; error: AutomationExecutionError };

function tokenHash(token: string): Binary {
    return new Uint8Array(createHash('sha256').update(token).digest());
}

export async function registerAutomationMachineKey(
    tx: Tx,
    accountId: string,
    machineId: string,
    input: { expectedKeyVersion: number; publicKey: Binary; protocolVersion: number },
): Promise<Result<{ keyVersion: number; invalidatedProjectIds: string[]; targetChanged: boolean }>> {
    const current = await tx.machine.findFirst({
        where: { id: machineId, accountId },
        select: {
            automationPublicKey: true,
            automationKeyVersion: true,
            automationProtocolVersion: true,
        },
    });
    if (current?.automationPublicKey
        && Buffer.from(current.automationPublicKey).equals(Buffer.from(input.publicKey))) {
        // 데몬은 재접속마다 같은 키를 다시 등록한다. 키도 프로토콜도 그대로면 target 은
        // 바뀌지 않았으므로 호출자가 계정 전체 무효화를 보내지 않게 알린다.
        const protocolChanged = current.automationProtocolVersion !== input.protocolVersion;
        if (protocolChanged) {
            const changed = await tx.machine.updateMany({
                where: { id: machineId, accountId, automationKeyVersion: current.automationKeyVersion },
                data: { automationProtocolVersion: input.protocolVersion },
            });
            if (changed.count === 0) return { ok: false, error: 'key-version-conflict' };
        }
        const invalidated = input.protocolVersion < AUTOMATION_SESSION_FOLLOWUP_PROTOCOL_VERSION
            ? await invalidateSessionFollowups(
                tx,
                { machineAccountId: accountId, machineId },
                'TARGET_MISMATCH',
            )
            : [];
        return {
            ok: true,
            value: {
                keyVersion: current.automationKeyVersion,
                invalidatedProjectIds: [...new Set(invalidated.map((followup) => followup.projectId as string))],
                targetChanged: protocolChanged,
            },
        };
    }
    const changed = await tx.machine.updateMany({
        where: { id: machineId, accountId, automationKeyVersion: input.expectedKeyVersion },
        data: {
            automationPublicKey: input.publicKey,
            automationKeyVersion: { increment: 1 },
            automationProtocolVersion: input.protocolVersion,
        },
    });
    if (changed.count === 0) return { ok: false, error: 'key-version-conflict' };
    const invalidated = await invalidateSessionFollowups(
        tx,
        { machineAccountId: accountId, machineId },
        'DECRYPT_FAILED',
    );
    return {
        ok: true,
        value: {
            keyVersion: input.expectedKeyVersion + 1,
            invalidatedProjectIds: [...new Set(invalidated.map((followup) => followup.projectId as string))],
            targetChanged: true,
        },
    };
}

export async function syncAutomations(
    tx: Tx,
    accountId: string,
    machineId: string,
    input: { afterSeq: bigint; limit: number },
    now: Date = new Date(),
): Promise<Result<{ serverTime: Date; nextSeq: bigint; changes: Array<Record<string, unknown>> }>> {
    const rows = await tx.automationChange.findMany({
        where: { machineAccountId: accountId, machineId, seq: { gt: input.afterSeq } },
        orderBy: { seq: 'asc' },
        take: input.limit,
    });
    const changes: Array<Record<string, unknown>> = [];
    for (const change of rows) {
        if (change.kind === 'TOMBSTONE') {
            changes.push({ seq: change.seq, automationId: change.automationId, revision: change.revision, generation: change.generation, kind: 'TOMBSTONE' });
            continue;
        }
        const automation = await tx.automation.findFirst({
            where: {
                id: change.automationId,
                machineAccountId: accountId,
                machineId,
                deletedAt: null,
                revision: { gte: change.revision },
            },
        });
        if (!automation || automation.payloadVersion === 3) {
            changes.push({ seq: change.seq, automationId: change.automationId, revision: change.revision, generation: change.generation, kind: 'TOMBSTONE' });
            continue;
        }
        changes.push({
            seq: change.seq,
            automationId: automation.id,
            revision: automation.revision,
            generation: automation.generation,
            kind: 'UPSERT',
            payloadVersion: automation.payloadVersion,
            payloadCiphertext: automation.payloadCiphertext,
            machineKeyVersion: automation.machineKeyVersion,
            machineKeyEnvelope: automation.machineKeyEnvelope,
            paused: automation.paused,
            migrationPending: automation.legacyMigrationPending,
            enabledAt: automation.enabledAt,
            runRequestedAt: automation.runRequestedAt,
        });
    }
    return {
        ok: true,
        value: {
            serverTime: now,
            nextSeq: rows.length > 0 ? rows[rows.length - 1]!.seq : input.afterSeq,
            changes,
        },
    };
}

export async function ackAutomationSync(
    tx: Tx,
    accountId: string,
    machineId: string,
    items: Array<{ automationId: string; revision: number }>,
    now: Date = new Date(),
): Promise<Result<{ acknowledged: number; affectedProjectIds: string[] }>> {
    let acknowledged = 0;
    // specs/automation-request-surge — only the automations whose applied revision
    // actually advanced are worth announcing. A daemon re-acking what it already
    // acked changes nothing, so it must produce no invalidation at all.
    const advancedAutomationIds = new Set<string>();
    for (const item of items) {
        const changed = await tx.automation.updateMany({
            where: {
                id: item.automationId,
                machineAccountId: accountId,
                machineId,
                revision: item.revision,
                appliedRevision: { lt: item.revision },
            },
            data: { appliedRevision: item.revision, appliedAt: now },
        });
        acknowledged += changed.count;
        if (changed.count > 0) advancedAutomationIds.add(item.automationId);
    }
    if (advancedAutomationIds.size === 0) {
        return { ok: true, value: { acknowledged, affectedProjectIds: [] } };
    }
    // The project ids come from the rows this machine is allowed to touch, never
    // from the acknowledgement payload.
    const rows = await tx.automation.findMany({
        where: {
            id: { in: [...advancedAutomationIds] },
            machineAccountId: accountId,
            machineId,
        },
        select: { projectId: true },
    });
    return {
        ok: true,
        value: { acknowledged, affectedProjectIds: [...new Set(rows.map((row) => row.projectId))] },
    };
}

function executable(automation: any, accountId: string, machineId: string, generation: number): boolean {
    return automation
        && automation.payloadVersion !== 3
        && automation.machineAccountId === accountId
        && automation.machineId === machineId
        && automation.generation === generation
        && !automation.paused
        && !automation.legacyMigrationPending
        && !automation.deletedAt
        && automation.machineKeyVersion === automation.targetMachine?.automationKeyVersion
        && automation.viewerKeyVersion === automation.project?.automationViewerKeyVersion;
}

const AUTOMATION_RUN_NOW_MAX_AGE_MS = 15 * 60_000;

export async function claimAutomationRun(
    tx: Tx,
    accountId: string,
    machineId: string,
    input: { automationId: string; generation: number; scheduledFor: Date },
    now: Date = new Date(),
): Promise<Result<{ runId: string; claimToken: string; claimExpiresAt: Date; serverTime: Date; projectId: string }>> {
    const automation = await tx.automation.findFirst({
        where: { id: input.automationId, machineAccountId: accountId, machineId, deletedAt: null },
        include: {
            project: { select: { automationViewerKeyVersion: true } },
            targetMachine: { select: { automationKeyVersion: true } },
        },
    });
    const inClaimWindow = input.scheduledFor.getTime() >= now.getTime() - 90_000
        && input.scheduledFor.getTime() <= now.getTime() + 15_000;
    const durableRunNowRequest = automation?.runRequestedAt?.getTime() === input.scheduledFor.getTime()
        && input.scheduledFor.getTime() >= now.getTime() - AUTOMATION_RUN_NOW_MAX_AGE_MS;
    if (!inClaimWindow && !durableRunNowRequest) return { ok: false, error: 'claim-denied' };
    if (!automation || !executable(automation, accountId, machineId, input.generation)
        || input.scheduledFor < automation.enabledAt) {
        return { ok: false, error: 'claim-denied' };
    }

    await tx.automationRun.updateMany({
        where: { automationId: input.automationId, status: 'CLAIMED', claimExpiresAt: { lt: now } },
        data: { status: 'EXPIRED', completedAt: now },
    });
    await tx.automationRun.updateMany({
        where: { automationId: input.automationId, status: 'RUNNING', runLeaseExpiresAt: { lt: now } },
        data: { status: 'ABANDONED', completedAt: now },
    });

    const claimToken = randomBytes(32).toString('base64url');
    const claimExpiresAt = new Date(now.getTime() + 2 * 60_000);
    const runId = randomUUID();
    const created = await tx.automationRun.createMany({
        data: [{
            id: runId,
            automationId: automation.id,
            generation: input.generation,
            scheduledFor: input.scheduledFor,
            machineAccountId: accountId,
            machineId,
            status: 'CLAIMED',
            claimTokenHash: tokenHash(claimToken),
            claimExpiresAt,
        }],
        skipDuplicates: true,
    });
    if (created.count === 0) {
        const sameSlot = await tx.automationRun.findFirst({
            where: {
                automationId: automation.id,
                generation: input.generation,
                scheduledFor: input.scheduledFor,
            },
            select: { id: true },
        });
        return sameSlot
            ? { ok: false, error: 'already-claimed' }
            : { ok: false, error: 'active-run' };
    }
    return { ok: true, value: { runId, claimToken, claimExpiresAt, serverTime: now, projectId: automation.projectId } };
}

async function claimedRun(tx: Tx, accountId: string, machineId: string, runId: string, claimToken: string) {
    return tx.automationRun.findFirst({
        where: { id: runId, machineAccountId: accountId, machineId, claimTokenHash: tokenHash(claimToken) },
        include: {
            automation: {
                include: {
                    project: { select: { automationViewerKeyVersion: true } },
                    targetMachine: { select: { automationKeyVersion: true } },
                },
            },
        },
    });
}

export async function startAutomationRun(
    tx: Tx,
    accountId: string,
    machineId: string,
    input: { runId: string; claimToken: string },
    now: Date = new Date(),
): Promise<Result<{ runLeaseExpiresAt: Date; projectId: string }>> {
    const run = await claimedRun(tx, accountId, machineId, input.runId, input.claimToken);
    if (!run) return { ok: false, error: 'claim-not-found' };
    if (run.status !== 'CLAIMED') return { ok: false, error: 'claim-cancelled' };
    if (run.claimExpiresAt < now) {
        await tx.automationRun.updateMany({ where: { id: run.id, status: 'CLAIMED' }, data: { status: 'EXPIRED', completedAt: now } });
        return { ok: false, error: 'claim-expired' };
    }
    if (!executable(run.automation, accountId, machineId, run.generation)) {
        await tx.automationRun.updateMany({ where: { id: run.id, status: 'CLAIMED' }, data: { status: 'CANCELLED', completedAt: now } });
        return { ok: false, error: 'claim-cancelled' };
    }
    const runLeaseExpiresAt = new Date(now.getTime() + 5 * 60_000);
    const changed = await tx.automationRun.updateMany({
        where: { id: run.id, status: 'CLAIMED' },
        data: { status: 'RUNNING', startedAt: now, runLeaseExpiresAt },
    });
    return changed.count === 1
        ? { ok: true, value: { runLeaseExpiresAt, projectId: run.automation.projectId } }
        : { ok: false, error: 'claim-cancelled' };
}

export async function resolveAutomationRunMcpContext(
    tx: Tx,
    accountId: string,
    machineId: string,
    input: { runId: string; claimToken: string; sessionId?: string },
    now: Date = new Date(),
): Promise<Result<{
    automationId: string;
    ownerAccountId: string;
    projectId: string;
    machineId: string;
    runLeaseExpiresAt: number | null;
}>> {
    const run = await claimedRun(tx, accountId, machineId, input.runId, input.claimToken);
    if (!run) return { ok: false, error: 'claim-not-found' };
    const activelyRunning = run.status === 'RUNNING'
        && run.runLeaseExpiresAt !== null
        && run.runLeaseExpiresAt >= now;
    if (input.sessionId) {
        const terminalSessionMatch = run.status === 'COMPLETED'
            && run.reportId !== null
            && run.sessionId === input.sessionId;
        if (!terminalSessionMatch) {
            return { ok: false, error: 'run-not-running' };
        }
        const session = await tx.session.findFirst({
            where: { id: input.sessionId, accountId },
            select: { id: true },
        });
        if (!session) return { ok: false, error: 'claim-not-found' };
    } else if (!activelyRunning) {
        return { ok: false, error: 'run-not-running' };
    }
    return {
        ok: true,
        value: {
            automationId: run.automationId,
            ownerAccountId: run.automation.ownerAccountId,
            projectId: run.automation.projectId,
            machineId: run.machineId,
            runLeaseExpiresAt: activelyRunning ? run.runLeaseExpiresAt!.getTime() : null,
        },
    };
}

export async function heartbeatAutomationRun(
    tx: Tx,
    accountId: string,
    machineId: string,
    input: { runId: string; claimToken: string },
    now: Date = new Date(),
): Promise<Result<{ runLeaseExpiresAt: Date }>> {
    const runLeaseExpiresAt = new Date(now.getTime() + 5 * 60_000);
    const changed = await tx.automationRun.updateMany({
        where: {
            id: input.runId,
            machineAccountId: accountId,
            machineId,
            claimTokenHash: tokenHash(input.claimToken),
            status: 'RUNNING',
            runLeaseExpiresAt: { gte: now },
        },
        data: { runLeaseExpiresAt },
    });
    return changed.count === 1
        ? { ok: true, value: { runLeaseExpiresAt } }
        : { ok: false, error: 'run-not-running' };
}

export async function reportAutomationRun(
    tx: Tx,
    accountId: string,
    machineId: string,
    input: {
        runId: string;
        claimToken: string;
        reportId: string;
        status: 'COMPLETED' | 'FAILED';
        outcome: AutomationRunOutcome;
        sessionId: string | null;
        detailCiphertext: Binary | null;
        failureCode: string | null;
        degradedCode?: string | null;
        notificationOnly?: boolean;
        queueDepth?: number | null;
        queuePosition?: number | null;
        queueTotal?: number | null;
        queueEstimatedAt?: Date | null;
    },
    now: Date = new Date(),
): Promise<Result<{ idempotent: boolean; status: string; outcome: AutomationRunOutcome | null; projectId: string }>> {
    const run = await claimedRun(tx, accountId, machineId, input.runId, input.claimToken);
    if (!run) return { ok: false, error: 'claim-not-found' };
    if (run.reportId) {
        return run.reportId === input.reportId
            ? {
                ok: true,
                value: {
                    idempotent: true, status: run.status, outcome: run.outcome,
                    projectId: run.automation.projectId,
                },
            }
            : { ok: false, error: 'report-conflict' };
    }
    if (run.status !== 'RUNNING' && run.status !== 'ABANDONED') {
        return { ok: false, error: 'run-not-running' };
    }
    if ((input.status === 'FAILED') !== (input.outcome === 'ERROR')) {
        return { ok: false, error: 'report-conflict' };
    }
    if (input.outcome !== 'ERROR' && input.failureCode !== null) {
        return { ok: false, error: 'report-conflict' };
    }
    const degradedCode = input.degradedCode ?? null;
    const queueDepth = input.queueDepth ?? null;
    const queuePosition = input.queuePosition ?? null;
    const queueTotal = input.queueTotal ?? null;
    const queueEstimatedAt = input.queueEstimatedAt ?? null;
    if ((queuePosition === null) !== (queueTotal === null)
        || (queuePosition !== null && queueTotal !== null && queuePosition > queueTotal)
        || (queueDepth !== null && queueTotal !== null && queueDepth > queueTotal)) {
        return { ok: false, error: 'report-conflict' };
    }
    if (input.outcome !== 'WOKE' && degradedCode !== null) {
        return { ok: false, error: 'report-conflict' };
    }
    const notifyOnlyGithubRun = input.notificationOnly === true
        || (input.notificationOnly === undefined && input.outcome === 'WOKE' && queueDepth !== null);
    if (input.notificationOnly === true && (input.outcome !== 'WOKE' || input.sessionId !== null)) {
        return { ok: false, error: 'report-conflict' };
    }
    if ((input.outcome === 'WOKE' || input.outcome === 'SILENT') && !input.sessionId && !notifyOnlyGithubRun) {
        return { ok: false, error: 'report-conflict' };
    }
    if (input.sessionId) {
        const session = await tx.session.findFirst({
            where: { id: input.sessionId, accountId },
            select: { id: true },
        });
        if (!session) return { ok: false, error: 'report-conflict' };
    }
    let changed;
    try {
        changed = await tx.automationRun.updateMany({
            where: { id: run.id, reportId: null, status: { in: ['RUNNING', 'ABANDONED'] } },
            data: {
                reportId: input.reportId,
                status: input.status,
                outcome: input.outcome,
                sessionId: input.sessionId,
                detailCiphertext: input.detailCiphertext,
                failureCode: input.failureCode,
                degradedCode,
                queueDepth,
                queuePosition,
                queueTotal,
                queueEstimatedAt,
                completedAt: now,
                lateReport: run.status === 'ABANDONED'
                    || (run.runLeaseExpiresAt !== null && run.runLeaseExpiresAt < now),
            },
        });
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            return { ok: false, error: 'report-conflict' };
        }
        throw error;
    }
    return changed.count === 1
        ? {
            ok: true,
            value: {
                idempotent: false, status: input.status, outcome: input.outcome,
                projectId: run.automation.projectId,
            },
        }
        : { ok: false, error: 'report-conflict' };
}
