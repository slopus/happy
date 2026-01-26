import { describe, expect, it } from 'vitest';

import type { CapabilityDetectResult, CapabilityId } from '@/sync/capabilitiesProtocol';
import {
    CODEX_MCP_RESUME_DEP_ID,
    getCodexMcpResumeDepData,
    getCodexMcpResumeDetectResult,
    getCodexMcpResumeLatestVersion,
    getCodexMcpResumeRegistryError,
    isCodexMcpResumeUpdateAvailable,
    shouldPrefetchCodexMcpResumeRegistry,
} from './codexMcpResume';

describe('codexMcpResume', () => {
    it('extracts detect result and dep data', () => {
        const detectResult: CapabilityDetectResult = {
            ok: true,
            checkedAt: 123,
            data: {
                installed: true,
                installDir: '/tmp',
                binPath: '/tmp/bin',
                installedVersion: '1.0.0',
                distTag: 'happy-codex-resume',
                lastInstallLogPath: null,
                registry: { ok: true, latestVersion: '1.0.1' },
            },
        };

        const results: Partial<Record<CapabilityId, CapabilityDetectResult>> = {
            [CODEX_MCP_RESUME_DEP_ID]: detectResult,
        };

        expect(getCodexMcpResumeDetectResult(results)).toEqual(detectResult);
        expect(getCodexMcpResumeDepData(results)?.installedVersion).toBe('1.0.0');
    });

    it('returns null when detect result is missing or not ok', () => {
        expect(getCodexMcpResumeDetectResult(undefined)).toBeNull();
        expect(getCodexMcpResumeDepData(undefined)).toBeNull();

        const results: Partial<Record<CapabilityId, CapabilityDetectResult>> = {
            [CODEX_MCP_RESUME_DEP_ID]: { ok: false, checkedAt: 1, error: { message: 'no' } },
        };
        expect(getCodexMcpResumeDetectResult(results)?.ok).toBe(false);
        expect(getCodexMcpResumeDepData(results)).toBeNull();
    });

    it('computes latest version, update availability, and registry error', () => {
        const results: Partial<Record<CapabilityId, CapabilityDetectResult>> = {
            [CODEX_MCP_RESUME_DEP_ID]: {
                ok: true,
                checkedAt: 123,
                data: {
                    installed: true,
                    installDir: '/tmp',
                    binPath: '/tmp/bin',
                    installedVersion: '1.0.0',
                    distTag: 'happy-codex-resume',
                    lastInstallLogPath: null,
                    registry: { ok: true, latestVersion: '1.0.1' },
                },
            },
        };

        const data = getCodexMcpResumeDepData(results);
        expect(getCodexMcpResumeLatestVersion(data)).toBe('1.0.1');
        expect(isCodexMcpResumeUpdateAvailable(data)).toBe(true);
        expect(getCodexMcpResumeRegistryError(data)).toBeNull();

        const resultsInstalledNewer: Partial<Record<CapabilityId, CapabilityDetectResult>> = {
            [CODEX_MCP_RESUME_DEP_ID]: {
                ok: true,
                checkedAt: 123,
                data: {
                    installed: true,
                    installDir: '/tmp',
                    binPath: '/tmp/bin',
                    installedVersion: '1.0.2',
                    distTag: 'happy-codex-resume',
                    lastInstallLogPath: null,
                    registry: { ok: true, latestVersion: '1.0.1' },
                },
            },
        };
        const dataInstalledNewer = getCodexMcpResumeDepData(resultsInstalledNewer);
        expect(getCodexMcpResumeLatestVersion(dataInstalledNewer)).toBe('1.0.1');
        expect(isCodexMcpResumeUpdateAvailable(dataInstalledNewer)).toBe(false);

        const resultsNonSemver: Partial<Record<CapabilityId, CapabilityDetectResult>> = {
            [CODEX_MCP_RESUME_DEP_ID]: {
                ok: true,
                checkedAt: 123,
                data: {
                    installed: true,
                    installDir: '/tmp',
                    binPath: '/tmp/bin',
                    installedVersion: 'main',
                    distTag: 'happy-codex-resume',
                    lastInstallLogPath: null,
                    registry: { ok: true, latestVersion: '1.0.1' },
                },
            },
        };
        const dataNonSemver = getCodexMcpResumeDepData(resultsNonSemver);
        expect(getCodexMcpResumeLatestVersion(dataNonSemver)).toBe('1.0.1');
        expect(isCodexMcpResumeUpdateAvailable(dataNonSemver)).toBe(false);

        const resultsErr: Partial<Record<CapabilityId, CapabilityDetectResult>> = {
            [CODEX_MCP_RESUME_DEP_ID]: {
                ok: true,
                checkedAt: 123,
                data: {
                    installed: true,
                    installDir: '/tmp',
                    binPath: '/tmp/bin',
                    installedVersion: '1.0.0',
                    distTag: 'happy-codex-resume',
                    lastInstallLogPath: null,
                    registry: { ok: false, errorMessage: 'boom' },
                },
            },
        };
        const dataErr = getCodexMcpResumeDepData(resultsErr);
        expect(getCodexMcpResumeLatestVersion(dataErr)).toBeNull();
        expect(isCodexMcpResumeUpdateAvailable(dataErr)).toBe(false);
        expect(getCodexMcpResumeRegistryError(dataErr)).toBe('boom');
    });

    it('prefetches registry when missing or stale', () => {
        expect(shouldPrefetchCodexMcpResumeRegistry({ requireExistingResult: false, result: null, data: null })).toBe(true);
        expect(shouldPrefetchCodexMcpResumeRegistry({ requireExistingResult: true, result: null, data: null })).toBe(false);

        // Installed but no registry payload => fetch.
        expect(shouldPrefetchCodexMcpResumeRegistry({
            requireExistingResult: true,
            result: { ok: true, checkedAt: 123, data: {} },
            data: {
                installed: true,
                installDir: '/tmp',
                binPath: null,
                installedVersion: '1.0.0',
                distTag: 'happy-codex-resume',
                lastInstallLogPath: null,
            },
        })).toBe(true);

        // Fresh ok registry should not fetch when timestamp is recent.
        expect(shouldPrefetchCodexMcpResumeRegistry({
            requireExistingResult: true,
            result: { ok: true, checkedAt: Date.now(), data: {} },
            data: {
                installed: true,
                installDir: '/tmp',
                binPath: null,
                installedVersion: '1.0.0',
                distTag: 'happy-codex-resume',
                lastInstallLogPath: null,
                registry: { ok: true, latestVersion: '1.0.1' },
            },
        })).toBe(false);

        // Successful registry checks should re-check after a reasonable time window.
        const dayMs = 24 * 60 * 60 * 1000;
        const now = Date.now();
        expect(shouldPrefetchCodexMcpResumeRegistry({
            requireExistingResult: true,
            result: { ok: true, checkedAt: now - (2 * dayMs), data: {} },
            data: {
                installed: true,
                installDir: '/tmp',
                binPath: null,
                installedVersion: '1.0.0',
                distTag: 'happy-codex-resume',
                lastInstallLogPath: null,
                registry: { ok: true, latestVersion: '1.0.1' },
            },
        })).toBe(true);
        expect(shouldPrefetchCodexMcpResumeRegistry({
            requireExistingResult: true,
            result: { ok: true, checkedAt: now - (1 * 60 * 60 * 1000), data: {} },
            data: {
                installed: true,
                installDir: '/tmp',
                binPath: null,
                installedVersion: '1.0.0',
                distTag: 'happy-codex-resume',
                lastInstallLogPath: null,
                registry: { ok: true, latestVersion: '1.0.1' },
            },
        })).toBe(false);
    });
});
