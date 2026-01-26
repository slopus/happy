import React from 'react';
import { getProfileEnvironmentVariables, type AIBackendProfile } from '@/sync/settings';

// Optimized profile lookup utility
export const useProfileMap = (profiles: AIBackendProfile[]) => {
    return React.useMemo(() =>
        new Map(profiles.map(p => [p.id, p])),
        [profiles]
    );
};

// Environment variable transformation helper
// Returns ALL profile environment variables - daemon will use them as-is
export const transformProfileToEnvironmentVars = (profile: AIBackendProfile) => {
    // getProfileEnvironmentVariables already returns ALL env vars from profile
    // including custom environmentVariables array
    return getProfileEnvironmentVariables(profile);
};
