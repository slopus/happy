import { describe, expect, it } from 'vitest';

import { settingsDefaults } from '@/sync/settings';

import {
    buildResumeCapabilityOptionsFromUiState,
    buildResumeSessionExtrasFromUiState,
    buildSpawnSessionExtrasFromUiState,
    buildWakeResumeExtras,
    getAgentResumeExperimentsFromSettings,
    getNewSessionPreflightIssues,
    getNewSessionRelevantInstallableDepKeys,
    getResumePreflightIssues,
    getResumePreflightPrefetchPlan,
    getResumeRuntimeSupportPrefetchPlan,
} from './registryUiBehavior';

function makeSettings(overrides: Partial<typeof settingsDefaults> = {}) {
    return { ...settingsDefaults, ...overrides };
}

describe('buildSpawnSessionExtrasFromUiState', () => {
    it('enables codex resume only when spawning codex with a non-empty resume id', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: false }),
            resumeSessionId: 'x1',
        })).toEqual({
            experimentalCodexResume: true,
            experimentalCodexAcp: false,
        });

        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: false }),
            resumeSessionId: '   ',
        })).toEqual({
            experimentalCodexResume: false,
            experimentalCodexAcp: false,
        });
    });

    it('enables codex acp only when spawning codex and the flag is enabled', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ experiments: true, expCodexResume: false, expCodexAcp: true }),
            resumeSessionId: '',
        })).toEqual({
            experimentalCodexResume: false,
            experimentalCodexAcp: true,
        });
    });

    it('returns an empty object for non-codex agents', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'claude',
            settings: makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: true }),
            resumeSessionId: 'x1',
        })).toEqual({});
    });
});

describe('buildResumeSessionExtrasFromUiState', () => {
    it('passes codex experiment flags through when experiments are enabled', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: false }),
        })).toEqual({
            experimentalCodexResume: true,
            experimentalCodexAcp: false,
        });
    });

    it('returns false flags when experiments are disabled', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ experiments: false, expCodexResume: true, expCodexAcp: true }),
        })).toEqual({});
    });

    it('returns an empty object for non-codex agents', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'claude',
            settings: makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: true }),
        })).toEqual({});
    });
});

describe('getResumePreflightIssues', () => {
    it('returns a blocking issue when codex resume is requested but the resume dep is not installed', () => {
        const settings = makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: false });
        expect(getResumePreflightIssues({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', settings),
            results: {
                'dep.codex-mcp-resume': { ok: true, checkedAt: 1, data: { installed: false } },
            },
        })).toEqual([
            expect.objectContaining({
                id: 'codex-mcp-resume-not-installed',
                action: 'openMachine',
            }),
        ]);
    });

    it('returns a blocking issue when codex acp is requested but the acp dep is not installed', () => {
        const settings = makeSettings({ experiments: true, expCodexResume: false, expCodexAcp: true });
        expect(getResumePreflightIssues({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', settings),
            results: {
                'dep.codex-acp': { ok: true, checkedAt: 1, data: { installed: false } },
            },
        })).toEqual([
            expect.objectContaining({
                id: 'codex-acp-not-installed',
                action: 'openMachine',
            }),
        ]);
    });

    it('returns empty when experiments are disabled or dep status is unknown', () => {
        const disabled = makeSettings({ experiments: false, expCodexResume: true, expCodexAcp: true });
        expect(getResumePreflightIssues({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', disabled),
            results: {
                'dep.codex-acp': { ok: true, checkedAt: 1, data: { installed: false } },
                'dep.codex-mcp-resume': { ok: true, checkedAt: 1, data: { installed: false } },
            } as any,
        })).toEqual([]);

        const unknown = makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: true });
        expect(getResumePreflightIssues({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', unknown),
            results: {} as any,
        })).toEqual([]);
    });

    it('returns empty for non-codex agents', () => {
        const settings = makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: true });
        expect(getResumePreflightIssues({
            agentId: 'claude',
            experiments: getAgentResumeExperimentsFromSettings('claude', settings),
            results: {} as any,
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
        const settings = makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: false });
        expect(buildResumeCapabilityOptionsFromUiState({
            settings,
            results: {
                'cli.gemini': { ok: true, checkedAt: 1, data: { available: true, acp: { ok: true, loadSession: true } } },
            } as any,
        })).toEqual({
            allowExperimentalResumeByAgentId: { codex: true },
            allowRuntimeResumeByAgentId: { gemini: true },
        });
    });

    it('includes OpenCode runtime resume support when detected', () => {
        const settings = makeSettings({ experiments: false, expCodexResume: false, expCodexAcp: false });
        expect(buildResumeCapabilityOptionsFromUiState({
            settings,
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
        expect(getResumeRuntimeSupportPrefetchPlan({ agentId: 'gemini', settings: makeSettings(), results: undefined })).toEqual({
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
        expect(getResumeRuntimeSupportPrefetchPlan({ agentId: 'opencode', settings: makeSettings(), results: undefined })).toEqual({
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

describe('getResumePreflightPrefetchPlan', () => {
    it('prefetches codex resume checklist only when codex experiments are enabled', () => {
        const disabled = makeSettings({ experiments: false, expCodexResume: true, expCodexAcp: true });
        expect(getResumePreflightPrefetchPlan({ agentId: 'codex', settings: disabled, results: undefined })).toEqual(null);

        const enabled = makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: false });
        expect(getResumePreflightPrefetchPlan({ agentId: 'codex', settings: enabled, results: undefined })).toEqual(
            expect.objectContaining({
                request: expect.objectContaining({ checklistId: expect.stringContaining('resume.codex') }),
            }),
        );
    });
});

describe('getNewSessionRelevantInstallableDepKeys', () => {
    it('returns codex deps based on current spawn extras', () => {
        const settings = makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: true });
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', settings),
            resumeSessionId: 'x1',
        })).toEqual(['codex-mcp-resume', 'codex-acp']);

        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', settings),
            resumeSessionId: '',
        })).toEqual(['codex-acp']);
    });

    it('returns empty for non-codex agents and when experiments are disabled', () => {
        const settings = makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: true });
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'claude',
            experiments: getAgentResumeExperimentsFromSettings('claude', settings),
            resumeSessionId: 'x1',
        })).toEqual([]);

        const disabled = makeSettings({ experiments: false, expCodexResume: true, expCodexAcp: true });
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', disabled),
            resumeSessionId: 'x1',
        })).toEqual([]);
    });
});

describe('getNewSessionPreflightIssues', () => {
    it('returns codex preflight issues based on machine results (deps missing)', () => {
        const settings = makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: true });
        const issues = getNewSessionPreflightIssues({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', settings),
            resumeSessionId: 'x1',
            results: {
                'dep.codex-mcp-resume': { ok: true, checkedAt: 1, data: { installed: false } },
                'dep.codex-acp': { ok: true, checkedAt: 1, data: { installed: false } },
            } as any,
        });
        expect(issues.length).toBeGreaterThan(0);
        expect(issues[0]).toEqual(expect.objectContaining({ id: 'codex-acp-not-installed' }));
        expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'codex-mcp-resume-not-installed' })]));
    });
});
