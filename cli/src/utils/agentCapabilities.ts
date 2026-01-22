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

export function isExperimentalCodexVendorResumeEnabled(): boolean {
  const raw = process.env.HAPPY_EXPERIMENTAL_CODEX_RESUME;
  return typeof raw === 'string' && ['true', '1', 'yes'].includes(raw.trim().toLowerCase());
}

export function supportsVendorResume(
  agent: AgentType | undefined,
  options?: { allowExperimentalCodex?: boolean },
): boolean {
  // Undefined agent means "default agent" which is Claude in this CLI.
  if (!agent) return true;
  if (agent === 'codex') return options?.allowExperimentalCodex === true || isExperimentalCodexVendorResumeEnabled();
  return VENDOR_RESUME_SUPPORTED_AGENTS.includes(agent);
}
