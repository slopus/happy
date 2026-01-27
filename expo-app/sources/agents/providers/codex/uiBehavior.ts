import { buildAcpLoadSessionPrefetchRequest, readAcpLoadSessionSupport, shouldPrefetchAcpCapabilities } from '@/agents/acpRuntimeResume';
import type { ResumeCapabilityOptions } from '@/agents/resumeCapabilities';
import { getCodexAcpDepData } from '@/capabilities/codexAcpDep';
import { getCodexMcpResumeDepData } from '@/capabilities/codexMcpResume';
import { resumeChecklistId } from '@happy/protocol/checklists';
import type { CapabilitiesDetectRequest } from '@/sync/capabilitiesProtocol';

import type {
    AgentResumeExperiments,
    AgentUiBehavior,
    NewSessionPreflightContext,
    NewSessionPreflightIssue,
    NewSessionRelevantInstallableDepsContext,
    ResumePreflightContext,
} from '@/agents/registryUiBehavior';

const CODEX_SWITCH_RESUME_MCP = 'resumeMcp';
const CODEX_SWITCH_RESUME_ACP = 'resumeAcp';

function getSwitch(experiments: AgentResumeExperiments, id: string): boolean {
    return experiments.switches[id] === true;
}

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
    experiments: AgentResumeExperiments;
    resumeSessionId: string;
}): CodexSpawnSessionExtras | null {
    if (opts.agentId !== 'codex') return null;
    if (opts.experiments.enabled !== true) return null;
    return {
        experimentalCodexResume: getSwitch(opts.experiments, CODEX_SWITCH_RESUME_MCP) === true && opts.resumeSessionId.trim().length > 0,
        experimentalCodexAcp: getSwitch(opts.experiments, CODEX_SWITCH_RESUME_ACP) === true,
    };
}

export function computeCodexResumeSessionExtras(opts: {
    agentId: string;
    experiments: AgentResumeExperiments;
}): CodexResumeSessionExtras | null {
    if (opts.agentId !== 'codex') return null;
    if (opts.experiments.enabled !== true) return null;
    return {
        experimentalCodexResume: getSwitch(opts.experiments, CODEX_SWITCH_RESUME_MCP) === true,
        experimentalCodexAcp: getSwitch(opts.experiments, CODEX_SWITCH_RESUME_ACP) === true,
    };
}

export function getCodexNewSessionPreflightIssues(ctx: NewSessionPreflightContext): readonly NewSessionPreflightIssue[] {
    if (ctx.agentId !== 'codex') return [];
    const extras = computeCodexSpawnSessionExtras({
        agentId: 'codex',
        experiments: ctx.experiments,
        resumeSessionId: ctx.resumeSessionId,
    });

    const codexAcpDep = getCodexAcpDepData(ctx.results);
    const codexMcpResumeDep = getCodexMcpResumeDepData(ctx.results);
    const deps = {
        codexAcpInstalled: typeof codexAcpDep?.installed === 'boolean' ? codexAcpDep.installed : null,
        codexMcpResumeInstalled: typeof codexMcpResumeDep?.installed === 'boolean' ? codexMcpResumeDep.installed : null,
    };

    const issues: NewSessionPreflightIssue[] = [];
    if (extras?.experimentalCodexAcp === true && deps.codexAcpInstalled === false) {
        issues.push({
            id: 'codex-acp-not-installed',
            titleKey: 'errors.codexAcpNotInstalledTitle',
            messageKey: 'errors.codexAcpNotInstalledMessage',
            confirmTextKey: 'connect.openMachine',
            action: 'openMachine',
        });
    }
    if (extras?.experimentalCodexResume === true && deps.codexMcpResumeInstalled === false) {
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
    if (ctx.experiments.enabled !== true) return [];

    const extras = computeCodexSpawnSessionExtras({
        agentId: 'codex',
        experiments: ctx.experiments,
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
        experiments: ctx.experiments,
    });
    if (!extras) return [];

    const codexAcpDep = getCodexAcpDepData(ctx.results);
    const codexMcpResumeDep = getCodexMcpResumeDepData(ctx.results);
    const deps = {
        codexAcpInstalled: typeof codexAcpDep?.installed === 'boolean' ? codexAcpDep.installed : null,
        codexMcpResumeInstalled: typeof codexMcpResumeDep?.installed === 'boolean' ? codexMcpResumeDep.installed : null,
    };

    const issues: NewSessionPreflightIssue[] = [];
    if (extras.experimentalCodexAcp === true && deps.codexAcpInstalled === false) {
        issues.push({
            id: 'codex-acp-not-installed',
            titleKey: 'errors.codexAcpNotInstalledTitle',
            messageKey: 'errors.codexAcpNotInstalledMessage',
            confirmTextKey: 'connect.openMachine',
            action: 'openMachine',
        });
    }
    if (extras.experimentalCodexResume === true && deps.codexMcpResumeInstalled === false) {
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
        experimentSwitches: [
            { id: CODEX_SWITCH_RESUME_MCP, settingKey: 'expCodexResume' },
            { id: CODEX_SWITCH_RESUME_ACP, settingKey: 'expCodexAcp' },
        ],
        getAllowExperimentalVendorResume: ({ experiments }) => {
            return experiments.enabled === true && (getSwitch(experiments, CODEX_SWITCH_RESUME_MCP) || getSwitch(experiments, CODEX_SWITCH_RESUME_ACP));
        },
        getExperimentalVendorResumeRequiresRuntime: ({ experiments }) => {
            if (experiments.enabled !== true) return false;
            // ACP-only mode must fail closed until ACP loadSession support is confirmed.
            return getSwitch(experiments, CODEX_SWITCH_RESUME_ACP) === true && getSwitch(experiments, CODEX_SWITCH_RESUME_MCP) !== true;
        },
        // Codex ACP mode can support vendor-resume via ACP `loadSession`.
        // We probe this dynamically (same as Gemini/OpenCode) and only enforce it when `expCodexAcp` is enabled.
        getAllowRuntimeResume: ({ experiments, results }) => {
            if (experiments.enabled !== true) return false;
            if (getSwitch(experiments, CODEX_SWITCH_RESUME_ACP) !== true) return false;
            return readAcpLoadSessionSupport('codex', results);
        },
        getRuntimeResumePrefetchPlan: ({ experiments, results }) => {
            if (experiments.enabled !== true) return null;
            if (getSwitch(experiments, CODEX_SWITCH_RESUME_ACP) !== true) return null;
            if (!shouldPrefetchAcpCapabilities('codex', results)) return null;
            return { request: buildAcpLoadSessionPrefetchRequest('codex'), timeoutMs: 8_000 };
        },
        getPreflightPrefetchPlan: ({ experiments }) => {
            if (experiments.enabled !== true) return null;
            if (!(getSwitch(experiments, CODEX_SWITCH_RESUME_MCP) || getSwitch(experiments, CODEX_SWITCH_RESUME_ACP))) return null;
            const request: CapabilitiesDetectRequest = { checklistId: resumeChecklistId('codex') };
            return { request, timeoutMs: 12_000 };
        },
        getPreflightIssues: getCodexResumePreflightIssues,
    },
    newSession: {
        getPreflightIssues: getCodexNewSessionPreflightIssues,
        getRelevantInstallableDepKeys: getCodexNewSessionRelevantInstallableDepKeys,
    },
    payload: {
        buildSpawnSessionExtras: ({ agentId, experiments, resumeSessionId }) => {
            const extras = computeCodexSpawnSessionExtras({
                agentId,
                experiments,
                resumeSessionId,
            });
            return extras ?? {};
        },
        buildResumeSessionExtras: ({ agentId, experiments }) => {
            const extras = computeCodexResumeSessionExtras({
                agentId,
                experiments,
            });
            return extras ?? {};
        },
        buildWakeResumeExtras: ({ resumeCapabilityOptions }: { resumeCapabilityOptions: ResumeCapabilityOptions }) => {
            const allowCodexResume = resumeCapabilityOptions.allowExperimentalResumeByAgentId?.codex === true;
            return allowCodexResume ? { experimentalCodexResume: true } : {};
        },
    },
};
