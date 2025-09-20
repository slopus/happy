/**
 * Utility functions for version comparison and validation
 */

// Minimum required CLI version for full compatibility
// Set to 0.1.0 to maintain backwards compatibility with older CLI versions
// Note: Some features (git status sync, file browser) require 0.11.0+ but will gracefully degrade
export const MINIMUM_CLI_VERSION = "0.1.0";

// Version for advanced features
export const ADVANCED_FEATURES_CLI_VERSION = "0.11.0";

/**
 * Compare two semantic version strings
 * @param version1 First version to compare
 * @param version2 Second version to compare
 * @returns -1 if version1 < version2, 0 if equal, 1 if version1 > version2
 */
export function compareVersions(version1: string, version2: string): number {
	// Handle pre-release versions by stripping suffix (e.g., "0.10.0-1" -> "0.10.0")
	const cleanVersion = (v: string) => v.split("-")[0];

	const v1Parts = cleanVersion(version1).split(".").map(Number);
	const v2Parts = cleanVersion(version2).split(".").map(Number);

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
 * @param minimumVersion Minimum required version (defaults to MINIMUM_CLI_VERSION)
 * @returns true if version >= minimumVersion
 */
export function isVersionSupported(
	version: string | undefined,
	minimumVersion: string = MINIMUM_CLI_VERSION,
): boolean {
	if (!version) return false;

	try {
		return compareVersions(version, minimumVersion) >= 0;
	} catch {
		// If version comparison fails, assume it's not supported
		return false;
	}
}

/**
 * Check if a version supports advanced features (git status sync, file browser)
 * @param version Version to check
 * @returns true if version >= ADVANCED_FEATURES_CLI_VERSION
 */
export function supportsAdvancedFeatures(version: string | undefined): boolean {
	return isVersionSupported(version, ADVANCED_FEATURES_CLI_VERSION);
}

/**
 * Parse version string to extract major, minor, and patch numbers
 * @param version Version string to parse
 * @returns Object with major, minor, and patch numbers, or null if invalid
 */
export function parseVersion(
	version: string,
): { major: number; minor: number; patch: number } | null {
	try {
		const cleanVersion = version.split("-")[0];
		const [major, minor, patch] = cleanVersion.split(".").map(Number);

		if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
			return null;
		}

		return { major, minor, patch };
	} catch {
		return null;
	}
}
