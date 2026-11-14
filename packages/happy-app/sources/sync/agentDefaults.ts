import * as z from 'zod';
import { isRetiredAgentFlavor } from './retiredSessions';

export const agentKeys = ['ask', 'claude', 'codex', 'gemini', 'opencode', 'openclaw'] as const;
export type AgentKey = typeof agentKeys[number];

export const AgentDefaultOverrideSchema = z.object({
    permissionMode: z.string().optional(),
    modelMode: z.string().optional(),
    effortLevel: z.string().optional(),
}).passthrough();

export const AgentDefaultOverridesSchema = z.object({
    ask: AgentDefaultOverrideSchema.optional(),
    claude: AgentDefaultOverrideSchema.optional(),
    codex: AgentDefaultOverrideSchema.optional(),
    gemini: AgentDefaultOverrideSchema.optional(),
    opencode: AgentDefaultOverrideSchema.optional(),
    openclaw: AgentDefaultOverrideSchema.optional(),
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
    ask: { permissionMode: 'default', modelMode: 'deepseek/deepseek-v4-flash', effortLevel: null },
    claude: { permissionMode: 'bypassPermissions', modelMode: 'opus', effortLevel: 'medium' },
    codex: { permissionMode: 'yolo', modelMode: 'gpt-6.1-sol', effortLevel: 'medium' },
    gemini: { permissionMode: 'default', modelMode: 'gemini-2.5-pro', effortLevel: null },
    opencode: { permissionMode: 'default', modelMode: 'sub2api/gpt-5.5', effortLevel: null },
    openclaw: { permissionMode: 'default', modelMode: 'default', effortLevel: null },
};

export function normalizeAgentKey(flavor: string | null | undefined): AgentKey {
    if (isRetiredAgentFlavor(flavor)) throw new Error('personal-agent-retired');
    if (flavor === 'ask' || flavor === 'codex' || flavor === 'gemini' || flavor === 'opencode' || flavor === 'openclaw') {
        return flavor;
    }
    return 'claude';
}

export function getCodeAgentDefaults(flavor: string | null | undefined): AgentDefaultConfig {
    return codeAgentDefaults[normalizeAgentKey(flavor)];
}

function normalizeAgentDefaultOverride(
    flavor: string | null | undefined,
    override: AgentDefaultOverride | undefined,
): AgentDefaultOverride {
    if (!override) {
        return {};
    }

    if (normalizeAgentKey(flavor) !== 'codex' || override.permissionMode !== 'default') {
        return override;
    }

    const { permissionMode: _permissionMode, ...rest } = override;
    return rest;
}

export function getAgentDefaultOverride(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
): AgentDefaultOverride {
    return normalizeAgentDefaultOverride(flavor, overrides?.[normalizeAgentKey(flavor)]);
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
    const key = normalizeAgentKey(flavor);
    const next: AgentDefaultOverrides = { ...(overrides ?? {}) };
    const current: AgentDefaultOverride = { ...(next[key] ?? {}) };

    if (value === null || value === undefined || (key === 'codex' && field === 'permissionMode' && value === 'default')) {
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
