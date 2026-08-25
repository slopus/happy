import type { Metadata } from '@/sync/storageTypes';
import { hackModes } from '@/sync/modeHacks';
import { sortPermissionModes } from '@/utils/permissionModeLabels';
import { compareVersionsWithPrerelease, isWellFormedVersion } from '@/utils/versionUtils';
import { CLI_VERSION_WITH_AUTO, getCodeAgentDefaults } from '@/sync/agentDefaults';
export { CLI_VERSION_WITH_AUTO } from '@/sync/agentDefaults';
import {
    getRigCurrentModel,
    getRigModels,
    getRigReasoningLevels,
    getRigSelectedModelKey,
    isRigMetadataV1,
} from '@/sync/rig';

export type ModeOption = {
    key: string;
    name: string;
    description?: string | null;
    semanticKind?: string | null;
    disabled?: boolean;
    // The happy-cli version that first parses this mode. Untagged modes are
    // offered to every CLI; tagged ones are hidden from CLIs known to be older
    // (see filterPermissionModesForCli).
    sinceCliVersion?: string;
};

export type PermissionMode = ModeOption;
export type ModelMode = ModeOption & {
    modelId?: string;
    providerId?: string;
    providerName?: string;
    providerKind?: string;
    contextWindow?: number;
    serviceTiers?: string[];
    thinkingLevels?: string[];
    defaultThinkingLevel?: string | null;
    unavailable?: boolean;
};

export type EffortLevel = ModeOption;
export type PermissionModeKey = string;
export type ModelModeKey = string;

export type AgentFlavor = 'claude' | 'codex' | 'gemini' | string | null | undefined;

type Translate = (key: any) => string;

type MetadataOption = {
    code: string;
    value: string;
    description?: string | null;
};

const GEMINI_MODEL_FALLBACKS: ModelMode[] = [
    { key: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', description: 'latest & most capable' },
    { key: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', description: 'latest & fast' },
    { key: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite', description: 'latest & fastest' },
    { key: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'most capable' },
    { key: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'fast & efficient' },
    { key: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', description: 'fastest' },
];

export function mapMetadataOptions(options?: MetadataOption[] | null): ModeOption[] {
    if (!options || options.length === 0) {
        return [];
    }

    return options.map((option) => ({
        key: option.code,
        name: option.value,
        description: option.description ?? null,
    }));
}

// Mode names are deliberately untranslated single words, because the composer
// chip that shows the current mode has room for one word — see
// permissionModeLabels.ts. They are Happy's own vocabulary, not a quote of each
// CLI's: Claude's UI calls our `default` "Manual". Every list below is ordered
// by that file's ranking so the modes line up across harnesses, with one
// documented exception at agy.

// Auto leads because it is the everyday mode: the harness reviews its own calls
// and stops only when it actually wants a human. Claude ships it in the Agent
// SDK's PermissionMode union, and it is carried end to end — the CLI's
// PermissionMode type, MessageMetaSchema, and the SDK adapter's QueryOptions.
// `dontAsk` stays absent: that one really is missing from MessageMetaSchema, so
// sending it fails UserMessageSchema.safeParse and drops the whole prompt.
export function getClaudePermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'auto', name: 'Auto', description: translate('agentInput.permissionMode.auto'), sinceCliVersion: CLI_VERSION_WITH_AUTO },
        { key: 'acceptEdits', name: 'Edits', description: translate('agentInput.permissionMode.acceptEdits') },
        { key: 'plan', name: 'Plan', description: translate('agentInput.permissionMode.plan') },
        { key: 'bypassPermissions', name: 'Yolo', description: translate('agentInput.permissionMode.bypassPermissions') },
        { key: 'default', name: 'Default', description: translate('agentInput.permissionMode.default') },
    ];
}

// Auto is Codex's own everyday preset, spelled `on-request` + workspace-write
// by resolveCodexExecutionPolicy: Codex runs what it can and asks when it wants
// more. `default` is Happy's stricter baseline — `untrusted` + workspace-write,
// which stops for anything off the trusted list — and is named Default because
// it is where you land having picked nothing. `safe-yolo` keeps the workspace
// sandbox but stops asking, so it is the one named for the sandbox.
export function getCodexPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'auto', name: 'Auto', description: translate('agentInput.codexPermissionMode.autoDescription'), sinceCliVersion: CLI_VERSION_WITH_AUTO },
        { key: 'safe-yolo', name: 'Workspace', description: translate('agentInput.codexPermissionMode.safeYoloDescription') },
        { key: 'read-only', name: 'Read', description: translate('agentInput.codexPermissionMode.readOnlyDescription') },
        { key: 'yolo', name: 'Yolo', description: translate('agentInput.codexPermissionMode.yoloDescription') },
        { key: 'default', name: 'Default', description: translate('agentInput.codexPermissionMode.defaultDescription') },
    ];
}

// Only the keys runGemini actually honours (its validModes list). Gemini is
// retired from the harness picker, but existing sessions still open this menu,
// and the two modes that used to be here were both broken: `auto_edit` is not
// in MessageMetaSchema at all, so picking it dropped the entire message, and
// `plan` passed the schema only to be ignored by runGemini — which left the
// session on whatever it had before, up to and including yolo.
export function getGeminiPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'yolo', name: 'Yolo', description: translate('agentInput.geminiPermissionMode.yolo') },
        { key: 'default', name: 'Default', description: translate('agentInput.geminiPermissionMode.default') },
    ];
}

// The current generation only. Older Claudes and the `default model` row are
// deliberately absent: picking a model is the point of this menu, and every
// entry here is a 5.
//
// Keys are full model IDs rather than the short aliases, because the aliases
// do not all mean what the row says. `sonnet` still resolves to Sonnet 4.6 in
// the CLI's alias table, and `opus-5` is not in that table at all (`claude
// --model opus-5` errors on 2.1.199). Full IDs pass straight through to the
// API, so they say exactly which model is meant. The `[1m]` suffix is part of
// the model ID Claude Code accepts (`claude --model 'claude-opus-5[1m]'`) and
// selects the 1M-context variant; unknown bracket models are rejected, so the
// suffix is honored rather than silently dropped (#1721).
export function getClaudeModelModes(): ModelMode[] {
    return [
        { key: 'claude-fable-5', name: 'Fable 5', description: null },
        { key: 'claude-opus-5', name: 'Opus 5', description: null },
        { key: 'claude-opus-5[1m]', name: 'Opus 5 [1M]', description: '1M context' },
        { key: 'claude-sonnet-5', name: 'Sonnet 5', description: null },
    ];
}

export function getCodexModelModes(): ModelMode[] {
    return [
        { key: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', description: null },
        { key: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', description: null },
        { key: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', description: null },
    ];
}

export function includeConfiguredModel(
    flavor: AgentFlavor,
    models: ModelMode[],
    configuredModelKey: string | null | undefined,
): ModelMode[] {
    if (
        flavor !== 'codex'
        || !configuredModelKey
        || configuredModelKey === 'default'
        || models.some((model) => model.key === configuredModelKey)
    ) {
        return models;
    }
    return [
        ...models,
        {
            key: configuredModelKey,
            name: configuredModelKey,
            description: 'custom model',
        },
    ];
}

export function getGeminiModelModes(): ModelMode[] {
    return GEMINI_MODEL_FALLBACKS;
}

// runOpenClaw never reads permissionMode, so neither of these changes what
// openclaw does. Both are kept so an existing session's saved mode still has a
// row to select, but the descriptions say plainly that the choice is inert.
export function getOpenClawPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'bypassPermissions', name: 'Yolo', description: translate('agentInput.permissionMode.openclawInert') },
        { key: 'default', name: 'Default', description: translate('agentInput.permissionMode.openclawInert') },
    ];
}

// agy --print only distinguishes --sandbox (default) from --dangerously-skip-permissions,
// so only these two modes are offered. Default gets its own wording because agy
// --print is one-shot and cannot prompt: it never asks, it just runs under agy's
// own sandbox settings.
//
// The one place the shared ranking is deliberately ignored. Default sorts last
// everywhere else because it means "ask me about everything", the choice you
// make when none of the others fit. Here it means the opposite: it is agy's own
// launch default, the only sandboxed option, and the one agentDefaults picks.
// Ranking it below Yolo would put the escape hatch at the top of a two-item
// list and read as the recommendation.
export function getAgyPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: 'Default', description: translate('agentInput.permissionMode.agyDefault') },
        { key: 'bypassPermissions', name: 'Yolo', description: translate('agentInput.permissionMode.bypassPermissions') },
    ];
}

// Before the release tagged above the CLI's MessageMetaSchema rejected `auto`,
// and a rejected mode dropped the whole prompt — the same failure mode
// `dontAsk` had.

/**
 * True when the CLI at `cliVersion` parses this mode. An untagged mode is
 * supported everywhere. An absent version stays permissive: every happy-cli
 * reports its version in both session and machine metadata, so no version
 * means the client is not happy-cli (e.g. a pre-catalog Rig session). A
 * version that is present but unparseable hides tagged modes instead — a
 * mangled happy-cli version is more likely old than new.
 */
export function modeSupportedByCli(
    mode: Pick<ModeOption, 'sinceCliVersion'>,
    cliVersion: string | null | undefined,
): boolean {
    if (!mode.sinceCliVersion || !cliVersion) {
        return true;
    }
    if (!isWellFormedVersion(cliVersion)) {
        return false;
    }
    return compareVersionsWithPrerelease(cliVersion, mode.sinceCliVersion) >= 0;
}

// The version tags by mode key, for callers that hold a bare key rather than
// a ModeOption — the option lists below and the outbound-message path both
// read from here so the two can never disagree.
const PERMISSION_MODE_SINCE_CLI_VERSION: Record<string, string> = {
    auto: CLI_VERSION_WITH_AUTO,
};

/**
 * True when the CLI at `cliVersion` parses this mode key. The bare-key twin of
 * modeSupportedByCli, for callers that hold a saved key rather than a
 * ModeOption. Picker filtering alone does not cover those: an existing session
 * or a saved agent default can carry a mode the session's older CLI never
 * offered, and the send path must refuse it loudly rather than substitute a
 * different mode behind the user's back.
 */
export function permissionModeSupportedByCli(
    modeKey: string | null | undefined,
    cliVersion: string | null | undefined,
): boolean {
    if (!modeKey) {
        return true;
    }
    return modeSupportedByCli(
        { sinceCliVersion: PERMISSION_MODE_SINCE_CLI_VERSION[modeKey] },
        cliVersion,
    );
}

/**
 * Drops modes the CLI on the receiving machine cannot parse, going by each
 * mode's own sinceCliVersion tag. Applies to the hardcoded flavor lists only —
 * a harness that publishes its own catalog (rig metadata) owns its codes and
 * already matches its own version.
 */
export function filterPermissionModesForCli<T extends ModeOption>(
    modes: T[],
    cliVersion: string | null | undefined,
): T[] {
    return modes.filter((mode) => modeSupportedByCli(mode, cliVersion));
}

export function getHardcodedPermissionModes(flavor: AgentFlavor, translate: Translate): PermissionMode[] {
    if (flavor === 'codex') {
        return getCodexPermissionModes(translate);
    }
    if (flavor === 'gemini') {
        return getGeminiPermissionModes(translate);
    }
    if (flavor === 'openclaw') {
        return getOpenClawPermissionModes(translate);
    }
    if (flavor === 'agy') {
        return getAgyPermissionModes(translate);
    }
    return getClaudePermissionModes(translate);
}

export function getOpenClawModelModes(): ModelMode[] {
    return [
        { key: 'default', name: 'Default model', description: null },
    ];
}

// Keys are the exact display names `agy --model` accepts (as printed by `agy models`).
export function getAgyModelModes(): ModelMode[] {
    return [
        { key: 'Gemini 3.6 Flash (High)', name: 'Gemini 3.6 Flash (High)', description: null },
        { key: 'Gemini 3.6 Flash (Medium)', name: 'Gemini 3.6 Flash (Medium)', description: null },
        { key: 'Gemini 3.6 Flash (Low)', name: 'Gemini 3.6 Flash (Low)', description: null },
        { key: 'Gemini 3.1 Pro (High)', name: 'Gemini 3.1 Pro (High)', description: null },
        { key: 'Gemini 3.1 Pro (Low)', name: 'Gemini 3.1 Pro (Low)', description: null },
        { key: 'Gemini 3.5 Flash (High)', name: 'Gemini 3.5 Flash (High)', description: null },
        { key: 'Gemini 3.5 Flash (Medium)', name: 'Gemini 3.5 Flash (Medium)', description: null },
        { key: 'Gemini 3.5 Flash (Low)', name: 'Gemini 3.5 Flash (Low)', description: null },
        { key: 'Claude Opus 4.6 (Thinking)', name: 'Claude Opus 4.6 (Thinking)', description: null },
        { key: 'Claude Sonnet 4.6 (Thinking)', name: 'Claude Sonnet 4.6 (Thinking)', description: null },
        { key: 'GPT-OSS 120B (Medium)', name: 'GPT-OSS 120B (Medium)', description: null },
    ];
}

export function getHardcodedModelModes(flavor: AgentFlavor, _translate: Translate): ModelMode[] {
    if (flavor === 'codex') {
        return getCodexModelModes();
    }
    if (flavor === 'gemini') {
        return getGeminiModelModes();
    }
    if (flavor === 'openclaw') {
        return getOpenClawModelModes();
    }
    if (flavor === 'agy') {
        return getAgyModelModes();
    }
    return getClaudeModelModes();
}

export function getAvailableModels(
    flavor: AgentFlavor,
    metadata: Metadata | null | undefined,
    translate: Translate,
    selectedKey?: string | null,
): ModelMode[] {
    if (isRigMetadataV1(metadata)) {
        const models: ModelMode[] = getRigModels(metadata).map((model) => ({
            key: model.key,
            name: model.name,
            description: model.providerName,
            modelId: model.id,
            providerId: model.providerId,
            providerName: model.providerName,
            providerKind: model.providerKind,
            contextWindow: model.contextWindow,
            serviceTiers: model.serviceTiers,
            thinkingLevels: model.thinkingLevels,
            defaultThinkingLevel: model.defaultThinkingLevel,
        }));
        const current = getRigCurrentModel(metadata);
        if (current?.unavailable && !models.some((model) => model.key === current.key)) {
            models.unshift({
                key: current.key,
                name: current.name,
                description: `${current.providerName} · unavailable`,
                modelId: current.id,
                providerId: current.providerId,
                providerName: current.providerName,
                providerKind: current.providerKind,
                thinkingLevels: [],
                serviceTiers: [],
                unavailable: true,
                disabled: true,
            });
        }
        const locallySelectedKey = selectedKey ?? metadata?.modelMode;
        if (locallySelectedKey && locallySelectedKey.includes(':') && !models.some((model) => model.key === locallySelectedKey)) {
            const separator = locallySelectedKey.indexOf(':');
            const providerId = locallySelectedKey.slice(0, separator);
            const modelId = locallySelectedKey.slice(separator + 1);
            models.unshift({
                key: locallySelectedKey,
                name: modelId,
                description: `${providerId} · unavailable`,
                modelId,
                providerId,
                providerName: providerId,
                providerKind: 'custom',
                unavailable: true,
                disabled: true,
            });
        }
        return models;
    }
    const metadataModels = mapMetadataOptions(metadata?.models);
    if (metadataModels.length > 0) {
        if (flavor === 'codex' && !metadataModels.some((model) => model.key === 'default')) {
            return [{ key: 'default', name: 'default model', description: null }, ...metadataModels];
        }
        return metadataModels;
    }
    return includeConfiguredModel(
        flavor,
        getHardcodedModelModes(flavor, translate),
        selectedKey,
    );
}

export function getAvailablePermissionModes(
    flavor: AgentFlavor,
    metadata: Metadata | null | undefined,
    translate: Translate,
    selectedKey?: string | null,
): PermissionMode[] {
    if (isRigMetadataV1(metadata)) {
        const modes: PermissionMode[] = sortPermissionModes((metadata?.operatingModes ?? []).map((mode) => ({
            key: mode.code,
            name: mode.value,
            description: mode.description ?? null,
            semanticKind: mode.kind ?? null,
        })));
        const current = selectedKey
            ?? metadata?.currentOperatingModeCode
            ?? metadata?.permissionMode
            ?? metadata?.session?.permissionMode;
        if (current && !modes.some((mode) => mode.key === current)) {
            modes.unshift({
                key: current,
                name: current,
                description: 'Unavailable in the current Happy mode catalog',
                semanticKind: null,
                disabled: true,
            });
        }
        return modes;
    }
    if (flavor === 'claude' || flavor === 'codex' || flavor === 'openclaw' || flavor === 'agy') {
        // metadata.version is the happy-cli version running this session
        // (createSessionMetadata.ts), which is what has to parse the mode.
        return hackModes(filterPermissionModesForCli(
            getHardcodedPermissionModes(flavor, translate),
            metadata?.version,
        ));
    }

    const metadataModes = mapMetadataOptions(metadata?.operatingModes);
    if (metadataModes.length > 0) {
        return sortPermissionModes(hackModes(metadataModes));
    }

    return hackModes(getHardcodedPermissionModes(flavor, translate));
}

export function findOptionByKey<T extends ModeOption>(options: T[], key: string | null | undefined): T | null {
    if (!key) {
        return null;
    }
    return options.find((option) => option.key === key) ?? null;
}

export function resolveCurrentOption<T extends ModeOption>(
    options: T[],
    preferredKeys: Array<string | null | undefined>,
): T | null {
    for (const key of preferredKeys) {
        const option = findOptionByKey(options, key);
        if (option) {
            return option;
        }
    }
    return null;
}

export function getDefaultModelKey(flavor: AgentFlavor): string {
    return getCodeAgentDefaults(flavor).modelMode;
}

export function getDefaultPermissionModeKey(flavor: AgentFlavor): string {
    return getCodeAgentDefaults(flavor).permissionMode;
}

// Effort levels per agent type

// Display capitalization only — the key is what the wire protocol accepts.
// `xhigh` keeps its camel-cased brand spelling instead of plain title case.
const EFFORT_DISPLAY_NAMES: Record<string, string> = {
    xhigh: 'xHigh',
};

export function effortDisplayName(key: string): string {
    return EFFORT_DISPLAY_NAMES[key] ?? (key.charAt(0).toUpperCase() + key.slice(1));
}

function effortLevels(keys: readonly string[]): EffortLevel[] {
    return keys.map((key) => ({ key, name: effortDisplayName(key) }));
}

// The Claude Agent SDK's own EffortLevel union, in order
// (node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:546). There is no
// `off`: Claude's floor is `low`.
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

// Exactly what each model publishes in Codex's own registry, in its order
// (codex-rs/models-manager/models.json, min client 0.144). This really is
// per-model: sol and terra reach `ultra`, luna stops at `max`. `ultra` is
// documented as maximum reasoning with automatic task delegation, so it is a
// different kind of run rather than one more notch — but it is a level these
// two models accept, so the picker offers it rather than deciding for you.
const CODEX_EFFORTS_BY_MODEL: Record<string, readonly string[]> = {
    'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
};
const CODEX_EFFORTS_FALLBACK = ['low', 'medium', 'high', 'xhigh'] as const;

export function getClaudeEffortLevels(): EffortLevel[] {
    return effortLevels(CLAUDE_EFFORTS);
}

/**
 * Codex efforts for one model. An unknown model — a workspace's own, or one
 * newer than this table — gets the conservative set every gpt-5 accepts rather
 * than a guess at the top of its range.
 */
export function getCodexEffortLevels(modelKey?: string | null): EffortLevel[] {
    return effortLevels(
        (modelKey ? CODEX_EFFORTS_BY_MODEL[modelKey] : undefined) ?? CODEX_EFFORTS_FALLBACK,
    );
}

export function getHardcodedEffortLevels(flavor: AgentFlavor): EffortLevel[] {
    if (flavor === 'claude') return getClaudeEffortLevels();
    if (flavor === 'codex') return getCodexEffortLevels();
    return [];
}

export function getDefaultEffortKey(flavor: AgentFlavor): string | null {
    return getCodeAgentDefaults(flavor).effortLevel;
}

// Per-model effort: returns effort levels for a specific model, or empty if the model has no effort
export function getEffortLevelsForModel(
    flavor: AgentFlavor,
    modelKey: string,
    metadata?: Metadata | null,
): EffortLevel[] {
    if (isRigMetadataV1(metadata)) {
        return getRigReasoningLevels(metadata, modelKey).map((level) => ({
            key: level,
            name: effortDisplayName(level),
        }));
    }
    // Claude's effort scale is a property of the SDK rather than of the model:
    // one union for every model, and a level the chosen model cannot reach is
    // silently downgraded rather than rejected (sdk.d.ts:174). Codex is the
    // opposite — each model publishes its own supported levels — so it is asked
    // per model.
    if (flavor === 'claude') {
        return getClaudeEffortLevels();
    }
    if (flavor === 'codex') {
        return getCodexEffortLevels(modelKey);
    }
    return [];
}

export function getRigCurrentModelOptionKey(metadata: Metadata | null | undefined): string | null {
    return getRigSelectedModelKey(metadata);
}

// Default effort for a model — highest the model allows
export function getDefaultEffortKeyForModel(flavor: AgentFlavor, modelKey: string): string | null {
    const levels = getEffortLevelsForModel(flavor, modelKey);
    if (levels.length === 0) return null;
    return getCodeAgentDefaults(flavor).effortLevel ?? levels[levels.length - 1].key;
}

export function getSupportsWorktree(flavor: AgentFlavor): boolean {
    if (flavor === 'openclaw') return false;
    return true;
}
