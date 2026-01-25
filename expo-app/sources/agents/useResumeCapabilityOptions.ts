import * as React from 'react';

import type { AgentId } from './registryCore';
import { buildResumeCapabilityOptionsFromUiState, getResumeRuntimeSupportPrefetchPlan } from './registryUiBehavior';
import { useMachineCapabilitiesCache } from '@/hooks/useMachineCapabilitiesCache';
import type { ResumeCapabilityOptions } from '@/utils/agentCapabilities';
import type { CapabilitiesDetectRequest } from '@/sync/capabilitiesProtocol';

const NOOP_REQUEST: CapabilitiesDetectRequest = { requests: [] };

export function useResumeCapabilityOptions(opts: {
    agentId: AgentId;
    machineId: string | null | undefined;
    experimentsEnabled: boolean;
    expCodexResume: boolean;
    expCodexAcp: boolean;
    enabled?: boolean;
}): {
    resumeCapabilityOptions: ResumeCapabilityOptions;
} {
    const enabled = opts.enabled !== false;
    const machineId = typeof opts.machineId === 'string' ? opts.machineId : null;

    const plan = React.useMemo(() => {
        return getResumeRuntimeSupportPrefetchPlan(opts.agentId, undefined);
    }, [opts.agentId]);

    const { state } = useMachineCapabilitiesCache({
        machineId,
        enabled: enabled && machineId !== null && plan !== null,
        request: plan?.request ?? NOOP_REQUEST,
        timeoutMs: plan?.timeoutMs,
        staleMs: 24 * 60 * 60 * 1000,
    });

    const results = React.useMemo(() => {
        if (state.status !== 'loaded' && state.status !== 'loading') return undefined;
        return state.snapshot?.response.results as any;
    }, [state]);

    const resumeCapabilityOptions = React.useMemo(() => {
        return buildResumeCapabilityOptionsFromUiState({
            experimentsEnabled: opts.experimentsEnabled,
            expCodexResume: opts.expCodexResume,
            expCodexAcp: opts.expCodexAcp,
            results,
        });
    }, [opts.expCodexAcp, opts.expCodexResume, opts.experimentsEnabled, results]);

    return { resumeCapabilityOptions };
}
