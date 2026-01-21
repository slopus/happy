import type { AIBackendProfile } from '@/sync/settings';

export function getRequiredSecretEnvVarName(profile: AIBackendProfile | null | undefined): string | null {
    const required = profile?.envVarRequirements ?? [];
    const secret = required.find((v) => (v?.kind ?? 'secret') === 'secret' && v.required === true);
    return typeof secret?.name === 'string' && secret.name.length > 0 ? secret.name : null;
}

export function hasRequiredSecret(profile: AIBackendProfile | null | undefined): boolean {
    return Boolean(getRequiredSecretEnvVarName(profile));
}

export function getRequiredSecretEnvVarNames(profile: AIBackendProfile | null | undefined): string[] {
    const required = profile?.envVarRequirements ?? [];
    return required
        .filter((v) => (v?.kind ?? 'secret') === 'secret' && v.required === true)
        .map((v) => v.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
}
