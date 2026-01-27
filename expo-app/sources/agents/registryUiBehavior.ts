import type { AgentId } from './registryCore';
import { AGENT_IDS, getAgentCore } from './registryCore';
import type { CapabilitiesDetectRequest, CapabilityDetectResult, CapabilityId } from '@/sync/capabilitiesProtocol';
import type { ResumeCapabilityOptions } from '@/agents/resumeCapabilities';
import type { TranslationKey } from '@/text';
import { buildAcpLoadSessionPrefetchRequest, readAcpLoadSessionSupport, shouldPrefetchAcpCapabilities } from './acpRuntimeResume';
import { CODEX_UI_BEHAVIOR_OVERRIDE, getCodexResumePreflightIssues } from './providers/codex/uiBehavior';

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

const AGENTS_UI_BEHAVIOR_OVERRIDES: Readonly<Partial<Record<AgentId, AgentUiBehavior>>> = Object.freeze({
    codex: CODEX_UI_BEHAVIOR_OVERRIDE,
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
    return getCodexResumePreflightIssues(ctx);
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
