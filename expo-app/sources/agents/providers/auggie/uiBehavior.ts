import type { AgentUiBehavior } from '@/agents/registryUiBehavior';

import { applyAuggieAllowIndexingEnv, AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING } from './indexing';

export const AUGGIE_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    payload: {
        buildSpawnEnvironmentVariables: ({ environmentVariables, newSessionOptions }) => {
            const allowIndexing = newSessionOptions?.[AUGGIE_NEW_SESSION_OPTION_ALLOW_INDEXING] === true;
            return applyAuggieAllowIndexingEnv(environmentVariables, allowIndexing) ?? environmentVariables;
        },
    },
};

