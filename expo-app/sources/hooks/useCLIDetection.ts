import { useMemo, useRef } from 'react';
import { useMachine } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { useMachineCapabilitiesCache } from '@/hooks/useMachineCapabilitiesCache';
import type { CapabilityDetectResult, CliCapabilityData, TmuxCapabilityData } from '@/sync/capabilitiesProtocol';
import { AGENT_IDS, type AgentId, getAgentCore } from '@/agents/catalog';
import { CHECKLIST_IDS } from '@happy/protocol/checklists';

export type CLIAvailability = Readonly<{
    available: Readonly<Record<AgentId, boolean | null>>; // null = unknown/loading, true = installed, false = not installed
    login: Readonly<Record<AgentId, boolean | null>>; // null = unknown/unsupported
    tmux: boolean | null;
    isDetecting: boolean; // Explicit loading state
    timestamp: number; // When detection completed
    error?: string; // Detection error message (for debugging)
}>;

export interface UseCLIDetectionOptions {
    /**
     * When false, the hook will be cache-only (no automatic detection refresh).
     */
    autoDetect?: boolean;
    /**
     * When true, requests login status detection (best-effort; may return null).
     */
    includeLoginStatus?: boolean;
}

function readCliAvailable(result: CapabilityDetectResult | undefined): boolean | null {
    if (!result || !result.ok) return null;
    const data = result.data as Partial<CliCapabilityData> | undefined;
    return typeof data?.available === 'boolean' ? data.available : null;
}

function readCliLogin(result: CapabilityDetectResult | undefined): boolean | null {
    if (!result || !result.ok) return null;
    const data = result.data as Partial<CliCapabilityData> | undefined;
    const v = data?.isLoggedIn;
    return typeof v === 'boolean' ? v : null;
}

function readTmuxAvailable(result: CapabilityDetectResult | undefined): boolean | null {
    if (!result || !result.ok) return null;
    const data = result.data as Partial<TmuxCapabilityData> | undefined;
    return typeof data?.available === 'boolean' ? data.available : null;
}

export function useCLIDetection(machineId: string | null, options?: UseCLIDetectionOptions): CLIAvailability {
    const machine = useMachine(machineId ?? '');
    const isOnline = useMemo(() => {
        if (!machineId || !machine) return false;
        return isMachineOnline(machine);
    }, [machine, machineId]);

    const includeLoginStatus = Boolean(options?.includeLoginStatus);
    const request = useMemo(() => {
        if (!includeLoginStatus) return { checklistId: CHECKLIST_IDS.NEW_SESSION };
        const overrides: Record<string, { params: { includeLoginStatus: true } }> = {};
        for (const agentId of AGENT_IDS) {
            overrides[`cli.${getAgentCore(agentId).cli.detectKey}`] = { params: { includeLoginStatus: true } };
        }
        return {
            checklistId: CHECKLIST_IDS.NEW_SESSION,
            overrides: overrides as any,
        };
    }, [includeLoginStatus]);

    const { state: cached } = useMachineCapabilitiesCache({
        machineId,
        enabled: isOnline && options?.autoDetect !== false,
        request,
    });

    const lastSuccessfulDetectAtRef = useRef<number>(0);
    const fallbackDetectAtRef = useRef<number>(0);

    return useMemo((): CLIAvailability => {
        if (!machineId || !isOnline) {
            const available: Record<AgentId, boolean | null> = {} as any;
            const login: Record<AgentId, boolean | null> = {} as any;
            for (const agentId of AGENT_IDS) {
                available[agentId] = null;
                login[agentId] = null;
            }
            return {
                available,
                login,
                tmux: null,
                isDetecting: false,
                timestamp: 0,
            };
        }

        const snapshot =
            cached.status === 'loaded'
                ? cached.snapshot
                : cached.status === 'loading'
                    ? cached.snapshot
                    : cached.status === 'error'
                        ? cached.snapshot
                        : undefined;

        const results = snapshot?.response.results ?? {};
        const resultsById = results as Record<string, CapabilityDetectResult | undefined>;
        const now = Date.now();
        const latestCheckedAt = Math.max(
            0,
            ...(Object.values(results)
                .map((r) => (r && typeof r.checkedAt === 'number' ? r.checkedAt : 0))),
        );

        if (cached.status === 'loaded' && latestCheckedAt > 0) {
            lastSuccessfulDetectAtRef.current = latestCheckedAt;
            fallbackDetectAtRef.current = 0;
        } else if (cached.status === 'loaded' && latestCheckedAt === 0 && lastSuccessfulDetectAtRef.current === 0 && fallbackDetectAtRef.current === 0) {
            // Older/broken snapshots could omit checkedAt values; keep a stable "loaded" timestamp
            // rather than flapping Date.now() on re-renders.
            fallbackDetectAtRef.current = now;
        }

        if (!snapshot) {
            const available: Record<AgentId, boolean | null> = {} as any;
            const login: Record<AgentId, boolean | null> = {} as any;
            for (const agentId of AGENT_IDS) {
                available[agentId] = null;
                login[agentId] = null;
            }
            return {
                available,
                login,
                tmux: null,
                isDetecting: cached.status === 'loading',
                timestamp: 0,
                ...(cached.status === 'error' ? { error: 'Detection error' } : {}),
            };
        }

        const available: Record<AgentId, boolean | null> = {} as any;
        const login: Record<AgentId, boolean | null> = {} as any;
        for (const agentId of AGENT_IDS) {
            const capId = `cli.${getAgentCore(agentId).cli.detectKey}`;
            available[agentId] = readCliAvailable(resultsById[capId]);
            login[agentId] = includeLoginStatus ? readCliLogin(resultsById[capId]) : null;
        }

        return {
            available,
            login,
            tmux: readTmuxAvailable(results['tool.tmux']),
            isDetecting: cached.status === 'loading',
            timestamp: lastSuccessfulDetectAtRef.current || latestCheckedAt || fallbackDetectAtRef.current || 0,
        };
    }, [cached, includeLoginStatus, isOnline, machineId]);
}
