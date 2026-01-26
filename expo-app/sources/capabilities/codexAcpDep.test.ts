import { describe, expect, it } from 'vitest';

import type { CapabilityDetectResult, CapabilityId } from '@/sync/capabilitiesProtocol';
import {
    CODEX_ACP_DEP_ID,
    getCodexAcpDepData,
    getCodexAcpDetectResult,
    getCodexAcpLatestVersion,
    getCodexAcpRegistryError,
    isCodexAcpUpdateAvailable,
    shouldPrefetchCodexAcpRegistry,
} from './codexAcpDep';

describe('codexAcpDep', () => {
    it('extracts detect result and dep data', () => {
        const detectResult: CapabilityDetectResult = {
            ok: true,
            checkedAt: 123,
            data: {
                installed: true,
                installDir: '/tmp',
                binPath: '/tmp/bin',
                installedVersion: '1.0.0',
                distTag: 'latest',
                lastInstallLogPath: null,
                registry: { ok: true, latestVersion: '1.0.1' },
            },
        };

        const results: Partial<Record<CapabilityId, CapabilityDetectResult>> = {
            [CODEX_ACP_DEP_ID]: detectResult,
        };

        expect(getCodexAcpDetectResult(results)).toEqual(detectResult);
        expect(getCodexAcpDepData(results)?.installedVersion).toBe('1.0.0');
    });

    it('returns null when detect result is missing or not ok', () => {
        expect(getCodexAcpDetectResult(undefined)).toBeNull();
        expect(getCodexAcpDepData(undefined)).toBeNull();

        const results: Partial<Record<CapabilityId, CapabilityDetectResult>> = {
            [CODEX_ACP_DEP_ID]: { ok: false, checkedAt: 1, error: { message: 'no' } },
        };
        expect(getCodexAcpDetectResult(results)?.ok).toBe(false);
        expect(getCodexAcpDepData(results)).toBeNull();
    });

    it('computes latest version, update availability, and registry error', () => {
        const results: Partial<Record<CapabilityId, CapabilityDetectResult>> = {
            [CODEX_ACP_DEP_ID]: {
                ok: true,
                checkedAt: 123,
                data: {
                    installed: true,
                    installDir: '/tmp',
                    binPath: '/tmp/bin',
                    installedVersion: '1.0.0',
                    distTag: 'latest',
                    lastInstallLogPath: null,
                    registry: { ok: true, latestVersion: '1.0.1' },
                },
            },
        };

        const data = getCodexAcpDepData(results);
        expect(getCodexAcpLatestVersion(data)).toBe('1.0.1');
        expect(isCodexAcpUpdateAvailable(data)).toBe(true);
        expect(getCodexAcpRegistryError(data)).toBeNull();

        const resultsInstalledNewer: Partial<Record<CapabilityId, CapabilityDetectResult>> = {
            [CODEX_ACP_DEP_ID]: {
                ok: true,
                checkedAt: 123,
                data: {
                    installed: true,
                    installDir: '/tmp',
                    binPath: '/tmp/bin',
                    installedVersion: '1.0.2',
                    distTag: 'latest',
                    lastInstallLogPath: null,
                    registry: { ok: true, latestVersion: '1.0.1' },
                },
            },
        };
        const dataInstalledNewer = getCodexAcpDepData(resultsInstalledNewer);
        expect(getCodexAcpLatestVersion(dataInstalledNewer)).toBe('1.0.1');
        expect(isCodexAcpUpdateAvailable(dataInstalledNewer)).toBe(false);

        const resultsNonSemver: Partial<Record<CapabilityId, CapabilityDetectResult>> = {
            [CODEX_ACP_DEP_ID]: {
                ok: true,
                checkedAt: 123,
                data: {
                    installed: true,
                    installDir: '/tmp',
                    binPath: '/tmp/bin',
                    installedVersion: 'main',
                    distTag: 'latest',
                    lastInstallLogPath: null,
                    registry: { ok: true, latestVersion: '1.0.1' },
                },
            },
        };
        const dataNonSemver = getCodexAcpDepData(resultsNonSemver);
        expect(getCodexAcpLatestVersion(dataNonSemver)).toBe('1.0.1');
        expect(isCodexAcpUpdateAvailable(dataNonSemver)).toBe(false);

        const resultsErr: Partial<Record<CapabilityId, CapabilityDetectResult>> = {
            [CODEX_ACP_DEP_ID]: {
                ok: true,
                checkedAt: 123,
                data: {
                    installed: true,
                    installDir: '/tmp',
                    binPath: '/tmp/bin',
                    installedVersion: '1.0.0',
                    distTag: 'latest',
                    lastInstallLogPath: null,
                    registry: { ok: false, errorMessage: 'boom' },
                },
            },
        };
        const dataErr = getCodexAcpDepData(resultsErr);
        expect(getCodexAcpLatestVersion(dataErr)).toBeNull();
        expect(isCodexAcpUpdateAvailable(dataErr)).toBe(false);
        expect(getCodexAcpRegistryError(dataErr)).toBe('boom');
    });

    it('prefetches registry when missing or stale', () => {
        expect(shouldPrefetchCodexAcpRegistry({ requireExistingResult: false, result: null, data: null })).toBe(true);
        expect(shouldPrefetchCodexAcpRegistry({ requireExistingResult: true, result: null, data: null })).toBe(false);

        // Installed but no registry payload => fetch.
        expect(shouldPrefetchCodexAcpRegistry({
            requireExistingResult: true,
            result: { ok: true, checkedAt: 123, data: {} },
            data: {
                installed: true,
                installDir: '/tmp',
                binPath: null,
                installedVersion: '1.0.0',
                distTag: 'latest',
                lastInstallLogPath: null,
            },
        })).toBe(true);

        // Fresh ok registry should not fetch when timestamp is recent.
        expect(shouldPrefetchCodexAcpRegistry({
            requireExistingResult: true,
            result: { ok: true, checkedAt: Date.now(), data: {} },
            data: {
                installed: true,
                installDir: '/tmp',
                binPath: null,
                installedVersion: '1.0.0',
                distTag: 'latest',
                lastInstallLogPath: null,
                registry: { ok: true, latestVersion: '1.0.1' },
            },
        })).toBe(false);

        // Successful registry checks should re-check after a reasonable time window.
        const dayMs = 24 * 60 * 60 * 1000;
        const now = Date.now();
        expect(shouldPrefetchCodexAcpRegistry({
            requireExistingResult: true,
            result: { ok: true, checkedAt: now - (2 * dayMs), data: {} },
            data: {
                installed: true,
                installDir: '/tmp',
                binPath: null,
                installedVersion: '1.0.0',
                distTag: 'latest',
                lastInstallLogPath: null,
                registry: { ok: true, latestVersion: '1.0.1' },
            },
        })).toBe(true);
        expect(shouldPrefetchCodexAcpRegistry({
            requireExistingResult: true,
            result: { ok: true, checkedAt: now - (1 * 60 * 60 * 1000), data: {} },
            data: {
                installed: true,
                installDir: '/tmp',
                binPath: null,
                installedVersion: '1.0.0',
                distTag: 'latest',
                lastInstallLogPath: null,
                registry: { ok: true, latestVersion: '1.0.1' },
            },
        })).toBe(false);
    });
});
