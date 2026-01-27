import type { AgentUiBehavior } from '@/agents/registryUiBehavior';

import { applyAuggieAllowIndexingEnv, AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING } from './indexing';

function getChipFactory(): typeof import('@/agents/providers/auggie/AuggieIndexingChip').createAuggieAllowIndexingChip {
    // Lazy require so Node-side tests can import `@/agents/catalog` without resolving native icon deps.
    return require('@/agents/providers/auggie/AuggieIndexingChip').createAuggieAllowIndexingChip;
}

export const AUGGIE_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    newSession: {
        buildNewSessionOptions: ({ agentOptionState }) => {
            const allowIndexing = agentOptionState?.[AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING] === true;
            return { [AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING]: allowIndexing };
        },
        getAgentInputExtraActionChips: ({ agentOptionState, setAgentOptionState }) => {
            const allowIndexing = agentOptionState?.[AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING] === true;
            const createAuggieAllowIndexingChip = getChipFactory();
            return [
                createAuggieAllowIndexingChip({
                    allowIndexing,
                    setAllowIndexing: (next) => setAgentOptionState(AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING, next),
                }),
            ];
        },
    },
    payload: {
        buildSpawnEnvironmentVariables: ({ environmentVariables, newSessionOptions }) => {
            const allowIndexing = newSessionOptions?.[AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING] === true;
            return applyAuggieAllowIndexingEnv(environmentVariables, allowIndexing) ?? environmentVariables;
        },
    },
};
