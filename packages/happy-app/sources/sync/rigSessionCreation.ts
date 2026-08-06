import type { Machine, MachineMetadata } from './storageTypes';
import { qualifyRigModelKey } from './rig';

/** A model option as published by a Rig machine, qualified by provider. */
export type RigMachineModelOption = {
    key: string;
    id: string;
    providerId: string;
    name: string;
    providerName: string;
    description: string | null;
    thinkingLevels: string[];
    defaultThinkingLevel: string | null;
};

export type RigMachineModeOption = {
    key: string;
    name: string;
    description: string | null;
    semanticKind: string | null;
};

export type RigMachineSessionCreation = {
    models: RigMachineModelOption[];
    permissionModes: RigMachineModeOption[];
    defaultModelKey: string | null;
    defaultPermissionMode: string | null;
    supportsWorktrees: boolean;
    /** Backoff the machine publishes for polling a `pending` spawn result. */
    pendingRetryAfterMs: number | null;
    effortsForModel: (modelKey: string | null | undefined) => string[];
    defaultEffortForModel: (modelKey: string | null | undefined) => string | null;
};

export type BuildRigSpawnConfigurationInput = {
    directory: string;
    clientRequestId: string;
    approvedNewDirectoryCreation?: boolean;
    modelKey?: string | null;
    permissionMode?: string | null;
    effort?: string | null;
};

/**
 * The precise machine RPC payload accepted by Rig's `spawn-happy-session`
 * handler. It deliberately has no Happy CLI-only fields such as `modelMode`
 * or resume ids.
 */
export type RigSpawnConfiguration = {
    type: 'spawn-in-directory';
    agent: 'rig';
    directory: string;
    clientRequestId: string;
    approvedNewDirectoryCreation?: boolean;
    providerId: string;
    modelId: string;
    permissionMode: string;
    effort: string;
};

type RigMachineMetadata = {
    machineKind?: unknown;
    rigOnly?: unknown;
    client?: { id?: unknown } | null;
    cliAvailability?: { rig?: unknown } | null;
    capabilities?: { newSession?: unknown; worktrees?: unknown } | null;
    defaults?: {
        providerId?: unknown;
        modelId?: unknown;
        permissionMode?: unknown;
        effort?: unknown;
    } | null;
    models?: unknown;
    operatingModes?: unknown;
    sessionCreation?: { pendingRetryAfterMs?: unknown } | null;
};

/** Bounds applied to any retry delay before it reaches `delay()`. */
const PENDING_RETRY_MIN_MS = 250;
const PENDING_RETRY_MAX_MS = 10_000;
/** Used when neither the RPC result nor the machine publishes a delay. */
const PENDING_RETRY_DEFAULT_MS = 1_000;

function asRigMachineMetadata(metadata: MachineMetadata | null | undefined): RigMachineMetadata | null {
    return metadata as unknown as RigMachineMetadata | null;
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Backoff before polling a `pending` spawn result again.
 *
 * `retryAfterMs` arrives from an unvalidated machine RPC payload, so it is only
 * typed as a number: a Rig that omits it produced `Math.max(250, undefined)` —
 * `NaN` — and `delay(NaN)` resolves immediately, turning the backoff into
 * back-to-back retries. Falls back to the delay the machine publishes in
 * `sessionCreation.pendingRetryAfterMs`, then to a fixed default.
 */
export function resolveRigPendingRetryDelayMs(
    retryAfterMs: unknown,
    publishedRetryAfterMs?: number | null,
): number {
    const requested = finiteNumber(retryAfterMs)
        ?? finiteNumber(publishedRetryAfterMs)
        ?? PENDING_RETRY_DEFAULT_MS;
    return Math.min(PENDING_RETRY_MAX_MS, Math.max(PENDING_RETRY_MIN_MS, requested));
}

function records(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is Record<string, unknown> => (
        typeof item === 'object' && item !== null && !Array.isArray(item)
    ));
}

function strings(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : [];
}

/** True only for a machine published by Rig, never for a Rig session. */
export function isRigMachine(metadata: MachineMetadata | null | undefined): boolean {
    const rig = asRigMachineMetadata(metadata);
    return rig?.machineKind === 'rig'
        || rig?.rigOnly === true
        || rig?.client?.id === 'rig'
        || rig?.cliAvailability?.rig === true;
}

/**
 * Turns a Rig machine's dynamic catalog into picker-ready options. Returns
 * null for regular Happy CLI machines or a Rig machine that cannot create
 * sessions.
 */
export function getRigMachineSessionCreation(
    metadata: MachineMetadata | null | undefined,
): RigMachineSessionCreation | null {
    const rig = asRigMachineMetadata(metadata);
    if (!isRigMachine(metadata) || rig?.capabilities?.newSession !== true) return null;

    const models = records(rig.models).flatMap((model): RigMachineModelOption[] => {
        const providerId = nonEmptyString(model.providerId)
            ?? nonEmptyString((model.provider as Record<string, unknown> | undefined)?.id);
        const id = nonEmptyString(model.id) ?? nonEmptyString(model.code);
        if (!providerId || !id) return [];

        const provider = model.provider as Record<string, unknown> | undefined;
        const name = nonEmptyString(model.name) ?? nonEmptyString(model.value) ?? id;
        const providerName = nonEmptyString(model.providerName)
            ?? nonEmptyString(provider?.name)
            ?? providerId;
        const thinkingLevels = strings(model.thinkingLevels);
        const declaredDefault = nonEmptyString(model.defaultThinkingLevel);
        return [{
            key: qualifyRigModelKey(providerId, id),
            id,
            providerId,
            name,
            providerName,
            description: providerName,
            thinkingLevels,
            defaultThinkingLevel: declaredDefault && thinkingLevels.includes(declaredDefault)
                ? declaredDefault
                : thinkingLevels[0] ?? null,
        }];
    });

    const permissionModes = records(rig.operatingModes).flatMap((mode): RigMachineModeOption[] => {
        const key = nonEmptyString(mode.code);
        if (!key) return [];
        return [{
            key,
            name: nonEmptyString(mode.value) ?? key,
            description: nonEmptyString(mode.description),
            semanticKind: nonEmptyString(mode.kind),
        }];
    });

    const defaultModelKey = (() => {
        const providerId = nonEmptyString(rig.defaults?.providerId);
        const modelId = nonEmptyString(rig.defaults?.modelId);
        const publishedDefault = providerId && modelId
            ? qualifyRigModelKey(providerId, modelId)
            : null;
        return models.some((model) => model.key === publishedDefault)
            ? publishedDefault
            : models[0]?.key ?? null;
    })();
    const publishedPermission = nonEmptyString(rig.defaults?.permissionMode);
    const defaultPermissionMode = permissionModes.some((mode) => mode.key === publishedPermission)
        ? publishedPermission
        : permissionModes[0]?.key ?? null;

    const modelFor = (modelKey: string | null | undefined) => (
        models.find((model) => model.key === modelKey)
        ?? models.find((model) => model.key === defaultModelKey)
        ?? null
    );

    return {
        models,
        permissionModes,
        defaultModelKey,
        defaultPermissionMode,
        supportsWorktrees: rig.capabilities?.worktrees === true,
        pendingRetryAfterMs: finiteNumber(rig.sessionCreation?.pendingRetryAfterMs),
        effortsForModel: (modelKey) => modelFor(modelKey)?.thinkingLevels ?? [],
        defaultEffortForModel: (modelKey) => modelFor(modelKey)?.defaultThinkingLevel ?? null,
    };
}

/** Finds an online Rig machine whose machine RPC can create new sessions. */
export function findConnectedRigMachine(machines: readonly Machine[]): Machine | null {
    return machines.find((machine) => (
        machine.active && getRigMachineSessionCreation(machine.metadata) !== null
    )) ?? null;
}

/** Builds a validated, provider-qualified request for Rig's machine RPC. */
export function buildRigSpawnConfiguration(
    metadata: MachineMetadata | null | undefined,
    input: BuildRigSpawnConfigurationInput,
): RigSpawnConfiguration {
    const creation = getRigMachineSessionCreation(metadata);
    if (!creation) throw new Error('This machine is not available for Rig session creation.');
    if (!nonEmptyString(input.directory)) throw new Error('A Rig session directory is required.');
    if (!nonEmptyString(input.clientRequestId)) throw new Error('A Rig client request ID is required.');

    const modelKey = input.modelKey ?? creation.defaultModelKey;
    const model = creation.models.find((candidate) => candidate.key === modelKey);
    if (!model) throw new Error('The selected Rig model is unavailable.');

    const permissionMode = input.permissionMode ?? creation.defaultPermissionMode;
    if (!permissionMode || !creation.permissionModes.some((mode) => mode.key === permissionMode)) {
        throw new Error('The selected Rig permission mode is unavailable.');
    }

    const effort = input.effort ?? creation.defaultEffortForModel(model.key);
    if (!effort || !model.thinkingLevels.includes(effort)) {
        throw new Error('The selected Rig reasoning level is unavailable for this model.');
    }

    return {
        type: 'spawn-in-directory',
        agent: 'rig',
        directory: input.directory,
        clientRequestId: input.clientRequestId,
        ...(input.approvedNewDirectoryCreation === true && { approvedNewDirectoryCreation: true }),
        providerId: model.providerId,
        modelId: model.id,
        permissionMode,
        effort,
    };
}
