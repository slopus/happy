/**
 * Utility functions for version comparison and validation
 */

// Minimum required CLI version for full compatibility
export const MINIMUM_CLI_VERSION = '0.10.0';

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
 * Compare two versions including prerelease tags, semver-style. compareVersions
 * strips the suffix, so "1.2.1-beta.1" and "1.2.1-beta.2" compare equal there;
 * this one ranks a release above any prerelease of the same core
 * ("1.2.1" > "1.2.1-beta.2") and compares prerelease segments numerically when
 * both are numbers ("beta.2" > "beta.1", "beta.10" > "beta.9"). Build metadata
 * ("+abc") is ignored, as semver requires.
 * @returns -1 if version1 < version2, 0 if equal, 1 if version1 > version2
 */
export function compareVersionsWithPrerelease(rawVersion1: string, rawVersion2: string): number {
    const version1 = rawVersion1.split('+')[0];
    const version2 = rawVersion2.split('+')[0];
    const core = compareVersions(version1, version2);
    if (core !== 0) return core;

    const pre1 = version1.split('-').slice(1).join('-');
    const pre2 = version2.split('-').slice(1).join('-');
    if (!pre1 && !pre2) return 0;
    if (!pre1) return 1;
    if (!pre2) return -1;

    const segments1 = pre1.split('.');
    const segments2 = pre2.split('.');
    const maxLength = Math.max(segments1.length, segments2.length);
    for (let i = 0; i < maxLength; i++) {
        const a = segments1[i];
        const b = segments2[i];
        // Fewer segments ranks lower: "beta" < "beta.2" (semver rule)
        if (a === undefined) return -1;
        if (b === undefined) return 1;
        const aNumeric = /^\d+$/.test(a);
        const bNumeric = /^\d+$/.test(b);
        if (aNumeric && bNumeric) {
            // Digit-string compare (trimmed length, then lexicographic) so
            // identifiers longer than Number's 53-bit precision stay exact.
            const aTrimmed = a.replace(/^0+(?=\d)/, '');
            const bTrimmed = b.replace(/^0+(?=\d)/, '');
            if (aTrimmed.length !== bTrimmed.length) {
                return aTrimmed.length < bTrimmed.length ? -1 : 1;
            }
            if (aTrimmed !== bTrimmed) {
                return aTrimmed < bTrimmed ? -1 : 1;
            }
        } else if (aNumeric !== bNumeric) {
            // Numeric identifiers rank below alphanumeric ones (semver rule)
            return aNumeric ? -1 : 1;
        } else if (a !== b) {
            return a < b ? -1 : 1;
        }
    }
    return 0;
}

/**
 * Check if a version meets the minimum requirement
 * @param version Version to check
 * @param minimumVersion Minimum required version (defaults to MINIMUM_CLI_VERSION)
 * @returns true if version >= minimumVersion
 */
export function isVersionSupported(version: string | undefined, minimumVersion: string = MINIMUM_CLI_VERSION): boolean {
    if (!version) return false;
    
    try {
        return compareVersions(version, minimumVersion) >= 0;
    } catch {
        // If version comparison fails, assume it's not supported
        return false;
    }
}

/**
 * True when the string is a plausible semver: numeric core, optional
 * prerelease, optional build metadata. Callers that gate behavior on version
 * comparisons should treat a present-but-malformed version conservatively
 * rather than comparing garbage.
 */
export function isWellFormedVersion(version: string): boolean {
    return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version);
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