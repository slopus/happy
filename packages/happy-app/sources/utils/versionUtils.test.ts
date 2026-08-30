import { describe, it, expect } from 'vitest';
import { compareVersions, compareVersionsWithPrerelease, isVersionSupported, parseVersion, MINIMUM_CLI_VERSION } from './versionUtils';

describe('versionUtils', () => {
    describe('compareVersions', () => {
        it('should correctly compare versions', () => {
            expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
            expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
            expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
            expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
            expect(compareVersions('1.9.9', '2.0.0')).toBe(-1);
        });

        it('should handle pre-release versions', () => {
            expect(compareVersions('0.10.0-1', '0.10.0')).toBe(0);
            expect(compareVersions('0.10.0-beta', '0.10.0')).toBe(0);
            expect(compareVersions('0.10.1-1', '0.10.0')).toBe(1);
        });

        it('should handle versions with different segment counts', () => {
            expect(compareVersions('1.0', '1.0.0')).toBe(0);
            expect(compareVersions('1', '1.0.0')).toBe(0);
            expect(compareVersions('1.1', '1.0.5')).toBe(1);
        });
    });

    describe('isVersionSupported', () => {
        it('should check if version meets minimum requirement', () => {
            expect(isVersionSupported('0.10.0', '0.10.0')).toBe(true);
            expect(isVersionSupported('0.10.1', '0.10.0')).toBe(true);
            expect(isVersionSupported('0.9.9', '0.10.0')).toBe(false);
            expect(isVersionSupported('1.0.0', '0.10.0')).toBe(true);
        });

        it('should handle undefined version', () => {
            expect(isVersionSupported(undefined, '0.10.0')).toBe(false);
        });

        it('should use default minimum version', () => {
            expect(isVersionSupported('0.10.0')).toBe(true);
            expect(isVersionSupported('0.9.0')).toBe(false);
        });
    });

    describe('compareVersionsWithPrerelease', () => {
        it('distinguishes prerelease numbers compareVersions collapses', () => {
            expect(compareVersionsWithPrerelease('1.2.1-beta.1', '1.2.1-beta.2')).toBe(-1);
            expect(compareVersionsWithPrerelease('1.2.1-beta.2', '1.2.1-beta.2')).toBe(0);
            expect(compareVersionsWithPrerelease('1.2.1-beta.10', '1.2.1-beta.9')).toBe(1);
        });

        it('ranks a release above its own prereleases', () => {
            expect(compareVersionsWithPrerelease('1.2.1', '1.2.1-beta.2')).toBe(1);
            expect(compareVersionsWithPrerelease('1.2.1-beta.2', '1.2.1')).toBe(-1);
        });

        it('defers to the core version when cores differ', () => {
            expect(compareVersionsWithPrerelease('1.2.2-beta.1', '1.2.1')).toBe(1);
            expect(compareVersionsWithPrerelease('1.2.0', '1.2.1-beta.1')).toBe(-1);
        });

        it('ranks fewer prerelease segments lower and numeric below alphanumeric', () => {
            expect(compareVersionsWithPrerelease('1.2.1-beta', '1.2.1-beta.2')).toBe(-1);
            expect(compareVersionsWithPrerelease('1.2.1-1', '1.2.1-beta')).toBe(-1);
        });

        it('ignores build metadata entirely', () => {
            expect(compareVersionsWithPrerelease('1.2.0+local', '1.2.1-beta.2')).toBe(-1);
            expect(compareVersionsWithPrerelease('1.2.1-beta.1+local', '1.2.1-beta.2')).toBe(-1);
            expect(compareVersionsWithPrerelease('1.2.1-beta.2+local', '1.2.1-beta.2')).toBe(0);
        });

        it('compares numeric identifiers beyond Number precision exactly', () => {
            expect(compareVersionsWithPrerelease(
                '1.0.0-9007199254740993',
                '1.0.0-9007199254740992',
            )).toBe(1);
        });
    });

    describe('parseVersion', () => {
        it('should parse valid version strings', () => {
            expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
            expect(parseVersion('0.10.0')).toEqual({ major: 0, minor: 10, patch: 0 });
            expect(parseVersion('0.10.0-1')).toEqual({ major: 0, minor: 10, patch: 0 });
        });

        it('should return null for invalid versions', () => {
            expect(parseVersion('invalid')).toBe(null);
            expect(parseVersion('')).toBe(null);
            expect(parseVersion('1.a.3')).toBe(null);
        });
    });
});