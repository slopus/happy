import { useMemo } from 'react';

import type { AIBackendProfile } from '@/sync/settings';
import { getProfileEnvironmentVariables } from '@/sync/settings';
import { useEnvironmentVariables } from '@/hooks/useEnvironmentVariables';

export interface ProfileEnvRequirement {
    name: string;
    kind: 'secret' | 'config';
}

export interface ProfileEnvRequirementsResult {
    required: ProfileEnvRequirement[];
    isReady: boolean;
    isLoading: boolean;
    isPreviewEnvSupported: boolean;
    policy: 'none' | 'redacted' | 'full' | null;
    /**
     * Per-key presence info returned by daemon (never rely on raw value for secrets).
     */
    meta: Record<string, { isSet: boolean; display: 'full' | 'redacted' | 'hidden' | 'unset' }>;
}

/**
 * Preflight-check a profile's required env vars on a specific machine using the daemon's `preview-env` RPC.
 *
 * - Uses `extraEnv = getProfileEnvironmentVariables(profile)` so the preview matches spawn-time expansion.
 * - Marks required secret keys as sensitive so they are never fetched into UI memory via fallback probing.
 */
export function useProfileEnvRequirements(
    machineId: string | null,
    profile: AIBackendProfile | null | undefined,
): ProfileEnvRequirementsResult {
    const required = useMemo<ProfileEnvRequirement[]>(() => {
        const raw = profile?.envVarRequirements ?? [];
        return raw
            .filter((v) => v.required === true)
            .map((v) => ({
                name: v.name,
                kind: v.kind ?? 'secret',
            }));
    }, [profile?.envVarRequirements]);

    const keysToQuery = useMemo(() => required.map((r) => r.name), [required]);
    const sensitiveKeys = useMemo(() => required.filter((r) => r.kind === 'secret').map((r) => r.name), [required]);
    const extraEnv = useMemo(() => (profile ? getProfileEnvironmentVariables(profile) : undefined), [profile]);

    const { meta, policy, isLoading, isPreviewEnvSupported } = useEnvironmentVariables(machineId, keysToQuery, {
        extraEnv,
        sensitiveKeys,
    });

    const isReady = useMemo(() => {
        if (required.length === 0) return true;
        return required.every((req) => Boolean(meta[req.name]?.isSet));
    }, [meta, required]);

    const metaSummary = useMemo(() => {
        return Object.fromEntries(
            required.map((req) => {
                const entry = meta[req.name];
                return [
                    req.name,
                    {
                        isSet: Boolean(entry?.isSet),
                        display: entry?.display ?? 'unset',
                    },
                ] as const;
            }),
        );
    }, [meta, required]);

    return {
        required,
        isReady,
        isLoading,
        isPreviewEnvSupported,
        policy,
        meta: metaSummary,
    };
}

