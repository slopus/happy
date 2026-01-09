export type AgentType = 'claude' | 'codex' | 'gemini';

/**
 * Vendor-level resume support (NOT Happy session resume).
 *
 * This controls whether we are allowed to pass `--resume <vendorSessionId>` to the agent.
 *
 * Upstream policy (slopus): Claude only.
 * Forks can extend this list (e.g. Codex if/when a custom build supports it).
 */
export const VENDOR_RESUME_SUPPORTED_AGENTS: AgentType[] = ['claude'];

export function supportsVendorResume(agent: AgentType | undefined): boolean {
  // Undefined agent means "default agent" which is Claude in this CLI.
  if (!agent) return VENDOR_RESUME_SUPPORTED_AGENTS.includes('claude');
  return VENDOR_RESUME_SUPPORTED_AGENTS.includes(agent);
}

