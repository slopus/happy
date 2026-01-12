/**
 * Agent capability configuration.
 *
 * Upstream behavior: resume-from-UI is currently supported only for Claude.
 * Forks can add additional flavors in fork-only branches.
 */

export type AgentType = 'claude' | 'codex' | 'gemini';

/**
 * Agents that support vendor resume IDs (e.g. Claude Code session ID) for resume-from-UI.
 */
export const RESUMABLE_AGENTS: AgentType[] = ['claude'];

export function canAgentResume(agent: AgentType | undefined): boolean {
    if (!agent) return false;
    return RESUMABLE_AGENTS.includes(agent);
}
