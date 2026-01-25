import * as React from 'react';

import { useSetting } from '@/sync/storage';

import { getEnabledAgentIds } from './enabled';
import type { AgentId } from './registryCore';

export function useEnabledAgentIds(): AgentId[] {
    const experiments = useSetting('experiments');
    const experimentalAgents = useSetting('experimentalAgents');

    return React.useMemo(() => {
        return getEnabledAgentIds({ experiments, experimentalAgents });
    }, [experiments, experimentalAgents]);
}

