import { useMemo, useRef } from 'react';
import { useMachine } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { useMachineCapabilitiesCache } from '@/hooks/useMachineCapabilitiesCache';
import type { CapabilityDetectResult, CliCapabilityData, TmuxCapabilityData } from '@/sync/capabilitiesProtocol';
import { CAPABILITIES_REQUEST_NEW_SESSION, CAPABILITIES_REQUEST_NEW_SESSION_WITH_LOGIN_STATUS } from '@/capabilities/requests';

interface CLIAvailability {
    claude: boolean | null; // null = unknown/loading, true = installed, false = not installed
    codex: boolean | null;
    gemini: boolean | null;
    tmux: boolean | null;
    login: {
        claude: boolean | null; // null = unknown/unsupported
        codex: boolean | null;
        gemini: boolean | null;
    };
    isDetecting: boolean; // Explicit loading state
    timestamp: number; // When detection completed
    error?: string; // Detection error message (for debugging)
}

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
    const request = includeLoginStatus
        ? CAPABILITIES_REQUEST_NEW_SESSION_WITH_LOGIN_STATUS
        : CAPABILITIES_REQUEST_NEW_SESSION;

    const { state: cached } = useMachineCapabilitiesCache({
        machineId,
        enabled: isOnline && options?.autoDetect !== false,
        request,
    });

    const lastSuccessfulDetectAtRef = useRef<number>(0);
    const fallbackDetectAtRef = useRef<number>(0);

    return useMemo((): CLIAvailability => {
        if (!machineId || !isOnline) {
            return {
                claude: null,
                codex: null,
                gemini: null,
                tmux: null,
                login: { claude: null, codex: null, gemini: null },
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
            return {
                claude: null,
                codex: null,
                gemini: null,
                tmux: null,
                login: { claude: null, codex: null, gemini: null },
                isDetecting: cached.status === 'loading',
                timestamp: 0,
                ...(cached.status === 'error' ? { error: 'Detection error' } : {}),
            };
        }

        return {
            claude: readCliAvailable(results['cli.claude']),
            codex: readCliAvailable(results['cli.codex']),
            gemini: readCliAvailable(results['cli.gemini']),
            tmux: readTmuxAvailable(results['tool.tmux']),
            login: {
                claude: includeLoginStatus ? readCliLogin(results['cli.claude']) : null,
                codex: includeLoginStatus ? readCliLogin(results['cli.codex']) : null,
                gemini: includeLoginStatus ? readCliLogin(results['cli.gemini']) : null,
            },
            isDetecting: cached.status === 'loading',
            timestamp: lastSuccessfulDetectAtRef.current || latestCheckedAt || fallbackDetectAtRef.current || 0,
        };
    }, [cached, includeLoginStatus, isOnline, machineId]);
}
