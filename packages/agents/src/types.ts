export const AGENT_IDS = ['claude', 'codex', 'opencode', 'gemini'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export type VendorResumeSupportLevel = 'supported' | 'unsupported' | 'experimental';
export type ResumeRuntimeGate = 'acpLoadSession' | null;

export type VendorResumeIdField = 'codexSessionId' | 'geminiSessionId' | 'opencodeSessionId';

export type AgentCore = Readonly<{
    id: AgentId;
    /**
     * CLI subcommand used to spawn/select the agent.
     * For now this matches the canonical id.
     */
    cliSubcommand: AgentId;
    /**
     * CLI binary name used for local detection (e.g. `command -v <detectKey>`).
     * For now this matches the canonical id.
     */
    detectKey: AgentId;
    /**
     * Optional alternative flavors that should resolve to this agent id.
     *
     * This is intended for internal variants (e.g. `codex-acp`) and UI legacy
     * strings; the canonical id should remain the primary persisted value.
     */
    flavorAliases?: ReadonlyArray<string>;
    resume: Readonly<{
        /**
         * Whether vendor-resume is supported in principle.
         *
         * - supported: generally supported and expected to work
         * - experimental: supported but intentionally gated/opt-in
         * - unsupported: not available at all
         */
        vendorResume: VendorResumeSupportLevel;
        /**
         * Optional metadata field name used to persist the vendor resume id.
         *
         * This lets UI + CLI agree on which metadata key to read/write without
         * duplicating strings.
         */
        vendorResumeIdField?: VendorResumeIdField | null;
        /**
         * Optional runtime gate used by apps to enable resume dynamically per machine.
         */
        runtimeGate: ResumeRuntimeGate;
    }>;
}>;
