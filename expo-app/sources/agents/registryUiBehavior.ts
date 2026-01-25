import type { AgentId } from './registryCore';
import { AGENT_IDS, getAgentCore } from './registryCore';
import type { CapabilitiesDetectRequest, CapabilityDetectResult, CapabilityId } from '@/sync/capabilitiesProtocol';
import type { ResumeCapabilityOptions } from '@/utils/agentCapabilities';
import type { TranslationKey } from '@/text';
import { buildAcpLoadSessionPrefetchRequest, readAcpLoadSessionSupport, shouldPrefetchAcpCapabilities } from './acpRuntimeResume';

type CapabilityResults = Partial<Record<CapabilityId, CapabilityDetectResult>>;

export type ResumeRuntimeSupportPrefetchPlan = Readonly<{
    request: CapabilitiesDetectRequest;
    timeoutMs: number;
}>;

export type AgentUiBehavior = Readonly<{
    resume?: Readonly<{
        getAllowExperimentalVendorResume?: (opts: {
            experimentsEnabled: boolean;
            expCodexResume: boolean;
            expCodexAcp: boolean;
        }) => boolean;
        getAllowRuntimeResume?: (results: CapabilityResults | undefined) => boolean;
        getRuntimeResumePrefetchPlan?: (results: CapabilityResults | undefined) => ResumeRuntimeSupportPrefetchPlan | null;
    }>;
    newSession?: Readonly<{
        getPreflightIssues?: (ctx: NewSessionPreflightContext) => readonly NewSessionPreflightIssue[];
        getRelevantInstallableDepKeys?: (ctx: NewSessionRelevantInstallableDepsContext) => readonly string[];
    }>;
    payload?: Readonly<{
        buildSpawnSessionExtras?: (opts: {
            agentId: AgentId;
            experimentsEnabled: boolean;
            expCodexResume: boolean;
            expCodexAcp: boolean;
            resumeSessionId: string;
        }) => Record<string, unknown>;
        buildResumeSessionExtras?: (opts: {
            agentId: AgentId;
            experimentsEnabled: boolean;
            expCodexResume: boolean;
            expCodexAcp: boolean;
        }) => Record<string, unknown>;
        buildWakeResumeExtras?: (opts: { agentId: AgentId; resumeCapabilityOptions: ResumeCapabilityOptions }) => Record<string, unknown>;
    }>;
}>;

export type NewSessionPreflightContext = Readonly<{
    agentId: AgentId;
    experimentsEnabled: boolean;
    expCodexResume: boolean;
    expCodexAcp: boolean;
    resumeSessionId: string;
    deps: Readonly<{
        codexAcpInstalled: boolean | null;
        codexMcpResumeInstalled: boolean | null;
    }>;
}>;

export type NewSessionRelevantInstallableDepsContext = Readonly<{
    agentId: AgentId;
    experimentsEnabled: boolean;
    expCodexResume: boolean;
    expCodexAcp: boolean;
    resumeSessionId: string;
}>;

export type NewSessionPreflightIssue = Readonly<{
    id: string;
    titleKey: TranslationKey;
    messageKey: TranslationKey;
    confirmTextKey: TranslationKey;
    action: 'openMachine';
}>;

export type ResumePreflightContext = Readonly<{
    agentId: AgentId;
    experimentsEnabled: boolean;
    expCodexResume: boolean;
    expCodexAcp: boolean;
    deps: Readonly<{
        codexAcpInstalled: boolean | null;
        codexMcpResumeInstalled: boolean | null;
    }>;
}>;

type CodexSpawnSessionExtras = Readonly<{
    experimentalCodexResume: boolean;
    experimentalCodexAcp: boolean;
}>;

type CodexResumeSessionExtras = Readonly<{
    experimentalCodexResume: boolean;
    experimentalCodexAcp: boolean;
}>;

function mergeAgentUiBehavior(a: AgentUiBehavior, b: AgentUiBehavior): AgentUiBehavior {
    return {
        ...(a.resume || b.resume ? { resume: { ...(a.resume ?? {}), ...(b.resume ?? {}) } } : {}),
        ...(a.newSession || b.newSession ? { newSession: { ...(a.newSession ?? {}), ...(b.newSession ?? {}) } } : {}),
        ...(a.payload || b.payload ? { payload: { ...(a.payload ?? {}), ...(b.payload ?? {}) } } : {}),
    };
}

function buildDefaultAgentUiBehavior(agentId: AgentId): AgentUiBehavior {
    const core = getAgentCore(agentId);
    const runtimeGate = core.resume.runtimeGate;
    if (runtimeGate === 'acpLoadSession') {
        return {
            resume: {
                getAllowRuntimeResume: (results) => readAcpLoadSessionSupport(agentId, results),
                getRuntimeResumePrefetchPlan: (results) => {
                    if (!shouldPrefetchAcpCapabilities(agentId, results)) return null;
                    return { request: buildAcpLoadSessionPrefetchRequest(agentId), timeoutMs: 8_000 };
                },
            },
        };
    }
    return {};
}

function computeCodexSpawnSessionExtras(opts: {
    agentId: AgentId;
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

function computeCodexResumeSessionExtras(opts: {
    agentId: AgentId;
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

const AGENTS_UI_BEHAVIOR_OVERRIDES: Readonly<Partial<Record<AgentId, AgentUiBehavior>>> = Object.freeze({
    codex: {
        resume: {
            getAllowExperimentalVendorResume: ({ experimentsEnabled, expCodexResume, expCodexAcp }) => {
                return experimentsEnabled && (expCodexResume || expCodexAcp);
            },
            // Codex ACP mode can support vendor-resume via ACP `loadSession`.
            // We probe this dynamically (same as Gemini/OpenCode) and only enforce it when `expCodexAcp` is enabled.
            getAllowRuntimeResume: (results) => readAcpLoadSessionSupport('codex', results),
        },
        newSession: {
            getPreflightIssues: (ctx) => {
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
            },
            getRelevantInstallableDepKeys: (ctx) => {
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
            },
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
            buildWakeResumeExtras: ({ resumeCapabilityOptions }) => {
                const allowCodexResume = resumeCapabilityOptions.allowExperimentalResumeByAgentId?.codex === true;
                return allowCodexResume ? { experimentalCodexResume: true } : {};
            },
        },
    },
});

export const AGENTS_UI_BEHAVIOR: Readonly<Record<AgentId, AgentUiBehavior>> = Object.freeze(
    Object.fromEntries(
        AGENT_IDS.map((id) => {
            const base = buildDefaultAgentUiBehavior(id);
            const override = AGENTS_UI_BEHAVIOR_OVERRIDES[id] ?? {};
            return [id, mergeAgentUiBehavior(base, override)] as const;
        }),
    ) as Record<AgentId, AgentUiBehavior>,
);

export function getAllowExperimentalResumeByAgentIdFromUiState(opts: {
    experimentsEnabled: boolean;
    expCodexResume: boolean;
    expCodexAcp: boolean;
}): Partial<Record<AgentId, boolean>> {
    const out: Partial<Record<AgentId, boolean>> = {};
    for (const id of AGENT_IDS) {
        const fn = AGENTS_UI_BEHAVIOR[id].resume?.getAllowExperimentalVendorResume;
        if (fn && fn(opts) === true) out[id] = true;
    }
    return out;
}

export function getAllowRuntimeResumeByAgentIdFromResults(results: CapabilityResults | undefined): Partial<Record<AgentId, boolean>> {
    const out: Partial<Record<AgentId, boolean>> = {};
    for (const id of AGENT_IDS) {
        const fn = AGENTS_UI_BEHAVIOR[id].resume?.getAllowRuntimeResume;
        if (fn && fn(results) === true) out[id] = true;
    }
    return out;
}

export function buildResumeCapabilityOptionsFromUiState(opts: {
    experimentsEnabled: boolean;
    expCodexResume: boolean;
    expCodexAcp: boolean;
    results: CapabilityResults | undefined;
}): ResumeCapabilityOptions {
    const allowExperimental = getAllowExperimentalResumeByAgentIdFromUiState(opts);
    const allowRuntime = getAllowRuntimeResumeByAgentIdFromResults(opts.results);

    // Codex is special: it has two experimental resume paths.
    // - `expCodexResume` uses MCP resume (no ACP probing)
    // - `expCodexAcp` uses ACP resume (requires `loadSession` support from the ACP binary)
    if (opts.experimentsEnabled === true && opts.expCodexResume !== true && opts.expCodexAcp === true) {
        if (allowExperimental.codex === true) {
            // Fail closed until we’ve confirmed ACP loadSession support.
            if (allowRuntime.codex !== true) {
                delete allowExperimental.codex;
            }
        }
    }

    return buildResumeCapabilityOptionsFromMaps({
        allowExperimentalResumeByAgentId: allowExperimental,
        allowRuntimeResumeByAgentId: allowRuntime,
    });
}

export function buildResumeCapabilityOptionsFromMaps(opts: {
    allowExperimentalResumeByAgentId?: Partial<Record<AgentId, boolean>>;
    allowRuntimeResumeByAgentId?: Partial<Record<AgentId, boolean>>;
}): ResumeCapabilityOptions {
    const allowExperimental = opts.allowExperimentalResumeByAgentId ?? {};
    const allowRuntime = opts.allowRuntimeResumeByAgentId ?? {};
    return {
        ...(Object.keys(allowExperimental).length > 0 ? { allowExperimentalResumeByAgentId: allowExperimental } : {}),
        ...(Object.keys(allowRuntime).length > 0 ? { allowRuntimeResumeByAgentId: allowRuntime } : {}),
    };
}

export function getResumeRuntimeSupportPrefetchPlan(
    agentId: AgentId,
    results: CapabilityResults | undefined,
): ResumeRuntimeSupportPrefetchPlan | null {
    const fn = AGENTS_UI_BEHAVIOR[agentId].resume?.getRuntimeResumePrefetchPlan;
    return fn ? fn(results) : null;
}

export function getNewSessionPreflightIssues(ctx: NewSessionPreflightContext): readonly NewSessionPreflightIssue[] {
    const fn = AGENTS_UI_BEHAVIOR[ctx.agentId].newSession?.getPreflightIssues;
    return fn ? fn(ctx) : [];
}

export function getResumePreflightIssues(ctx: ResumePreflightContext): readonly NewSessionPreflightIssue[] {
    if (ctx.agentId !== 'codex') return [];
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

export function getNewSessionRelevantInstallableDepKeys(
    ctx: NewSessionRelevantInstallableDepsContext,
): readonly string[] {
    const fn = AGENTS_UI_BEHAVIOR[ctx.agentId].newSession?.getRelevantInstallableDepKeys;
    return fn ? fn(ctx) : [];
}

export function buildSpawnSessionExtrasFromUiState(opts: {
    agentId: AgentId;
    experimentsEnabled: boolean;
    expCodexResume: boolean;
    expCodexAcp: boolean;
    resumeSessionId: string;
}): Record<string, unknown> {
    const fn = AGENTS_UI_BEHAVIOR[opts.agentId].payload?.buildSpawnSessionExtras;
    return fn ? fn(opts) : {};
}

export function buildResumeSessionExtrasFromUiState(opts: {
    agentId: AgentId;
    experimentsEnabled: boolean;
    expCodexResume: boolean;
    expCodexAcp: boolean;
}): Record<string, unknown> {
    const fn = AGENTS_UI_BEHAVIOR[opts.agentId].payload?.buildResumeSessionExtras;
    return fn ? fn(opts) : {};
}

export function buildWakeResumeExtras(opts: {
    agentId: AgentId;
    resumeCapabilityOptions: ResumeCapabilityOptions;
}): Record<string, unknown> {
    const fn = AGENTS_UI_BEHAVIOR[opts.agentId]?.payload?.buildWakeResumeExtras;
    return fn ? fn(opts) : {};
}
