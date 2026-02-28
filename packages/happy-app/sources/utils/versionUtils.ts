/**
 * Utility functions for version comparison and validation
 */

import { useState, useEffect } from 'react';

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/happy-next-cli/latest';

let latestVersionPromise: Promise<string | null> | null = null;

/**
 * Fetch the latest CLI version from npm registry.
 * Result is cached in memory — only one request per app lifecycle.
 */
export function fetchLatestCliVersion(): Promise<string | null> {
    if (!latestVersionPromise) {
        latestVersionPromise = fetch(NPM_REGISTRY_URL, {
            headers: { 'Accept': 'application/json' },
        })
            .then(res => {
                if (!res.ok) return null;
                return res.json();
            })
            .then(data => (data && typeof data.version === 'string') ? data.version : null)
            .catch(() => null);
    }
    return latestVersionPromise;
}

/**
 * React hook that returns the latest CLI version from npm, or null while loading / on failure.
 */
export function useLatestCliVersion(): string | null {
    const [version, setVersion] = useState<string | null>(null);
    useEffect(() => {
        fetchLatestCliVersion().then(v => setVersion(v));
    }, []);
    return version;
}

/**
 * Compare two semantic version strings
 * @param version1 First version to compare
 * @param version2 Second version to compare
 * @returns -1 if version1 < version2, 0 if equal, 1 if version1 > version2
 */
export function compareVersions(version1: string, version2: string): number {
    // Handle pre-release versions by stripping suffix (e.g., "0.10.0-1" -> "0.10.0")
    const cleanVersion = (v: string) => v.split('-')[0];

    const v1Parts = cleanVersion(version1).split('.').map(Number);
    const v2Parts = cleanVersion(version2).split('.').map(Number);

    // Pad with zeros if needed
    const maxLength = Math.max(v1Parts.length, v2Parts.length);
    while (v1Parts.length < maxLength) v1Parts.push(0);
    while (v2Parts.length < maxLength) v2Parts.push(0);

    for (let i = 0; i < maxLength; i++) {
        if (v1Parts[i] > v2Parts[i]) return 1;
        if (v1Parts[i] < v2Parts[i]) return -1;
    }

    return 0;
}

/**
 * Check if a version meets the minimum requirement
 * @param version Version to check
 * @param minimumVersion Minimum required version
 * @returns true if version >= minimumVersion
 */
export function isVersionSupported(version: string | undefined, minimumVersion: string): boolean {
    if (!version) return false;

    try {
        return compareVersions(version, minimumVersion) >= 0;
    } catch {
        // If version comparison fails, assume it's not supported
        return false;
    }
}

/**
 * Parse version string to extract major, minor, and patch numbers
 * @param version Version string to parse
 * @returns Object with major, minor, and patch numbers, or null if invalid
 */
export function parseVersion(version: string): { major: number; minor: number; patch: number } | null {
    try {
        const cleanVersion = version.split('-')[0];
        const [major, minor, patch] = cleanVersion.split('.').map(Number);
        
        if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
            return null;
        }
        
        return { major, minor, patch };
    } catch {
        return null;
    }
}