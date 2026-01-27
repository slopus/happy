/**
 * Agent capability configuration.
 *
 * Resume behavior is agent-specific and may be:
 * - always available (vendor-native),
 * - runtime-gated per machine (capability probing), or
 * - experimental (requires explicit opt-in).
 */

import type { AgentId } from '@/agents/catalog';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog';

export type ResumeCapabilityOptions = {
    /**
     * Experimental: enable vendor-resume for agents that require explicit opt-in.
     */
    allowExperimentalResumeByAgentId?: Partial<Record<AgentId, boolean>>;
    /**
     * Runtime: enable vendor resume for agents that can be detected dynamically per machine.
     * (Example: Gemini ACP loadSession support.)
     */
    allowRuntimeResumeByAgentId?: Partial<Record<AgentId, boolean>>;
};

export function canAgentResume(agent: string | null | undefined, options?: ResumeCapabilityOptions): boolean {
    if (typeof agent !== 'string') return false;
    const agentId = resolveAgentIdFromFlavor(agent);
    if (!agentId) return false;
    const core = getAgentCore(agentId);
    if (core.resume.supportsVendorResume !== true) {
        return options?.allowRuntimeResumeByAgentId?.[agentId] === true;
    }
    if (core.resume.experimental !== true) return true;
    return options?.allowExperimentalResumeByAgentId?.[agentId] === true;
}

/**
 * Minimal metadata shape used by resume capability checks.
 *
 * Note: `metadata.flavor` comes from persisted session metadata and may be `null` or an unknown string.
 */
export interface SessionMetadata {
    flavor?: string | null;
    // Vendor resume id fields vary by agent; store them as plain string properties on metadata.
    [key: string]: unknown;
}

export function getAgentSessionIdField(agent: string | null | undefined): string | null {
    const agentId = resolveAgentIdFromFlavor(agent);
    if (!agentId) return null;
    return getAgentCore(agentId).resume.vendorResumeIdField;
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

export function getAgentVendorResumeId(
    metadata: SessionMetadata | null | undefined,
    agent: string | null | undefined,
    options?: ResumeCapabilityOptions,
): string | null {
    if (!metadata) return null;
    if (!canAgentResume(agent, options)) return null;
    const field = getAgentSessionIdField(agent);
    if (!field) return null;
    const agentSessionId = metadata[field];
    return typeof agentSessionId === 'string' && agentSessionId.length > 0 ? agentSessionId : null;
}
