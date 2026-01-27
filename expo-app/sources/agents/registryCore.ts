import type { ModelMode } from '@/sync/permissionTypes';
import type { TranslationKey } from '@/text';
import type { Href } from 'expo-router';

import { AGENT_IDS, DEFAULT_AGENT_ID, type AgentId } from '@happy/agents';

import { CLAUDE_CORE } from './providers/claude/core';
import { CODEX_CORE } from './providers/codex/core';
import { OPENCODE_CORE } from './providers/opencode/core';
import { GEMINI_CORE } from './providers/gemini/core';
import { AUGGIE_CORE } from './providers/auggie/core';

export { AGENT_IDS, DEFAULT_AGENT_ID };
export type { AgentId };

export type PermissionModeGroupId = 'claude' | 'codexLike';
export type PermissionPromptProtocol = 'claude' | 'codexDecision';

export type VendorResumeIdField = string;
export type MachineLoginKey = string;

export type ResumeRuntimeGate = 'acpLoadSession' | null;

export type AgentCoreConfig = Readonly<{
    id: AgentId;
    /**
     * Translation key for the agent display name in UI.
     * (Resolved via `t(...)` in UI modules.)
     */
    displayNameKey: TranslationKey;
    /**
     * Translation key for the agent subtitle in profile/session pickers.
     */
    subtitleKey: TranslationKey;
    /**
     * Translation key prefix for permission mode labels/badges.
     * Examples:
     * - Claude: `agentInput.permissionMode.*`
     * - Codex: `agentInput.codexPermissionMode.*`
     * - Gemini: `agentInput.geminiPermissionMode.*`
     */
    permissionModeI18nPrefix: string;
    availability: Readonly<{
        /**
         * When true, this agent is gated behind `settings.experiments` + `settings.experimentalAgents[id]`.
         */
        experimental: boolean;
    }>;
    connectedService: Readonly<{
        /**
         * Server-side connected service id (e.g. `anthropic`, `openai`).
         * When null, the agent has no account-level OAuth connection surface in the UI.
         */
        id: string | null;
        /**
         * Human-friendly name shown in account settings.
         * (This is intentionally not i18n'd yet; can be moved to translations later.)
         */
        name: string;
        /**
         * Optional app route used to connect the service.
         */
        connectRoute?: Href | null;
    }>;
    flavorAliases: readonly string[];
    cli: Readonly<{
        /**
         * The shell command name used for CLI detection (and for UX copy).
         * Example: `command -v <detectKey>`.
         */
        detectKey: string;
        /**
         * Profile-level machine-login identifier used when `profile.authMode=machineLogin`.
         * Stored in `profile.requiresMachineLogin`.
         */
        machineLoginKey: MachineLoginKey;
        /**
         * Optional UX metadata for "CLI not detected" banners.
         */
        installBanner: Readonly<{
            /**
             * When "command", show `newSession.cliBanners.installCommand` with `installCommand`.
             * When "ifAvailable", show `newSession.cliBanners.installCliIfAvailable` with the CLI name.
             */
            installKind: 'command' | 'ifAvailable';
            installCommand?: string;
            guideUrl?: string;
        }>;
        /**
         * Canonical agent id passed to daemon RPCs (spawn/resume).
         * Keep this stable; do not use aliases here.
         */
        spawnAgent: AgentId;
    }>;
    permissions: Readonly<{
        modeGroup: PermissionModeGroupId;
        promptProtocol: PermissionPromptProtocol;
    }>;
    model: Readonly<{
        supportsSelection: boolean;
        defaultMode: ModelMode;
        allowedModes: readonly ModelMode[];
    }>;
    resume: Readonly<{
        /**
         * Field in session metadata containing the vendor resume id, if supported.
         */
        vendorResumeIdField: VendorResumeIdField | null;
        /**
         * Translation keys for showing/copying the vendor resume id in the session info UI.
         * When null, the UI should not render a resume id row for this agent.
         */
        uiVendorResumeIdLabelKey: TranslationKey | null;
        uiVendorResumeIdCopiedKey: TranslationKey | null;
        /**
         * Whether this agent can be resumed from UI in principle.
         * (May still be gated by experiments in higher-level helpers.)
         */
        supportsVendorResume: boolean;
        /**
         * Runtime-gated resume support mechanism (when `supportsVendorResume=false`).
         * When set, the UI/CLI can detect resume support dynamically per machine.
         */
        runtimeGate: ResumeRuntimeGate;
        /**
         * When true, vendor-resume support is considered experimental and must be enabled explicitly
         * by callers (e.g. via feature flags / experiments).
         */
        experimental: boolean;
    }>;
    toolRendering: Readonly<{
        /**
         * When true, unknown tools should be hidden/minimal to avoid noisy internal tools.
         */
        hideUnknownToolsByDefault: boolean;
    }>;
    ui: Readonly<{
        /**
         * Icon used in agent picker UIs (Ionicons name).
         * Kept here as a string so it remains Node-safe (tests can import it).
         */
        agentPickerIconName: string;
        /**
         * Optional font size scale used for CLI glyph renderers (dingbat-based).
         */
        cliGlyphScale: number;
        /**
         * Optional font size scale used for profile compatibility glyph renderers.
         */
        profileCompatibilityGlyphScale: number;
    }>;
}>;

export const AGENTS_CORE: Readonly<Record<AgentId, AgentCoreConfig>> = Object.freeze({
    claude: CLAUDE_CORE,
    codex: CODEX_CORE,
    opencode: OPENCODE_CORE,
    gemini: GEMINI_CORE,
    auggie: AUGGIE_CORE,
});

export function isAgentId(value: unknown): value is AgentId {
    return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value);
}

export function getAgentCore(id: AgentId): AgentCoreConfig {
    return AGENTS_CORE[id];
}

export function resolveAgentIdFromFlavor(flavor: string | null | undefined): AgentId | null {
    if (typeof flavor !== 'string') return null;
    const normalized = flavor.trim().toLowerCase();
    if (!normalized) return null;

    for (const id of AGENT_IDS) {
        const cfg = AGENTS_CORE[id];
        if (cfg.flavorAliases.includes(normalized)) return id;
    }
    return null;
}

export function resolveAgentIdFromCliDetectKey(detectKey: string | null | undefined): AgentId | null {
    if (typeof detectKey !== 'string') return null;
    const normalized = detectKey.trim().toLowerCase();
    if (!normalized) return null;
    for (const id of AGENT_IDS) {
        if (AGENTS_CORE[id].cli.detectKey === normalized) return id;
    }
    return null;
}

export function resolveAgentIdFromConnectedServiceId(serviceId: string | null | undefined): AgentId | null {
    if (typeof serviceId !== 'string') return null;
    const normalized = serviceId.trim().toLowerCase();
    if (!normalized) return null;
    for (const id of AGENT_IDS) {
        const svc = AGENTS_CORE[id].connectedService?.id;
        if (typeof svc === 'string' && svc.toLowerCase() === normalized) return id;
    }
    return null;
}
