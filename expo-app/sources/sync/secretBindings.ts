import type { Settings } from '@/sync/settings';
import { getBuiltInProfile } from '@/sync/profileUtils';

function normalizeEnvVarName(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const upper = trimmed.toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(upper)) return null;
    return upper;
}

function getAllowedSecretEnvVarNamesByProfileId(settings: Settings): Record<string, Set<string>> {
    const out: Record<string, Set<string>> = {};

    for (const p of settings.profiles) {
        const names = new Set(
            (p.envVarRequirements ?? [])
                .filter((r) => (r.kind ?? 'secret') === 'secret')
                .map((r) => normalizeEnvVarName(r.name))
                .filter((n): n is string => typeof n === 'string' && n.length > 0),
        );
        out[p.id] = names;
    }

    // Include built-in profiles too (bindings are allowed for built-ins).
    // We only consider built-ins that we know about; unknown profile ids are pruned.
    const seen = new Set(Object.keys(out));
    for (const profileId of Object.keys(settings.secretBindingsByProfileId ?? {})) {
        if (seen.has(profileId)) continue;
        const builtIn = getBuiltInProfile(profileId);
        if (!builtIn) continue;
        const names = new Set(
            (builtIn.envVarRequirements ?? [])
                .filter((r) => (r.kind ?? 'secret') === 'secret')
                .map((r) => normalizeEnvVarName(r.name))
                .filter((n): n is string => typeof n === 'string' && n.length > 0),
        );
        out[profileId] = names;
    }

    return out;
}

/**
 * Remove dangling/invalid secret bindings.
 *
 * Invariants:
 * - No bindings for unknown profile ids (custom or built-in).
 * - No bindings for env var names that are not declared as a secret requirement on that profile.
 * - No bindings referencing deleted secrets.
 * - Env var names are normalized to uppercase.
 */
export function pruneSecretBindings(settings: Settings): Settings {
    const bindings = settings.secretBindingsByProfileId ?? {};
    if (Object.keys(bindings).length === 0) return settings;

    const secretIds = new Set((settings.secrets ?? []).map((s) => s.id));
    const allowedByProfileId = getAllowedSecretEnvVarNamesByProfileId(settings);

    let changed = false;
    const next: Record<string, Record<string, string>> = {};

    for (const [profileId, byEnv] of Object.entries(bindings)) {
        const allowed = allowedByProfileId[profileId];
        if (!allowed) {
            changed = true;
            continue;
        }

        let nextByEnv: Record<string, string> | null = null;
        for (const [rawEnvName, secretId] of Object.entries(byEnv ?? {})) {
            const envName = typeof rawEnvName === 'string' ? normalizeEnvVarName(rawEnvName) : null;
            if (!envName) {
                changed = true;
                continue;
            }
            if (!allowed.has(envName)) {
                changed = true;
                continue;
            }
            if (typeof secretId !== 'string' || !secretIds.has(secretId)) {
                changed = true;
                continue;
            }
            if (!nextByEnv) nextByEnv = {};
            nextByEnv[envName] = secretId;
        }

        if (!nextByEnv || Object.keys(nextByEnv).length === 0) {
            if (Object.keys(byEnv ?? {}).length > 0) changed = true;
            continue;
        }

        next[profileId] = nextByEnv;
    }

    if (!changed) return settings;
    return {
        ...settings,
        secretBindingsByProfileId: next,
    };
}

