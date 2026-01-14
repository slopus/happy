import { randomUUID } from 'expo-crypto';
import { AIBackendProfile } from '@/sync/settings';

export function createEmptyCustomProfile(): AIBackendProfile {
    return {
        id: randomUUID(),
        name: '',
        anthropicConfig: {},
        environmentVariables: [],
        compatibility: { claude: true, codex: true, gemini: true },
        isBuiltIn: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: '1.0.0',
    };
}

export function duplicateProfileForEdit(profile: AIBackendProfile): AIBackendProfile {
    return {
        ...profile,
        id: randomUUID(),
        name: `${profile.name} (Copy)`,
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

