import { buildAcpLoadSessionPrefetchRequest, readAcpLoadSessionSupport, shouldPrefetchAcpCapabilities } from '@/agents/acpRuntimeResume';
import type { ResumeCapabilityOptions } from '@/agents/resumeCapabilities';

import type {
    AgentUiBehavior,
    NewSessionPreflightContext,
    NewSessionPreflightIssue,
    NewSessionRelevantInstallableDepsContext,
    ResumePreflightContext,
} from '@/agents/registryUiBehavior';

export type CodexSpawnSessionExtras = Readonly<{
    experimentalCodexResume: boolean;
    experimentalCodexAcp: boolean;
}>;

export type CodexResumeSessionExtras = Readonly<{
    experimentalCodexResume: boolean;
    experimentalCodexAcp: boolean;
}>;

export function computeCodexSpawnSessionExtras(opts: {
    agentId: string;
    experimentsEnabled: boolean;
    expCodexResume: boolean;
    expCodexAcp: boolean;
    resumeSessionId: string;
}): CodexSpawnSessionExtras | null {
    if (opts.agentId !== 'codex') return null;
    if (opts.experimentsEnabled !== true) return null;
    return {
        experimentalCodexResume: opts.expCodexResume === true && opts.resumeSessionId.trim().length > 0,
        experimentalCodexAcp: opts.expCodexAcp === true,
    };
}

export function computeCodexResumeSessionExtras(opts: {
    agentId: string;
    experimentsEnabled: boolean;
    expCodexResume: boolean;
    expCodexAcp: boolean;
}): CodexResumeSessionExtras | null {
    if (opts.agentId !== 'codex') return null;
    if (opts.experimentsEnabled !== true) return null;
    return {
        experimentalCodexResume: opts.expCodexResume === true,
        experimentalCodexAcp: opts.expCodexAcp === true,
    };
}

export function getCodexNewSessionPreflightIssues(ctx: NewSessionPreflightContext): readonly NewSessionPreflightIssue[] {
    if (ctx.agentId !== 'codex') return [];
    const extras = computeCodexSpawnSessionExtras({
        agentId: 'codex',
        experimentsEnabled: ctx.experimentsEnabled,
        expCodexResume: ctx.expCodexResume,
        expCodexAcp: ctx.expCodexAcp,
        resumeSessionId: ctx.resumeSessionId,
    });

    const issues: NewSessionPreflightIssue[] = [];
    if (extras?.experimentalCodexAcp === true && ctx.deps.codexAcpInstalled === false) {
        issues.push({
            id: 'codex-acp-not-installed',
            titleKey: 'errors.codexAcpNotInstalledTitle',
            messageKey: 'errors.codexAcpNotInstalledMessage',
            confirmTextKey: 'connect.openMachine',
            action: 'openMachine',
        });
    }
    if (extras?.experimentalCodexResume === true && ctx.deps.codexMcpResumeInstalled === false) {
        issues.push({
            id: 'codex-mcp-resume-not-installed',
            titleKey: 'errors.codexResumeNotInstalledTitle',
            messageKey: 'errors.codexResumeNotInstalledMessage',
            confirmTextKey: 'connect.openMachine',
            action: 'openMachine',
        });
    }
    return issues;
}

export function getCodexNewSessionRelevantInstallableDepKeys(ctx: NewSessionRelevantInstallableDepsContext): readonly string[] {
    if (ctx.agentId !== 'codex') return [];
    if (ctx.experimentsEnabled !== true) return [];

    const extras = computeCodexSpawnSessionExtras({
        agentId: 'codex',
        experimentsEnabled: ctx.experimentsEnabled,
        expCodexResume: ctx.expCodexResume,
        expCodexAcp: ctx.expCodexAcp,
        resumeSessionId: ctx.resumeSessionId,
    });

    const keys: string[] = [];
    if (extras?.experimentalCodexResume === true) keys.push('codex-mcp-resume');
    if (extras?.experimentalCodexAcp === true) keys.push('codex-acp');
    return keys;
}

export function getCodexResumePreflightIssues(ctx: ResumePreflightContext): readonly NewSessionPreflightIssue[] {
    const extras = computeCodexResumeSessionExtras({
        agentId: 'codex',
        experimentsEnabled: ctx.experimentsEnabled,
        expCodexResume: ctx.expCodexResume,
        expCodexAcp: ctx.expCodexAcp,
    });
    if (!extras) return [];

    const issues: NewSessionPreflightIssue[] = [];
    if (extras.experimentalCodexAcp === true && ctx.deps.codexAcpInstalled === false) {
        issues.push({
            id: 'codex-acp-not-installed',
            titleKey: 'errors.codexAcpNotInstalledTitle',
            messageKey: 'errors.codexAcpNotInstalledMessage',
            confirmTextKey: 'connect.openMachine',
            action: 'openMachine',
        });
    }
    if (extras.experimentalCodexResume === true && ctx.deps.codexMcpResumeInstalled === false) {
        issues.push({
            id: 'codex-mcp-resume-not-installed',
            titleKey: 'errors.codexResumeNotInstalledTitle',
            messageKey: 'errors.codexResumeNotInstalledMessage',
            confirmTextKey: 'connect.openMachine',
            action: 'openMachine',
        });
    }
    return issues;
}

export const CODEX_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    resume: {
        getAllowExperimentalVendorResume: ({ experimentsEnabled, expCodexResume, expCodexAcp }) => {
            return experimentsEnabled && (expCodexResume || expCodexAcp);
        },
        // Codex ACP mode can support vendor-resume via ACP `loadSession`.
        // We probe this dynamically (same as Gemini/OpenCode) and only enforce it when `expCodexAcp` is enabled.
        getAllowRuntimeResume: (results) => readAcpLoadSessionSupport('codex', results),
        getRuntimeResumePrefetchPlan: (results) => {
            if (!shouldPrefetchAcpCapabilities('codex', results)) return null;
            return { request: buildAcpLoadSessionPrefetchRequest('codex'), timeoutMs: 8_000 };
        },
    },
    newSession: {
        getPreflightIssues: getCodexNewSessionPreflightIssues,
        getRelevantInstallableDepKeys: getCodexNewSessionRelevantInstallableDepKeys,
    },
    payload: {
        buildSpawnSessionExtras: ({ agentId, experimentsEnabled, expCodexResume, expCodexAcp, resumeSessionId }) => {
            const extras = computeCodexSpawnSessionExtras({
                agentId,
                experimentsEnabled,
                expCodexResume,
                expCodexAcp,
                resumeSessionId,
            });
            return extras ?? {};
        },
        buildResumeSessionExtras: ({ agentId, experimentsEnabled, expCodexResume, expCodexAcp }) => {
            const extras = computeCodexResumeSessionExtras({
                agentId,
                experimentsEnabled,
                expCodexResume,
                expCodexAcp,
            });
            return extras ?? {};
        },
        buildWakeResumeExtras: ({ resumeCapabilityOptions }: { resumeCapabilityOptions: ResumeCapabilityOptions }) => {
            const allowCodexResume = resumeCapabilityOptions.allowExperimentalResumeByAgentId?.codex === true;
            return allowCodexResume ? { experimentalCodexResume: true } : {};
        },
    },
};
