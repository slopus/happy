import type { AIBackendProfile, SavedSecret } from '@/sync/settings';

export type SecretSatisfactionSource =
    | 'none'
    | 'machineEnv'
    | 'sessionOnly'
    | 'selectedSaved'
    | 'rememberedSaved'
    | 'defaultSaved';

export type SecretSatisfactionItem = Readonly<{
    envVarName: string;
    required: boolean;
    isSatisfied: boolean;
    satisfiedBy: SecretSatisfactionSource;
    savedSecretId: string | null;
}>;

export type SecretSatisfactionResult = Readonly<{
    hasSecretRequirements: boolean;
    items: SecretSatisfactionItem[];
    /**
     * True when all required secret requirements are satisfied.
     */
    isSatisfied: boolean;
}>;

export type SecretSatisfactionParams = Readonly<{
    profile: AIBackendProfile | null;
    secrets: SavedSecret[];
    /**
     * Per-profile default bindings from settings: envVarName -> savedSecretId.
     */
    defaultBindings?: Record<string, string> | null;
    /**
     * Explicit per-run selection (e.g. New Session UI state): envVarName -> savedSecretId (or '' for “prefer machine env”).
     */
    selectedSecretIds?: Record<string, string | null | undefined> | null;
    /**
     * Remembered per-screen selection (optional): envVarName -> savedSecretId.
     */
    rememberedSecretIds?: Record<string, string | null | undefined> | null;
    /**
     * Session-only secrets (never persisted): envVarName -> plaintext.
     */
    sessionOnlyValues?: Record<string, string | null | undefined> | null;
    /**
     * Whether the machine environment provides envVarName: envVarName -> true/false/unknown.
     */
    machineEnvReadyByName?: Record<string, boolean | null | undefined> | null;
}>;

function normalizeId(id: string | null | undefined): string | null {
    if (typeof id !== 'string') return null;
    const trimmed = id.trim();
    if (!trimmed) return null;
    return trimmed;
}

function hasSavedSecret(secrets: SavedSecret[], id: string | null): boolean {
    if (!id) return false;
    return secrets.some((k) => k.id === id);
}

function getSecretRequirements(profile: AIBackendProfile): Array<{ envVarName: string; required: boolean }> {
    const reqs = profile.envVarRequirements ?? [];
    return reqs
        .filter((r) => (r.kind ?? 'secret') === 'secret')
        .map((r) => ({ envVarName: r.name, required: r.required === true }));
}

/**
 * Centralized secret satisfaction logic (multi-secret).
 *
 * Precedence per env var (highest -> lowest):
 * - sessionOnlyValues[env]
 * - selectedSecretIds[env] (explicit per-run saved key selection)
 * - rememberedSecretIds[env] (per-screen remembered selection)
 * - defaultBindings[env] (profile default saved key)
 * - machineEnvReadyByName[env] (daemon env provides required var)
 *
 * Special case:
 * - If selectedSecretIds[env] === '' (empty string), treat as “prefer machine env”:
 *   do NOT count remembered/default saved secrets as satisfying; only machine env or sessionOnly.
 */
export function getSecretSatisfaction(params: SecretSatisfactionParams): SecretSatisfactionResult {
    const profile = params.profile;
    if (!profile) {
        return {
            hasSecretRequirements: false,
            items: [],
            isSatisfied: true,
        };
    }

    const requirements = getSecretRequirements(profile);
    if (requirements.length === 0) {
        return {
            hasSecretRequirements: false,
            items: [],
            isSatisfied: true,
        };
    }

    const secrets = params.secrets ?? [];
    const defaultBindings = params.defaultBindings ?? null;
    const selectedSecretIds = params.selectedSecretIds ?? null;
    const rememberedSecretIds = params.rememberedSecretIds ?? null;
    const sessionOnlyValues = params.sessionOnlyValues ?? null;
    const machineEnvReadyByName = params.machineEnvReadyByName ?? null;

    const items: SecretSatisfactionItem[] = requirements.map(({ envVarName, required }) => {
        const machineEnvReady = machineEnvReadyByName?.[envVarName];
        const sessionOnly = typeof sessionOnlyValues?.[envVarName] === 'string'
            ? String(sessionOnlyValues?.[envVarName]).trim()
            : '';
        const selectedRaw = selectedSecretIds?.[envVarName];
        const selectedId = normalizeId(selectedRaw === '' ? null : (selectedRaw ?? null));
        const preferMachineEnv = selectedRaw === '';
        const rememberedId = normalizeId(rememberedSecretIds?.[envVarName] ?? null);
        const defaultId = normalizeId(defaultBindings?.[envVarName] ?? null);

        if (sessionOnly.length > 0) {
            return { envVarName, required, isSatisfied: true, satisfiedBy: 'sessionOnly', savedSecretId: null };
        }

        if (hasSavedSecret(secrets, selectedId)) {
            return { envVarName, required, isSatisfied: true, satisfiedBy: 'selectedSaved', savedSecretId: selectedId! };
        }

        if (preferMachineEnv) {
            if (machineEnvReady === true) {
                return { envVarName, required, isSatisfied: true, satisfiedBy: 'machineEnv', savedSecretId: null };
            }
            return { envVarName, required, isSatisfied: false, satisfiedBy: 'none', savedSecretId: null };
        }

        if (hasSavedSecret(secrets, rememberedId)) {
            return { envVarName, required, isSatisfied: true, satisfiedBy: 'rememberedSaved', savedSecretId: rememberedId! };
        }

        if (hasSavedSecret(secrets, defaultId)) {
            return { envVarName, required, isSatisfied: true, satisfiedBy: 'defaultSaved', savedSecretId: defaultId! };
        }

        if (machineEnvReady === true) {
            return { envVarName, required, isSatisfied: true, satisfiedBy: 'machineEnv', savedSecretId: null };
        }

        return { envVarName, required, isSatisfied: false, satisfiedBy: 'none', savedSecretId: null };
    });

    const isSatisfied = items.filter((i) => i.required).every((i) => i.isSatisfied);
    return {
        hasSecretRequirements: true,
        items,
        isSatisfied,
    };
}

