import type { AIBackendProfile } from '@/sync/settings';

export function getMissingRequiredConfigEnvVarNames(
    profile: AIBackendProfile | null | undefined,
    machineEnvReadyByName: Record<string, boolean | null | undefined> | null | undefined,
): string[] {
    if (!profile) return [];
    const reqs = profile.envVarRequirements ?? [];
    return reqs
        .filter((r) => (r.kind ?? 'secret') === 'config' && r.required === true)
        .map((r) => r.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
        .filter((name) => machineEnvReadyByName?.[name] !== true);
}

