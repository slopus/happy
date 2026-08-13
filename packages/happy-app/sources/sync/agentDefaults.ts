import * as z from 'zod';

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
    // The Claude UI key for YOLO is `bypassPermissions`; the CLI also accepts
    // `yolo` and maps it to the Claude SDK's bypass mode.
    claude: { permissionMode: 'bypassPermissions', modelMode: 'opus', effortLevel: 'medium' },
    codex: { permissionMode: 'yolo', modelMode: 'gpt-5.5', effortLevel: 'medium' },
    gemini: { permissionMode: 'default', modelMode: 'gemini-2.5-pro', effortLevel: null },
    openclaw: { permissionMode: 'default', modelMode: 'default', effortLevel: null },
    agy: { permissionMode: 'default', modelMode: 'Gemini 3.1 Pro (High)', effortLevel: null },
};

// Flavors outside `agentKeys` have no static config profile of their own. `resolveSessionFlavor()`
// in happy-cli emits 'opencode' for OpenCode and 'acp' for every other ACP binary, and generic ACP
// agents advertise their models and modes at runtime (`available_models`, operating modes), so there
// is nothing meaningful to hardcode for them. Falling back to Claude's row would hand them
// Claude-only keys such as `bypassPermissions` and `opus`, which their agent never advertises.
const NEUTRAL_AGENT_DEFAULTS: AgentDefaultConfig = {
    permissionMode: 'default',
    modelMode: 'default',
    effortLevel: null,
};

// Returns the matching key, or null when the flavor has no static profile. Membership is derived
// from `agentKeys` rather than an if-chain so adding an agent cannot silently miss this path.
function matchAgentKey(flavor: string | null | undefined): AgentKey | null {
    if (!flavor) {
        return null;
    }
    return (agentKeys as readonly string[]).includes(flavor) ? flavor as AgentKey : null;
}

export function normalizeAgentKey(flavor: string | null | undefined): AgentKey {
    return matchAgentKey(flavor) ?? 'claude';
}

export function getCodeAgentDefaults(flavor: string | null | undefined): AgentDefaultConfig {
    const key = matchAgentKey(flavor);
    return key ? codeAgentDefaults[key] : NEUTRAL_AGENT_DEFAULTS;
}

export function getAgentDefaultOverride(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
): AgentDefaultOverride {
    const key = matchAgentKey(flavor);
    return (key ? overrides?.[key] : undefined) ?? {};
}

export function resolveAgentDefaultConfig(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
): AgentDefaultConfig {
    const codeDefaults = getCodeAgentDefaults(flavor);
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
    const key = matchAgentKey(flavor);
    if (!key) {
        // No slot to write to. Writing under `normalizeAgentKey`'s 'claude' fallback would edit
        // the user's Claude Code defaults instead. The Agent Defaults screen iterates `agentKeys`
        // so it never reaches this, but the read paths above are called with live session flavors.
        return { ...(overrides ?? {}) };
    }
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
