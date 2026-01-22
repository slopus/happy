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

export type ResumeCapabilityOptions = {
    /**
     * Experimental: allow Codex vendor resume.
     *
     * Default is false to keep upstream behavior (Claude-only).
     */
    allowCodexResume?: boolean;
};

export function canAgentResume(agent: string | null | undefined, options?: ResumeCapabilityOptions): boolean {
    if (typeof agent !== 'string') return false;
    if (agent === 'codex') return options?.allowCodexResume === true;
    return RESUMABLE_AGENTS.includes(agent as AgentType);
}

/**
 * Minimal metadata shape used by resume capability checks.
 *
 * Note: `metadata.flavor` comes from persisted session metadata and may be `null` or an unknown string.
 */
export interface SessionMetadata {
    flavor?: string | null;
    claudeSessionId?: string;
    codexSessionId?: string;
}

export function getAgentSessionIdField(agent: string | null | undefined): 'claudeSessionId' | 'codexSessionId' | null {
    switch (agent) {
        case 'claude':
            return 'claudeSessionId';
        case 'codex':
            return 'codexSessionId';
        default:
            return null;
    }
}

export function canResumeSession(metadata: SessionMetadata | null | undefined): boolean {
    if (!metadata) return false;

    const agent = metadata.flavor;
    if (!canAgentResume(agent)) return false;

    const field = getAgentSessionIdField(agent);
    if (!field) return false;

    const agentSessionId = metadata[field];
    return typeof agentSessionId === 'string' && agentSessionId.length > 0;
}

export function canResumeSessionWithOptions(metadata: SessionMetadata | null | undefined, options?: ResumeCapabilityOptions): boolean {
    if (!metadata) return false;
    const agent = metadata.flavor;
    if (!canAgentResume(agent, options)) return false;
    const field = getAgentSessionIdField(agent);
    if (!field) return false;
    const agentSessionId = metadata[field];
    return typeof agentSessionId === 'string' && agentSessionId.length > 0;
}

export function getAgentSessionId(metadata: SessionMetadata | null | undefined): string | null {
    if (!metadata) return null;
    const field = getAgentSessionIdField(metadata.flavor);
    if (!field) return null;
    const agentSessionId = metadata[field];
    return typeof agentSessionId === 'string' && agentSessionId.length > 0 ? agentSessionId : null;
}
