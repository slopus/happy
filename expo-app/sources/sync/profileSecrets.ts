import type { AIBackendProfile } from '@/sync/settings';

export function getRequiredSecretEnvVarName(profile: AIBackendProfile | null | undefined): string | null {
    const required = profile?.requiredEnvVars ?? [];
    const secret = required.find((v) => (v?.kind ?? 'secret') === 'secret');
    return typeof secret?.name === 'string' && secret.name.length > 0 ? secret.name : null;
}

export function hasRequiredSecret(profile: AIBackendProfile | null | undefined): boolean {
    return Boolean(getRequiredSecretEnvVarName(profile));
}

