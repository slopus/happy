import * as React from 'react';

import type { AgentId } from './registryCore';
import { buildResumeCapabilityOptionsFromUiState, getResumeRuntimeSupportPrefetchPlan } from './registryUiBehavior';
import { useMachineCapabilitiesCache } from '@/hooks/useMachineCapabilitiesCache';
import type { ResumeCapabilityOptions } from '@/agents/resumeCapabilities';
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

    // Subscribe to the capabilities cache for this machine, but do not rely on staleMs for resume.
    // Resume gating needs to fetch additional per-agent data (e.g. ACP probe) even when the base
    // machine snapshot is fresh but missing those fields.
    const { state, refresh } = useMachineCapabilitiesCache({
        machineId,
        enabled: enabled && machineId !== null,
        request: NOOP_REQUEST,
        timeoutMs: undefined,
        staleMs: 24 * 60 * 60 * 1000,
    });

    const results = React.useMemo(() => {
        if (state.status !== 'loaded' && state.status !== 'loading') return undefined;
        return state.snapshot?.response.results as any;
    }, [state]);

    const plan = React.useMemo(() => {
        // Codex is special: ACP probing is only relevant when the Codex ACP experiment is enabled.
        if (opts.agentId === 'codex') {
            if (!(opts.experimentsEnabled === true && opts.expCodexAcp === true)) return null;
        }
        return getResumeRuntimeSupportPrefetchPlan(opts.agentId, results);
    }, [opts.agentId, opts.experimentsEnabled, opts.expCodexAcp, results]);

    const lastPrefetchRef = React.useRef<{ key: string; at: number } | null>(null);

    React.useEffect(() => {
        if (!enabled) return;
        if (!machineId) return;
        if (!plan) return;
        if (state.status === 'loading') return;

        const key = JSON.stringify(plan.request);
        const now = Date.now();
        const last = lastPrefetchRef.current;
        if (last && last.key === key && (now - last.at) < 5_000) {
            return;
        }
        lastPrefetchRef.current = { key, at: now };

        // Fetch missing runtime resume support data immediately (even if the cache is fresh).
        refresh({ request: plan.request, timeoutMs: plan.timeoutMs });
    }, [enabled, machineId, plan, refresh, state.status]);

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
