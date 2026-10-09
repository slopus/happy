import * as z from 'zod';
import { compareVersionsWithPrerelease, isWellFormedVersion } from '@/utils/versionUtils';

export const agentKeys = ['claude', 'codex', 'gemini', 'openclaw', 'agy'] as const;
export type AgentKey = typeof agentKeys[number];

export const AgentDefaultOverrideSchema = z.object({
    permissionMode: z.string().optional(),
    modelMode: z.string().optional(),
    effortLevel: z.string().optional(),
}).passthrough();

export const AgentDefaultOverridesSchema = z.object({
    claude: AgentDefaultOverrideSchema.optional(),
    codex: AgentDefaultOverrideSchema.optional(),
    gemini: AgentDefaultOverrideSchema.optional(),
    openclaw: AgentDefaultOverrideSchema.optional(),
    agy: AgentDefaultOverrideSchema.optional(),
}).passthrough().default({});

export type AgentDefaultOverride = z.infer<typeof AgentDefaultOverrideSchema>;
export type AgentDefaultOverrides = z.infer<typeof AgentDefaultOverridesSchema>;
export type AgentDefaultField = keyof Pick<AgentDefaultOverride, 'permissionMode' | 'modelMode' | 'effortLevel'>;

export type AgentDefaultConfig = {
    permissionMode: string;
    modelMode: string;
    effortLevel: string | null;
};

const codeAgentDefaults: Record<AgentKey, AgentDefaultConfig> = {
    // Auto is the reviewed everyday mode for both shipped code agents. The
    // old CLI fallback is applied only when a machine version is known below;
    // a user override is kept separate and is never rewritten here.
    claude: { permissionMode: 'auto', modelMode: 'claude-opus-5-5', effortLevel: 'medium' },
    codex: { permissionMode: 'auto', modelMode: 'gpt-5.6-sol', effortLevel: 'medium' },
    gemini: { permissionMode: 'default', modelMode: 'gemini-2.5-pro', effortLevel: null },
    openclaw: { permissionMode: 'default', modelMode: 'default', effortLevel: null },
    agy: { permissionMode: 'default', modelMode: 'Gemini 3.8 Flash', effortLevel: 'medium' },
};

// `auto` first shipped in happy-cli 1.2.1-beta.2, for Claude and Codex alike.
// Keep this with the code-default resolver so every spawn/send consumer uses
// the same compatibility boundary as the picker catalog.
export const CLI_VERSION_WITH_AUTO = '1.2.1-beta.2';

// Opus 5.5 needs Agent SDK >= 0.3.280 (bundled Claude Code 2.1.280); older
// bundled copies get a 400. 1.2.6-beta.0 is the first happy-cli to require it.
export const CLI_VERSION_WITH_OPUS_5_5 = '1.2.6-beta.0';
const CLAUDE_MODEL_BEFORE_OPUS_5_5 = 'claude-opus-5';

function resolveCodeDefaultPermissionMode(
    permissionMode: string,
    cliVersion: string | null | undefined,
): string {
    if (permissionMode !== 'auto' || !cliVersion) {
        return permissionMode;
    }
    if (!isWellFormedVersion(cliVersion)) {
        return 'default';
    }
    return compareVersionsWithPrerelease(cliVersion, CLI_VERSION_WITH_AUTO) >= 0
        ? permissionMode
        : 'default';
}

// The opposite of the auto gate on an unknown version: a missing or mangled
// version keeps the old model, because guessing wrong here leaves a session
// whose every turn fails rather than one that asks more often.
function resolveCodeDefaultModelMode(
    agent: AgentKey,
    modelMode: string,
    cliVersion: string | null | undefined,
): string {
    if (agent !== 'claude' || modelMode !== 'claude-opus-5-5') {
        return modelMode;
    }
    if (!cliVersion || !isWellFormedVersion(cliVersion)) {
        return CLAUDE_MODEL_BEFORE_OPUS_5_5;
    }
    return compareVersionsWithPrerelease(cliVersion, CLI_VERSION_WITH_OPUS_5_5) >= 0
        ? modelMode
        : CLAUDE_MODEL_BEFORE_OPUS_5_5;
}

export function normalizeAgentKey(flavor: string | null | undefined): AgentKey {
    if (flavor === 'codex' || flavor === 'gemini' || flavor === 'openclaw' || flavor === 'agy') {
        return flavor;
    }
    return 'claude';
}

export function getCodeAgentDefaults(
    flavor: string | null | undefined,
    cliVersion?: string | null,
): AgentDefaultConfig {
    const agent = normalizeAgentKey(flavor);
    const defaults = codeAgentDefaults[agent];
    const permissionMode = resolveCodeDefaultPermissionMode(defaults.permissionMode, cliVersion);
    const modelMode = resolveCodeDefaultModelMode(agent, defaults.modelMode, cliVersion);
    return permissionMode === defaults.permissionMode && modelMode === defaults.modelMode
        ? defaults
        : { ...defaults, permissionMode, modelMode };
}

/**
 * Permission keys that were offered once and are no longer accepted, mapped to
 * what they meant. `dontAsk` never passed the CLI's message schema, so it was
 * already dropped on the wire; it is retired here so a saved copy cannot make
 * the composer show one mode while sending another.
 */
const RETIRED_PERMISSION_MODES: Record<string, string> = {
    dontAsk: 'acceptEdits',
};

/**
 * Maps a stored permission mode onto one the CLI still accepts. Applies to
 * flavor-based agents only: a harness that publishes its own catalog owns its
 * codes, and none of them collide with a retired Claude key.
 */
export function retirePermissionMode<T extends string | null | undefined>(mode: T): T | string {
    return mode ? RETIRED_PERMISSION_MODES[mode] ?? mode : mode;
}

/**
 * Claude model keys that were offered once and are no longer listed, mapped to
 * the row that runs the same thing. Each `[1m]` row duplicated a model that is
 * 1M-native in Claude Code's model table, so the plain ID gets the same window
 * without the context-1m beta header the suffix adds. (Opus is in that table on
 * every Claude Code happy-cli bundles; Sonnet 5.5 from 2.1.287, before which
 * its plain ID runs at 200K.) Without this a saved `[1m]` key matches no row,
 * and the new-session picker falls through to the head of the list.
 *
 * Only exact equivalents belong here. A model that left the list but is still
 * its own model (Sonnet 5) is not mapped to a different one; the picker keeps
 * it as a saved row instead (includeConfiguredModel).
 */
const RETIRED_CLAUDE_MODEL_MODES: Record<string, string> = {
    'claude-opus-5-5[1m]': 'claude-opus-5-5',
    'claude-opus-5[1m]': 'claude-opus-5',
    'claude-sonnet-5-5[1m]': 'claude-sonnet-5-5',
};

/**
 * Maps a stored model key onto the row that now stands for it. Claude only:
 * other harnesses, Happy Agent's included, own their model keys.
 */
export function retireModelMode<T extends string | null | undefined>(
    flavor: string | null | undefined,
    mode: T,
): T | string {
    if (!mode || flavor === 'rig' || normalizeAgentKey(flavor) !== 'claude') {
        return mode;
    }
    return RETIRED_CLAUDE_MODEL_MODES[mode] ?? mode;
}

export function getAgentDefaultOverride(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
): AgentDefaultOverride {
    const override = overrides?.[normalizeAgentKey(flavor)] ?? {};
    const permissionMode = retirePermissionMode(override.permissionMode);
    const modelMode = retireModelMode(flavor, override.modelMode);
    return permissionMode === override.permissionMode && modelMode === override.modelMode
        ? override
        : { ...override, permissionMode, modelMode };
}

export function resolveAgentDefaultConfig(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    cliVersion?: string | null,
): AgentDefaultConfig {
    const codeDefaults = getCodeAgentDefaults(flavor, cliVersion);
    const userOverride = getAgentDefaultOverride(overrides, flavor);
    return {
        permissionMode: userOverride.permissionMode ?? codeDefaults.permissionMode,
        modelMode: userOverride.modelMode ?? codeDefaults.modelMode,
        effortLevel: userOverride.effortLevel ?? codeDefaults.effortLevel,
    };
}

export function hasAgentDefaultOverride(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    field: AgentDefaultField,
): boolean {
    return getAgentDefaultOverride(overrides, flavor)[field] !== undefined;
}

export function getAgentDefaultOverrideValue(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    field: AgentDefaultField,
): string | undefined {
    return getAgentDefaultOverride(overrides, flavor)[field];
}

export function setAgentDefaultOverride(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    field: AgentDefaultField,
    value: string | null | undefined,
): AgentDefaultOverrides {
    const key = normalizeAgentKey(flavor);
    const next: AgentDefaultOverrides = { ...(overrides ?? {}) };
    const current: AgentDefaultOverride = { ...(next[key] ?? {}) };

    if (value === null || value === undefined) {
        delete current[field];
    } else {
        current[field] = value;
    }

    if (current.permissionMode === undefined && current.modelMode === undefined && current.effortLevel === undefined) {
        delete next[key];
    } else {
        next[key] = current;
    }

    return next;
}
