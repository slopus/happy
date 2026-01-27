export const AGENT_IDS = ['claude', 'codex', 'opencode', 'gemini'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export type VendorResumeSupportLevel = 'supported' | 'unsupported' | 'experimental';
export type ResumeRuntimeGate = 'acpLoadSession' | null;

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
    resume: Readonly<{
        /**
         * Whether vendor-resume is supported in principle.
         *
         * - supported: generally supported and expected to work
         * - experimental: supported but intentionally gated/opt-in
         * - unsupported: not available (or only available via runtime capability checks)
         */
        vendorResume: VendorResumeSupportLevel;
        /**
         * Optional runtime gate used by apps to enable resume dynamically per machine.
         */
        runtimeGate: ResumeRuntimeGate;
    }>;
}>;

