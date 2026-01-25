import type { AgentId } from './registryCore';
import { AGENT_IDS, getAgentCore } from './registryCore';

export function isAgentEnabled(params: {
    agentId: AgentId;
    experiments: boolean;
    experimentalAgents: Record<string, boolean> | null | undefined;
}): boolean {
    const cfg = getAgentCore(params.agentId);
    if (!cfg.availability.experimental) return true;
    if (params.experiments !== true) return false;
    return params.experimentalAgents?.[params.agentId] === true;
}

export function getEnabledAgentIds(params: {
    experiments: boolean;
    experimentalAgents: Record<string, boolean> | null | undefined;
}): AgentId[] {
    return AGENT_IDS.filter((agentId) =>
        isAgentEnabled({ agentId, experiments: params.experiments, experimentalAgents: params.experimentalAgents }),
    );
}
