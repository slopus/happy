import type { AgentId } from './registryCore';
import { AGENT_IDS, getAgentCore } from './registryCore';
import type { CapabilitiesDetectRequest, CapabilityDetectResult, CapabilityId } from '@/sync/capabilitiesProtocol';
import type { ResumeCapabilityOptions } from '@/agents/resumeCapabilities';
import type { TranslationKey } from '@/text';
import type { Settings } from '@/sync/settings';
import { buildAcpLoadSessionPrefetchRequest, readAcpLoadSessionSupport, shouldPrefetchAcpCapabilities } from './acpRuntimeResume';
import { CODEX_UI_BEHAVIOR_OVERRIDE } from './providers/codex/uiBehavior';
import { AUGGIE_UI_BEHAVIOR_OVERRIDE } from './providers/auggie/uiBehavior';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput';

type CapabilityResults = Partial<Record<CapabilityId, CapabilityDetectResult>>;

export type AgentExperimentSwitches = Readonly<Record<string, boolean>>;

export type AgentResumeExperiments = Readonly<{
    enabled: boolean;
    switches: AgentExperimentSwitches;
}>;

export type AgentExperimentSwitchDef = Readonly<{
    id: string;
    settingKey: keyof Settings;
}>;

export type ResumeRuntimeSupportPrefetchPlan = Readonly<{
    request: CapabilitiesDetectRequest;
    timeoutMs: number;
}>;

export type AgentUiBehavior = Readonly<{
    resume?: Readonly<{
        experimentSwitches?: readonly AgentExperimentSwitchDef[];
        getAllowExperimentalVendorResume?: (opts: { experiments: AgentResumeExperiments }) => boolean;
        getExperimentalVendorResumeRequiresRuntime?: (opts: { experiments: AgentResumeExperiments }) => boolean;
        getAllowRuntimeResume?: (opts: { experiments: AgentResumeExperiments; results: CapabilityResults | undefined }) => boolean;
        getRuntimeResumePrefetchPlan?: (opts: {
            experiments: AgentResumeExperiments;
            results: CapabilityResults | undefined;
        }) => ResumeRuntimeSupportPrefetchPlan | null;
        getPreflightPrefetchPlan?: (opts: {
            experiments: AgentResumeExperiments;
            results: CapabilityResults | undefined;
        }) => ResumeRuntimeSupportPrefetchPlan | null;
        getPreflightIssues?: (ctx: ResumePreflightContext) => readonly NewSessionPreflightIssue[];
    }>;
    newSession?: Readonly<{
        buildNewSessionOptions?: (ctx: {
            agentId: AgentId;
            agentOptionState?: Record<string, unknown> | null;
        }) => Record<string, unknown> | null;
        getAgentInputExtraActionChips?: (ctx: {
            agentId: AgentId;
            agentOptionState?: Record<string, unknown> | null;
            setAgentOptionState: (key: string, value: unknown) => void;
        }) => ReadonlyArray<AgentInputExtraActionChip> | undefined;
        getPreflightIssues?: (ctx: NewSessionPreflightContext) => readonly NewSessionPreflightIssue[];
        getRelevantInstallableDepKeys?: (ctx: NewSessionRelevantInstallableDepsContext) => readonly string[];
    }>;
    payload?: Readonly<{
        buildSpawnEnvironmentVariables?: (opts: {
            agentId: AgentId;
            environmentVariables: Record<string, string> | undefined;
            newSessionOptions?: Record<string, unknown> | null;
        }) => Record<string, string> | undefined;
        buildSpawnSessionExtras?: (opts: {
            agentId: AgentId;
            experiments: AgentResumeExperiments;
            resumeSessionId: string;
        }) => Record<string, unknown>;
        buildResumeSessionExtras?: (opts: {
            agentId: AgentId;
            experiments: AgentResumeExperiments;
        }) => Record<string, unknown>;
        buildWakeResumeExtras?: (opts: { agentId: AgentId; resumeCapabilityOptions: ResumeCapabilityOptions }) => Record<string, unknown>;
    }>;
}>;

export type NewSessionPreflightContext = Readonly<{
    agentId: AgentId;
    experiments: AgentResumeExperiments;
    resumeSessionId: string;
    results: CapabilityResults | undefined;
}>;

export type NewSessionRelevantInstallableDepsContext = Readonly<{
    agentId: AgentId;
    experiments: AgentResumeExperiments;
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
    experiments: AgentResumeExperiments;
    results: CapabilityResults | undefined;
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
                getAllowRuntimeResume: ({ results }) => readAcpLoadSessionSupport(agentId, results),
                getRuntimeResumePrefetchPlan: ({ results }) => {
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
    auggie: AUGGIE_UI_BEHAVIOR_OVERRIDE,
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

export function getAgentResumeExperimentsFromSettings(agentId: AgentId, settings: Settings): AgentResumeExperiments {
    const enabled = settings.experiments === true;
    const defs = AGENTS_UI_BEHAVIOR[agentId].resume?.experimentSwitches ?? [];
    if (defs.length === 0) return { enabled, switches: {} };
    const switches: Record<string, boolean> = {};
    for (const def of defs) {
        switches[def.id] = settings[def.settingKey] === true;
    }
    return { enabled, switches };
}

export function getAllowExperimentalResumeByAgentIdFromUiState(settings: Settings): Partial<Record<AgentId, boolean>> {
    const out: Partial<Record<AgentId, boolean>> = {};
    for (const id of AGENT_IDS) {
        const fn = AGENTS_UI_BEHAVIOR[id].resume?.getAllowExperimentalVendorResume;
        if (!fn) continue;
        const experiments = getAgentResumeExperimentsFromSettings(id, settings);
        if (fn({ experiments }) === true) out[id] = true;
    }
    return out;
}

export function getAllowRuntimeResumeByAgentIdFromResults(opts: {
    settings: Settings;
    results: CapabilityResults | undefined;
}): Partial<Record<AgentId, boolean>> {
    const out: Partial<Record<AgentId, boolean>> = {};
    for (const id of AGENT_IDS) {
        const fn = AGENTS_UI_BEHAVIOR[id].resume?.getAllowRuntimeResume;
        if (!fn) continue;
        const experiments = getAgentResumeExperimentsFromSettings(id, opts.settings);
        if (fn({ experiments, results: opts.results }) === true) out[id] = true;
    }
    return out;
}

export function buildResumeCapabilityOptionsFromUiState(opts: {
    settings: Settings;
    results: CapabilityResults | undefined;
}): ResumeCapabilityOptions {
    const allowExperimental = getAllowExperimentalResumeByAgentIdFromUiState(opts.settings);
    const allowRuntime = getAllowRuntimeResumeByAgentIdFromResults({ settings: opts.settings, results: opts.results });

    // Generic rule: some agents may expose an experimental resume path that still requires runtime gating
    // (e.g. ACP loadSession probing). Fail closed until runtime support is confirmed.
    for (const id of AGENT_IDS) {
        if (allowExperimental[id] !== true) continue;
        const fn = AGENTS_UI_BEHAVIOR[id].resume?.getExperimentalVendorResumeRequiresRuntime;
        if (!fn) continue;
        const experiments = getAgentResumeExperimentsFromSettings(id, opts.settings);
        if (fn({ experiments }) === true && allowRuntime[id] !== true) {
            delete allowExperimental[id];
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
    opts: {
        agentId: AgentId;
        settings: Settings;
        results: CapabilityResults | undefined;
    },
): ResumeRuntimeSupportPrefetchPlan | null {
    const fn = AGENTS_UI_BEHAVIOR[opts.agentId].resume?.getRuntimeResumePrefetchPlan;
    if (!fn) return null;
    const experiments = getAgentResumeExperimentsFromSettings(opts.agentId, opts.settings);
    return fn({ experiments, results: opts.results });
}

export function getResumePreflightPrefetchPlan(
    opts: {
        agentId: AgentId;
        settings: Settings;
        results: CapabilityResults | undefined;
    },
): ResumeRuntimeSupportPrefetchPlan | null {
    const fn = AGENTS_UI_BEHAVIOR[opts.agentId].resume?.getPreflightPrefetchPlan;
    if (!fn) return null;
    const experiments = getAgentResumeExperimentsFromSettings(opts.agentId, opts.settings);
    return fn({ experiments, results: opts.results });
}

export function getNewSessionPreflightIssues(ctx: NewSessionPreflightContext): readonly NewSessionPreflightIssue[] {
    const fn = AGENTS_UI_BEHAVIOR[ctx.agentId].newSession?.getPreflightIssues;
    return fn ? fn(ctx) : [];
}

export function getResumePreflightIssues(ctx: ResumePreflightContext): readonly NewSessionPreflightIssue[] {
    const fn = AGENTS_UI_BEHAVIOR[ctx.agentId].resume?.getPreflightIssues;
    return fn ? fn(ctx) : [];
}

export function buildNewSessionOptionsFromUiState(opts: {
    agentId: AgentId;
    agentOptionState?: Record<string, unknown> | null;
}): Record<string, unknown> | null {
    const fn = AGENTS_UI_BEHAVIOR[opts.agentId].newSession?.buildNewSessionOptions;
    return fn ? fn(opts) : null;
}

export function getNewSessionAgentInputExtraActionChips(opts: {
    agentId: AgentId;
    agentOptionState?: Record<string, unknown> | null;
    setAgentOptionState: (key: string, value: unknown) => void;
}): ReadonlyArray<AgentInputExtraActionChip> | undefined {
    const fn = AGENTS_UI_BEHAVIOR[opts.agentId].newSession?.getAgentInputExtraActionChips;
    return fn ? fn(opts) : undefined;
}

export function getNewSessionRelevantInstallableDepKeys(
    ctx: NewSessionRelevantInstallableDepsContext,
): readonly string[] {
    const fn = AGENTS_UI_BEHAVIOR[ctx.agentId].newSession?.getRelevantInstallableDepKeys;
    return fn ? fn(ctx) : [];
}

export function buildSpawnSessionExtrasFromUiState(opts: {
    agentId: AgentId;
    settings: Settings;
    resumeSessionId: string;
}): Record<string, unknown> {
    const fn = AGENTS_UI_BEHAVIOR[opts.agentId].payload?.buildSpawnSessionExtras;
    if (!fn) return {};
    const experiments = getAgentResumeExperimentsFromSettings(opts.agentId, opts.settings);
    return fn({ agentId: opts.agentId, experiments, resumeSessionId: opts.resumeSessionId });
}

export function buildSpawnEnvironmentVariablesFromUiState(opts: {
    agentId: AgentId;
    environmentVariables: Record<string, string> | undefined;
    newSessionOptions?: Record<string, unknown> | null;
}): Record<string, string> | undefined {
    const fn = AGENTS_UI_BEHAVIOR[opts.agentId].payload?.buildSpawnEnvironmentVariables;
    return fn ? fn(opts) : opts.environmentVariables;
}

export function buildResumeSessionExtrasFromUiState(opts: {
    agentId: AgentId;
    settings: Settings;
}): Record<string, unknown> {
    const fn = AGENTS_UI_BEHAVIOR[opts.agentId].payload?.buildResumeSessionExtras;
    if (!fn) return {};
    const experiments = getAgentResumeExperimentsFromSettings(opts.agentId, opts.settings);
    return fn({ agentId: opts.agentId, experiments });
}

export function buildWakeResumeExtras(opts: {
    agentId: AgentId;
    resumeCapabilityOptions: ResumeCapabilityOptions;
}): Record<string, unknown> {
    const fn = AGENTS_UI_BEHAVIOR[opts.agentId]?.payload?.buildWakeResumeExtras;
    return fn ? fn(opts) : {};
}
