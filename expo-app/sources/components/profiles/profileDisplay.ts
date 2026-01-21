import type { AIBackendProfile } from '@/sync/settings';
import { getBuiltInProfileNameKey } from '@/sync/profileUtils';
import { t } from '@/text';

export function getProfileDisplayName(profile: Pick<AIBackendProfile, 'id' | 'name' | 'isBuiltIn'>): string {
    if (profile.isBuiltIn) {
        const key = getBuiltInProfileNameKey(profile.id);
        if (key) {
            return t(key);
        }
    }
    return profile.name;
}

