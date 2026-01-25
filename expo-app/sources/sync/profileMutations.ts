import { randomUUID } from '@/platform/randomUUID';
import { AIBackendProfile } from '@/sync/settings';

export function createEmptyCustomProfile(): AIBackendProfile {
    return {
        id: randomUUID(),
        name: '',
        environmentVariables: [],
        defaultPermissionModeByAgent: {},
        compatibility: { claude: true, codex: true, gemini: true },
        envVarRequirements: [],
        isBuiltIn: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: '1.0.0',
    };
}

export function duplicateProfileForEdit(profile: AIBackendProfile, opts?: { copySuffix?: string }): AIBackendProfile {
    const suffix = opts?.copySuffix ?? '(Copy)';
    const separator = profile.name.trim().length > 0 ? ' ' : '';
    return {
        ...profile,
        id: randomUUID(),
        name: `${profile.name}${separator}${suffix}`,
        isBuiltIn: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

export function convertBuiltInProfileToCustom(profile: AIBackendProfile): AIBackendProfile {
    return {
        ...profile,
        id: randomUUID(),
        isBuiltIn: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}
