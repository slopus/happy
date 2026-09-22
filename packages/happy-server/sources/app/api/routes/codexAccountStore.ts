import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CodexAccountProfile, CodexQuotaSnapshot, Machine, Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/storage/db';
import { decryptString, encryptString } from '@/modules/encrypt';
import {
    CODEX_AUTH_MAX_BYTES, CODEX_GRANT_TTL_MS, codexAuthSchema,
    type CodexAuth, type CodexAccountProfileView, type CodexMachineBinding, type CodexQuotaView,
    type BindCodexAccountRequest, type UpdateCodexCredentialRequest, type ReportCodexQuotaRequest, type ReportCodexQuotaProbeRequest, type ReportCodexStatusRequest,
    type CreateCodexGrantResponse, type RedeemCodexGrantResponse, type ListCodexAccountsResponse,
} from './codexAccountTypes';

type Tx = Prisma.TransactionClient;
export class CodexAccountError extends Error {
    constructor(public readonly status: number, public readonly code: string) { super(code); }
}
const fail = (status: number, code: string): never => { throw new CodexAccountError(status, code); };
const path = (accountId: string, profileId: string) => ['user', accountId, 'codex-accounts', profileId, 'credential'];
const digest = (grant: string) => createHash('sha256').update(grant).digest('hex');
function fingerprint(accountId: string, auth: CodexAuth): string {
    const secret = process.env.HANDY_MASTER_SECRET;
    if (!secret) throw new Error('Missing server encryption configuration');
    return createHmac('sha256', secret).update(JSON.stringify(['paws-codex-account-v1', accountId, auth.tokens.account_id])).digest('hex');
}

// One account row lock orders profile, binding, deletion, redeem and refresh
// mutations together. This prevents a valid grant read racing a binding change.
async function transaction<T>(accountId: string, operation: (tx: Tx) => Promise<T>): Promise<T> {
    return db.$transaction(async (tx) => {
        const owners = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Account" WHERE "id" = ${accountId} FOR UPDATE`;
        if (!owners.length) return fail(409, 'account-unavailable');
        return operation(tx);
    });
}
async function audit(tx: Tx, accountId: string, action: string, profileId?: string, machineId?: string, credentialVersion?: number) {
    await tx.codexAccountAudit.create({ data: { accountId, action, profileId, machineId, credentialVersion } });
}
function quotaView(quota: CodexQuotaSnapshot | null | undefined, now = Date.now()): CodexQuotaView {
    if (!quota) return { state: 'unknown', remainingPercent: null, weeklyResetsAt: null, observedAt: null };
    const reset = quota.weeklyResetsAt.getTime() <= now;
    return {
        state: reset ? 'reset' : now - quota.observedAt.getTime() > 86400_000 ? 'stale' : 'current',
        remainingPercent: reset ? null : Math.round(100 - quota.weeklyUsedPercent),
        weeklyResetsAt: quota.weeklyResetsAt.toISOString(), observedAt: quota.observedAt.toISOString(),
    };
}
function profileView(profile: CodexAccountProfile & { quota?: CodexQuotaSnapshot | null }): CodexAccountProfileView {
    return {
        id: profile.id, displayName: profile.displayName,
        status: profile.status === 'available' || profile.status === 'needs-refresh' ? profile.status : 'invalid',
        credentialVersion: profile.credentialVersion, createdAt: profile.createdAt.toISOString(), updatedAt: profile.updatedAt.toISOString(),
        lastValidatedAt: profile.lastValidatedAt?.toISOString() ?? null, quota: quotaView(profile.quota),
    };
}
function bindingView(machine: Machine): CodexMachineBinding {
    return { machineId: machine.id, profileId: machine.defaultCodexAccountProfileId, version: machine.codexAccountBindingVersion };
}
async function ownedProfile(tx: Tx, accountId: string, id: string) {
    return await tx.codexAccountProfile.findFirst({ where: { accountId, id }, include: { quota: true } }) ?? fail(404, 'profile-not-found');
}
async function ownedMachine(tx: Tx, accountId: string, id: string) {
    return await tx.machine.findFirst({ where: { accountId, id } }) ?? fail(404, 'machine-not-found');
}

async function saveUpload(tx: Tx, accountId: string, auth: CodexAuth) {
    const externalAccountFingerprint = fingerprint(accountId, auth);
    const previous = await tx.codexAccountProfile.findUnique({ where: { accountId_externalAccountFingerprint: { accountId, externalAccountFingerprint } } });
    const id = previous?.id ?? randomUUID();
    const credential = encryptString(path(accountId, id), JSON.stringify(auth));
    if (previous) {
        const changed = await tx.codexAccountProfile.updateMany({ where: { id, accountId, credentialVersion: previous.credentialVersion }, data: { credential, credentialVersion: { increment: 1 }, status: 'available', lastValidatedAt: new Date() } });
        if (changed.count !== 1) return fail(409, 'credential-version-conflict');
    } else {
        const baseName = `Codex · ${externalAccountFingerprint.slice(0, 4).toUpperCase()}`;
        let displayName = baseName;
        let suffix = 2;
        while (await tx.codexAccountProfile.findUnique({ where: { accountId_displayName: { accountId, displayName } } })) displayName = `${baseName}-${suffix++}`;
        await tx.codexAccountProfile.create({ data: { id, accountId, displayName, externalAccountFingerprint, credential, lastValidatedAt: new Date() } });
    }
    const profile = await ownedProfile(tx, accountId, id);
    await audit(tx, accountId, 'upload', id, undefined, profile.credentialVersion);
    return profile;
}

async function migrateLegacy(tx: Tx, accountId: string): Promise<ListCodexAccountsResponse['migration']> {
    const account = await tx.account.findUniqueOrThrow({ where: { id: accountId }, select: { codexAccountsMigratedAt: true } });
    if (account.codexAccountsMigratedAt) return 'completed';
    const legacy = await tx.serviceAccountToken.findUnique({ where: { accountId_vendor: { accountId, vendor: 'openai' } } });
    if (!legacy) return 'none';
    let auth: CodexAuth;
    try {
        const serialized = decryptString(['user', accountId, 'vendors', 'openai', 'token'], legacy.token);
        if (Buffer.byteLength(serialized, 'utf8') > CODEX_AUTH_MAX_BYTES) return 'needs-upload';
        const value = JSON.parse(serialized);
        // The previous `paws connect codex` record was { oauth: tokens }.
        // Also accept a valid complete auth.json from self-hosted clients.
        const oldShape = z.object({ oauth: z.unknown() }).strict().safeParse(value);
        auth = codexAuthSchema.parse(oldShape.success ? { OPENAI_API_KEY: null, tokens: oldShape.data.oauth } : value);
    } catch { return 'needs-upload'; }
    const existing = await tx.codexAccountProfile.findUnique({ where: { accountId_externalAccountFingerprint: { accountId, externalAccountFingerprint: fingerprint(accountId, auth) } } });
    const profile = existing ?? await saveUpload(tx, accountId, auth);
    // Only untouched machines receive the compatibility binding. An explicit
    // selection (including unbound) must never be silently replaced.
    await tx.machine.updateMany({ where: { accountId, defaultCodexAccountProfileId: null, codexAccountBindingVersion: 0 }, data: { defaultCodexAccountProfileId: profile.id, codexAccountBindingVersion: { increment: 1 } } });
    await tx.account.update({ where: { id: accountId }, data: { codexAccountsMigratedAt: new Date() } });
    await audit(tx, accountId, 'legacy-migrate', profile.id, undefined, profile.credentialVersion);
    return 'completed';
}

export const codexAccountStore = {
    async list(accountId: string): Promise<ListCodexAccountsResponse> {
        return transaction(accountId, async (tx) => {
            const migration = await migrateLegacy(tx, accountId);
            const profiles = await tx.codexAccountProfile.findMany({ where: { accountId }, include: { quota: true }, orderBy: { createdAt: 'asc' } });
            const machines = await tx.machine.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' } });
            return { profiles: profiles.map(profileView), bindings: machines.map(bindingView), migration };
        });
    },
    async upload(accountId: string, auth: CodexAuth) {
        return transaction(accountId, async (tx) => ({ profile: profileView(await saveUpload(tx, accountId, auth)) }));
    },
    async rename(accountId: string, id: string, displayName: string) {
        return transaction(accountId, async (tx) => {
            await ownedProfile(tx, accountId, id);
            const collision = await tx.codexAccountProfile.findUnique({ where: { accountId_displayName: { accountId, displayName } } });
            if (collision && collision.id !== id) return fail(409, 'display-name-conflict');
            const profile = await tx.codexAccountProfile.update({ where: { id }, data: { displayName }, include: { quota: true } });
            await audit(tx, accountId, 'rename', id);
            return { profile: profileView(profile) };
        });
    },
    async delete(accountId: string, id: string) {
        return transaction(accountId, async (tx) => {
            await ownedProfile(tx, accountId, id);
            await tx.machine.updateMany({ where: { accountId, defaultCodexAccountProfileId: id }, data: { defaultCodexAccountProfileId: null, codexAccountBindingVersion: { increment: 1 } } });
            await tx.codexSessionGrant.deleteMany({ where: { accountId, codexAccountProfileId: id, redeemedAt: null } });
            await tx.codexAccountProfile.delete({ where: { id } });
            await audit(tx, accountId, 'delete', id);
            return { success: true as const };
        });
    },
    async bind(accountId: string, machineId: string, input: BindCodexAccountRequest) {
        return transaction(accountId, async (tx) => {
            await ownedMachine(tx, accountId, machineId);
            if (input.profileId) await ownedProfile(tx, accountId, input.profileId);
            const changed = await tx.machine.updateMany({ where: { id: machineId, accountId, codexAccountBindingVersion: input.expectedVersion }, data: { defaultCodexAccountProfileId: input.profileId, codexAccountBindingVersion: { increment: 1 } } });
            if (changed.count !== 1) return fail(409, 'binding-version-conflict');
            await audit(tx, accountId, 'bind', input.profileId ?? undefined, machineId);
            return { binding: bindingView(await ownedMachine(tx, accountId, machineId)) };
        });
    },
    async createGrant(accountId: string, machineId: string, sourceSessionId?: string): Promise<CreateCodexGrantResponse> {
        return transaction(accountId, async (tx) => {
            await migrateLegacy(tx, accountId);
            const machine = await ownedMachine(tx, accountId, machineId);
            let profileId = machine.defaultCodexAccountProfileId;
            if (sourceSessionId) {
                const session = await tx.session.findFirst({ where: { id: sourceSessionId, accountId } });
                const source = await tx.codexSessionGrant.findFirst({
                    where: { accountId, machineId, sourceSessionId, redeemedAt: { not: null } },
                    orderBy: { createdAt: 'desc' },
                });
                if (!session || !source) return fail(409, 'session-unavailable');
                profileId = source.codexAccountProfileId;
            }
            if (!profileId) return fail(409, 'codex-account-unbound');
            const profile = await ownedProfile(tx, accountId, profileId);
            if (profile.status !== 'available') return fail(409, 'codex-account-unavailable');
            const grant = randomBytes(32).toString('base64url');
            const expiresAt = new Date(Date.now() + CODEX_GRANT_TTL_MS);
            await tx.codexSessionGrant.deleteMany({ where: { accountId, redeemedAt: null, expiresAt: { lte: new Date() } } });
            await tx.codexSessionGrant.create({ data: {
                accountId, machineId, codexAccountProfileId: profile.id, displayNameSnapshot: profile.displayName,
                credentialVersion: profile.credentialVersion, lastCredentialVersion: profile.credentialVersion,
                bindingVersion: machine.codexAccountBindingVersion, digest: digest(grant), expiresAt,
                ...(sourceSessionId ? { sourceSessionId } : {}),
            } });
            await audit(tx, accountId, 'grant-create', profile.id, machineId, profile.credentialVersion);
            return { grant, expiresAt: expiresAt.toISOString(), profile: { id: profile.id, displayName: profile.displayName, credentialVersion: profile.credentialVersion } };
        });
    },
    async redeem(accountId: string, machineId: string, value: string): Promise<RedeemCodexGrantResponse> {
        return transaction(accountId, async (tx) => {
            const grant = await tx.codexSessionGrant.findFirst({ where: { accountId, machineId, digest: digest(value), redeemedAt: null, expiresAt: { gt: new Date() } } });
            if (!grant) return fail(409, 'grant-unavailable');
            const machine = await tx.machine.findFirst({ where: { id: machineId, accountId } });
            const profile = await tx.codexAccountProfile.findFirst({ where: { id: grant.codexAccountProfileId, accountId } });
            if (!machine || !profile || profile.status !== 'available' || profile.credentialVersion !== grant.credentialVersion) return fail(409, 'grant-unavailable');
            if (grant.sourceSessionId) {
                // Resume stays pinned to an owned session and its previous
                // redeemed launch, independently of the default for new work.
                const session = await tx.session.findFirst({ where: { id: grant.sourceSessionId, accountId } });
                const source = await tx.codexSessionGrant.findFirst({ where: {
                    accountId, machineId, sourceSessionId: grant.sourceSessionId,
                    codexAccountProfileId: profile.id, redeemedAt: { not: null },
                } });
                if (!session || !source) return fail(409, 'grant-unavailable');
            } else if (machine.defaultCodexAccountProfileId !== profile.id || machine.codexAccountBindingVersion !== grant.bindingVersion) {
                return fail(409, 'grant-unavailable');
            }
            const auth = codexAuthSchema.parse(JSON.parse(decryptString(path(accountId, profile.id), profile.credential)));
            const consumed = await tx.codexSessionGrant.updateMany({ where: { id: grant.id, redeemedAt: null, expiresAt: { gt: new Date() } }, data: { redeemedAt: new Date() } });
            if (consumed.count !== 1) return fail(409, 'grant-unavailable');
            await audit(tx, accountId, 'grant-redeem', profile.id, machineId, profile.credentialVersion);
            return { auth, launchId: grant.id, profile: { id: profile.id, displayName: grant.displayNameSnapshot, credentialVersion: grant.credentialVersion } };
        });
    },
    async registerSession(accountId: string, launchId: string, machineId: string, sourceSessionId: string) {
        return transaction(accountId, async (tx) => {
            const launch = await tx.codexSessionGrant.findFirst({ where: { id: launchId, accountId, machineId, redeemedAt: { not: null } } });
            if (!launch || (launch.sourceSessionId && launch.sourceSessionId !== sourceSessionId)) return fail(409, 'launch-unavailable');
            const session = await tx.session.findFirst({ where: { id: sourceSessionId, accountId } });
            if (!session) return fail(409, 'session-unavailable');
            await ownedMachine(tx, accountId, machineId);
            await tx.codexSessionGrant.update({ where: { id: launchId }, data: { sourceSessionId } });
            await audit(tx, accountId, 'session-register', launch.codexAccountProfileId, machineId, launch.credentialVersion);
            return { success: true as const };
        });
    },
    async updateCredential(accountId: string, id: string, input: UpdateCodexCredentialRequest) {
        return transaction(accountId, async (tx) => {
            const profile = await ownedProfile(tx, accountId, id);
            const launch = await tx.codexSessionGrant.findFirst({ where: { id: input.launchId, accountId, machineId: input.machineId, codexAccountProfileId: id, redeemedAt: { not: null } } });
            if (!launch) return fail(409, 'credential-version-conflict');
            await ownedMachine(tx, accountId, input.machineId);
            // A committed write may lose its response. Only acknowledge the exact
            // current credential committed by this launch; never advance a stale writer.
            if (launch.lastCredentialVersion === input.expectedVersion + 1
                && launch.credentialVersion <= input.expectedVersion
                && profile.credentialVersion === launch.lastCredentialVersion
                && isDeepStrictEqual(JSON.parse(decryptString(path(accountId, id), profile.credential)), input.auth)) {
                return { profile: profileView(profile) };
            }
            if (launch.lastCredentialVersion !== input.expectedVersion) return fail(409, 'credential-version-conflict');
            if (fingerprint(accountId, input.auth) !== profile.externalAccountFingerprint) return fail(400, 'credential-identity-mismatch');
            const changed = await tx.codexAccountProfile.updateMany({ where: { id, accountId, credentialVersion: input.expectedVersion }, data: { credential: encryptString(path(accountId, id), JSON.stringify(input.auth)), credentialVersion: { increment: 1 }, status: 'available', lastValidatedAt: new Date() } });
            if (changed.count !== 1) return fail(409, 'credential-version-conflict');
            await tx.codexSessionGrant.update({ where: { id: launch.id }, data: { lastCredentialVersion: input.expectedVersion + 1 } });
            await audit(tx, accountId, 'credential-refresh', id, input.machineId, input.expectedVersion + 1);
            return { profile: profileView(await ownedProfile(tx, accountId, id)) };
        });
    },
    async reportStatus(accountId: string, id: string, input: ReportCodexStatusRequest) {
        return transaction(accountId, async (tx) => {
            const profile = await ownedProfile(tx, accountId, id);
            const launch = await tx.codexSessionGrant.findFirst({ where: {
                id: input.launchId, accountId, machineId: input.machineId, codexAccountProfileId: id,
                redeemedAt: { not: null }, sourceSessionId: { not: null }, lastCredentialVersion: input.credentialVersion,
            } });
            if (!launch || profile.credentialVersion !== input.credentialVersion) return fail(409, 'status-attribution-mismatch');
            await ownedMachine(tx, accountId, input.machineId);
            if (!await tx.session.findFirst({ where: { id: launch.sourceSessionId!, accountId } })) return fail(409, 'status-attribution-mismatch');
            await tx.codexAccountProfile.update({ where: { id }, data: { status: input.status } });
            await audit(tx, accountId, `status-${input.status}`, id, input.machineId, input.credentialVersion);
            return { profile: profileView(await ownedProfile(tx, accountId, id)) };
        });
    },
    async reportQuota(accountId: string, id: string, input: ReportCodexQuotaRequest) {
        const observedAt = new Date(input.observedAt);
        const weeklyResetsAt = new Date(input.weeklyResetsAt);
        if (observedAt.getTime() > Date.now() + 60_000 || weeklyResetsAt <= observedAt || weeklyResetsAt.getTime() - observedAt.getTime() > 8 * 86400_000) return fail(400, 'invalid-quota-time');
        return transaction(accountId, async (tx) => {
            const profile = await ownedProfile(tx, accountId, id);
            const launch = await tx.codexSessionGrant.findFirst({ where: { id: input.launchId, accountId, machineId: input.machineId, codexAccountProfileId: id, credentialVersion: input.credentialVersion, sourceSessionId: input.sourceSessionId, redeemedAt: { not: null } } });
            if (!launch) return fail(409, 'quota-attribution-mismatch');
            await ownedMachine(tx, accountId, input.machineId);
            const session = await tx.session.findFirst({ where: { id: input.sourceSessionId, accountId } });
            if (!session) return fail(409, 'quota-attribution-mismatch');
            if (profile.quota && profile.quota.observedAt >= observedAt) return { accepted: false };
            const data = { weeklyUsedPercent: input.weeklyUsedPercent, weeklyResetsAt, observedAt, credentialVersion: input.credentialVersion, sourceSessionId: input.sourceSessionId };
            await tx.codexQuotaSnapshot.upsert({ where: { codexAccountProfileId: id }, create: { codexAccountProfileId: id, ...data }, update: data });
            return { accepted: true };
        });
    },
    async reportQuotaProbe(accountId: string, id: string, input: ReportCodexQuotaProbeRequest) {
        const observedAt = new Date(input.observedAt);
        const weeklyResetsAt = new Date(input.weeklyResetsAt);
        if (observedAt.getTime() > Date.now() + 60_000 || weeklyResetsAt <= observedAt || weeklyResetsAt.getTime() - observedAt.getTime() > 8 * 86400_000) return fail(400, 'invalid-quota-time');
        return transaction(accountId, async (tx) => {
            const profile = await ownedProfile(tx, accountId, id);
            // A probe may only report through the one-time grant that redeemed this
            // exact account on this exact bound machine. A normal conversation uses
            // reportQuota instead, where sourceSessionId is mandatory.
            const launch = await tx.codexSessionGrant.findFirst({ where: {
                id: input.launchId, accountId, machineId: input.machineId, codexAccountProfileId: id,
                credentialVersion: input.credentialVersion, sourceSessionId: null, redeemedAt: { not: null },
            } });
            if (!launch) return fail(409, 'quota-attribution-mismatch');
            await ownedMachine(tx, accountId, input.machineId);
            if (profile.quota && profile.quota.observedAt >= observedAt) return { accepted: false };
            const data = { weeklyUsedPercent: input.weeklyUsedPercent, weeklyResetsAt, observedAt, credentialVersion: input.credentialVersion, sourceSessionId: `quota-probe:${launch.id}` };
            await tx.codexQuotaSnapshot.upsert({ where: { codexAccountProfileId: id }, create: { codexAccountProfileId: id, ...data }, update: data });
            await audit(tx, accountId, 'quota-probe', id, input.machineId, input.credentialVersion);
            return { accepted: true };
        });
    },
};
