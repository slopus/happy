import { describe, expect, it } from 'vitest';

import {
    buildResumeCapabilityOptionsFromUiState,
    buildResumeSessionExtrasFromUiState,
    buildSpawnSessionExtrasFromUiState,
    buildWakeResumeExtras,
    getNewSessionRelevantInstallableDepKeys,
    getResumePreflightIssues,
    getResumeRuntimeSupportPrefetchPlan,
} from './registryUiBehavior';

describe('buildSpawnSessionExtrasFromUiState', () => {
    it('enables codex resume only when spawning codex with a non-empty resume id', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            experimentsEnabled: true,
            expCodexResume: true,
            expCodexAcp: false,
            resumeSessionId: 'x1',
        })).toEqual({
            experimentalCodexResume: true,
            experimentalCodexAcp: false,
        });

        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            experimentsEnabled: true,
            expCodexResume: true,
            expCodexAcp: false,
            resumeSessionId: '   ',
        })).toEqual({
            experimentalCodexResume: false,
            experimentalCodexAcp: false,
        });
    });

    it('enables codex acp only when spawning codex and the flag is enabled', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            experimentsEnabled: true,
            expCodexResume: false,
            expCodexAcp: true,
            resumeSessionId: '',
        })).toEqual({
            experimentalCodexResume: false,
            experimentalCodexAcp: true,
        });
    });

    it('returns an empty object for non-codex agents', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'claude',
            experimentsEnabled: true,
            expCodexResume: true,
            expCodexAcp: true,
            resumeSessionId: 'x1',
        })).toEqual({});
    });
});

describe('buildResumeSessionExtrasFromUiState', () => {
    it('passes codex experiment flags through when experiments are enabled', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'codex',
            experimentsEnabled: true,
            expCodexResume: true,
            expCodexAcp: false,
        })).toEqual({
            experimentalCodexResume: true,
            experimentalCodexAcp: false,
        });
    });

    it('returns false flags when experiments are disabled', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'codex',
            experimentsEnabled: false,
            expCodexResume: true,
            expCodexAcp: true,
        })).toEqual({});
    });

    it('returns an empty object for non-codex agents', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'claude',
            experimentsEnabled: true,
            expCodexResume: true,
            expCodexAcp: true,
        })).toEqual({});
    });
});

describe('getResumePreflightIssues', () => {
    it('returns a blocking issue when codex resume is requested but the resume dep is not installed', () => {
        expect(getResumePreflightIssues({
            agentId: 'codex',
            experimentsEnabled: true,
            expCodexResume: true,
            expCodexAcp: false,
            deps: {
                codexAcpInstalled: null,
                codexMcpResumeInstalled: false,
            },
        })).toEqual([
            expect.objectContaining({
                id: 'codex-mcp-resume-not-installed',
                action: 'openMachine',
            }),
        ]);
    });

    it('returns a blocking issue when codex acp is requested but the acp dep is not installed', () => {
        expect(getResumePreflightIssues({
            agentId: 'codex',
            experimentsEnabled: true,
            expCodexResume: false,
            expCodexAcp: true,
            deps: {
                codexAcpInstalled: false,
                codexMcpResumeInstalled: null,
            },
        })).toEqual([
            expect.objectContaining({
                id: 'codex-acp-not-installed',
                action: 'openMachine',
            }),
        ]);
    });

    it('returns empty when experiments are disabled or dep status is unknown', () => {
        expect(getResumePreflightIssues({
            agentId: 'codex',
            experimentsEnabled: false,
            expCodexResume: true,
            expCodexAcp: true,
            deps: {
                codexAcpInstalled: false,
                codexMcpResumeInstalled: false,
            },
        })).toEqual([]);

        expect(getResumePreflightIssues({
            agentId: 'codex',
            experimentsEnabled: true,
            expCodexResume: true,
            expCodexAcp: true,
            deps: {
                codexAcpInstalled: null,
                codexMcpResumeInstalled: null,
            },
        })).toEqual([]);
    });

    it('returns empty for non-codex agents', () => {
        expect(getResumePreflightIssues({
            agentId: 'claude',
            experimentsEnabled: true,
            expCodexResume: true,
            expCodexAcp: true,
            deps: {
                codexAcpInstalled: false,
                codexMcpResumeInstalled: false,
            },
        })).toEqual([]);
    });
});

describe('buildWakeResumeExtras', () => {
    it('adds experimentalCodexResume for codex wake payloads only', () => {
        expect(buildWakeResumeExtras({
            agentId: 'claude',
            resumeCapabilityOptions: { allowExperimentalResumeByAgentId: { codex: true } },
        })).toEqual({});
        expect(buildWakeResumeExtras({
            agentId: 'codex',
            resumeCapabilityOptions: { allowExperimentalResumeByAgentId: { codex: true } },
        })).toEqual({ experimentalCodexResume: true });
        expect(buildWakeResumeExtras({
            agentId: 'codex',
            resumeCapabilityOptions: {},
        })).toEqual({});
    });
});

describe('buildResumeCapabilityOptionsFromUiState', () => {
    it('includes codex experimental resume and runtime resume support when detected', () => {
        expect(buildResumeCapabilityOptionsFromUiState({
            experimentsEnabled: true,
            expCodexResume: true,
            expCodexAcp: false,
            results: {
                'cli.gemini': { ok: true, checkedAt: 1, data: { available: true, acp: { ok: true, loadSession: true } } },
            } as any,
        })).toEqual({
            allowExperimentalResumeByAgentId: { codex: true },
            allowRuntimeResumeByAgentId: { gemini: true },
        });
    });

    it('includes OpenCode runtime resume support when detected', () => {
        expect(buildResumeCapabilityOptionsFromUiState({
            experimentsEnabled: false,
            expCodexResume: false,
            expCodexAcp: false,
            results: {
                'cli.opencode': { ok: true, checkedAt: 1, data: { available: true, acp: { ok: true, loadSession: true } } },
            } as any,
        })).toEqual({
            allowRuntimeResumeByAgentId: { opencode: true },
        });
    });
});

describe('getResumeRuntimeSupportPrefetchPlan', () => {
    it('prefetches gemini resume support when the ACP data is missing', () => {
        expect(getResumeRuntimeSupportPrefetchPlan('gemini', undefined)).toEqual({
            request: {
                requests: [
                    {
                        id: 'cli.gemini',
                        params: { includeAcpCapabilities: true, includeLoginStatus: true },
                    },
                ],
            },
            timeoutMs: 8_000,
        });
    });

    it('prefetches opencode resume support when the ACP data is missing', () => {
        expect(getResumeRuntimeSupportPrefetchPlan('opencode', undefined)).toEqual({
            request: {
                requests: [
                    {
                        id: 'cli.opencode',
                        params: { includeAcpCapabilities: true, includeLoginStatus: true },
                    },
                ],
            },
            timeoutMs: 8_000,
        });
    });
});

describe('getNewSessionRelevantInstallableDepKeys', () => {
    it('returns codex deps based on current spawn extras', () => {
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            experimentsEnabled: true,
            expCodexResume: true,
            expCodexAcp: true,
            resumeSessionId: 'x1',
        })).toEqual(['codex-mcp-resume', 'codex-acp']);

        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            experimentsEnabled: true,
            expCodexResume: true,
            expCodexAcp: true,
            resumeSessionId: '',
        })).toEqual(['codex-acp']);
    });

    it('returns empty for non-codex agents and when experiments are disabled', () => {
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'claude',
            experimentsEnabled: true,
            expCodexResume: true,
            expCodexAcp: true,
            resumeSessionId: 'x1',
        })).toEqual([]);

        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            experimentsEnabled: false,
            expCodexResume: true,
            expCodexAcp: true,
            resumeSessionId: 'x1',
        })).toEqual([]);
    });
});
