import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { machineBash } from '@/sync/ops';
import { useMachine } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { useMachineDetectCliCache } from '@/hooks/useMachineDetectCliCache';

function debugLog(...args: unknown[]) {
    if (__DEV__) {
        // eslint-disable-next-line no-console
        console.log(...args);
    }
}

interface CLIAvailability {
    claude: boolean | null; // null = unknown/loading, true = installed, false = not installed
    codex: boolean | null;
    gemini: boolean | null;
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
     * When false, the hook will be cache-only (no automatic detect-cli fetches,
     * and no bash fallback probing). Intended for cache-first UIs.
     */
    autoDetect?: boolean;
    /**
     * When true, requests login status detection (can be heavier than basic detection).
     */
    includeLoginStatus?: boolean;
}

/**
 * Detects which CLI tools (claude, codex, gemini) are installed on a remote machine.
 *
 * NON-BLOCKING: Detection runs asynchronously in useEffect. UI shows all profiles
 * while detection is in progress, then updates when results arrive.
 *
 * Detection is automatic when machineId changes. Prefers a dedicated `detect-cli`
 * RPC (daemon PATH resolution; no shell). Falls back to machineBash() probing
 * for older daemons that don't support `detect-cli`.
 *
 * CONSERVATIVE FALLBACK: If detection fails (network error, timeout, bash error),
 * sets all CLIs to null and timestamp to 0, hiding status from UI.
 * User discovers CLI availability when attempting to spawn.
 *
 * @param machineId - The machine to detect CLIs on (null = no detection)
 * @returns CLI availability status for claude, codex, and gemini
 *
 * @example
 * const cliAvailability = useCLIDetection(selectedMachineId);
 * if (cliAvailability.claude === false) {
 *     // Show "Claude CLI not detected" warning
 * }
 */
export function useCLIDetection(machineId: string | null, options?: UseCLIDetectionOptions): CLIAvailability {
    const machine = useMachine(machineId ?? '');
    const isOnline = useMemo(() => {
        if (!machineId || !machine) return false;
        return isMachineOnline(machine);
    }, [machine, machineId]);

    const autoDetect = options?.autoDetect !== false;

    const { state: cached } = useMachineDetectCliCache({
        machineId,
        enabled: isOnline && autoDetect,
        includeLoginStatus: Boolean(options?.includeLoginStatus),
    });

    const lastSuccessfulDetectAtRef = useRef<number>(0);
    const bashInFlightRef = useRef<Promise<void> | null>(null);
    const bashLastRanAtRef = useRef<number>(0);

    const [bashAvailability, setBashAvailability] = useState<{
        machineId: string;
        claude: boolean | null;
        codex: boolean | null;
        gemini: boolean | null;
        timestamp: number;
        error?: string;
    } | null>(null);

    const runBashFallback = useCallback(async () => {
        if (!machineId) return;
        if (bashInFlightRef.current) return bashInFlightRef.current;

        const now = Date.now();
        // Avoid hammering bash probing if something is wrong.
        if ((now - bashLastRanAtRef.current) < 15_000) {
            return;
        }
        bashLastRanAtRef.current = now;

        bashInFlightRef.current = (async () => {
            try {
                const result = await machineBash(
                    machineId,
                    '(command -v claude >/dev/null 2>&1 && echo "claude:true" || echo "claude:false") && ' +
                    '(command -v codex >/dev/null 2>&1 && echo "codex:true" || echo "codex:false") && ' +
                    '(command -v gemini >/dev/null 2>&1 && echo "gemini:true" || echo "gemini:false")',
                    '/'
                );

                debugLog('[useCLIDetection] bash fallback result:', { success: result.success, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });

                if (result.success && result.exitCode === 0) {
                    const lines = result.stdout.trim().split('\n');
                    const cliStatus: { claude?: boolean; codex?: boolean; gemini?: boolean } = {};

                    lines.forEach(line => {
                        const [cli, status] = line.split(':');
                        if (cli && status) {
                            cliStatus[cli.trim() as 'claude' | 'codex' | 'gemini'] = status.trim() === 'true';
                        }
                    });

                    setBashAvailability({
                        machineId,
                        claude: cliStatus.claude ?? null,
                        codex: cliStatus.codex ?? null,
                        gemini: cliStatus.gemini ?? null,
                        timestamp: Date.now(),
                    });
                    return;
                }

                setBashAvailability({
                    machineId,
                    claude: null,
                    codex: null,
                    gemini: null,
                    timestamp: 0,
                    error: `Detection failed: ${result.stderr || 'Unknown error'}`,
                });
            } catch (error) {
                setBashAvailability({
                    machineId,
                    claude: null,
                    codex: null,
                    gemini: null,
                    timestamp: 0,
                    error: error instanceof Error ? error.message : 'Detection error',
                });
            } finally {
                bashInFlightRef.current = null;
            }
        })();

        return bashInFlightRef.current;
    }, [machineId]);

    useEffect(() => {
        if (!machineId || !isOnline) {
            setBashAvailability(null);
            return;
        }

        // If detect-cli isn't supported or errored, fall back to bash probing (once).
        if (autoDetect && (cached.status === 'not-supported' || cached.status === 'error')) {
            void runBashFallback();
        }
    }, [autoDetect, cached.status, isOnline, machineId, runBashFallback]);

    return useMemo((): CLIAvailability => {
        if (!machineId || !isOnline) {
            return {
                claude: null,
                codex: null,
                gemini: null,
                login: { claude: null, codex: null, gemini: null },
                isDetecting: false,
                timestamp: 0
            };
        }

        const cachedResponse =
            cached.status === 'loaded'
                ? cached.response
                : cached.status === 'loading'
                    ? cached.response
                    : null;

        if (cachedResponse) {
            const now = Date.now();
            if (cached.status === 'loaded') {
                lastSuccessfulDetectAtRef.current = now;
            }
            return {
                claude: cachedResponse.clis.claude.available,
                codex: cachedResponse.clis.codex.available,
                gemini: cachedResponse.clis.gemini.available,
                login: {
                    claude: options?.includeLoginStatus ? (cachedResponse.clis.claude.isLoggedIn ?? null) : null,
                    codex: options?.includeLoginStatus ? (cachedResponse.clis.codex.isLoggedIn ?? null) : null,
                    gemini: options?.includeLoginStatus ? (cachedResponse.clis.gemini.isLoggedIn ?? null) : null,
                },
                isDetecting: cached.status === 'loading',
                timestamp: lastSuccessfulDetectAtRef.current || now,
            };
        }

        // No cached response yet. If bash fallback has data for this machine, use it.
        if (bashAvailability?.machineId === machineId) {
            return {
                claude: bashAvailability.claude,
                codex: bashAvailability.codex,
                gemini: bashAvailability.gemini,
                login: { claude: null, codex: null, gemini: null },
                isDetecting: cached.status === 'loading' || bashInFlightRef.current !== null,
                timestamp: bashAvailability.timestamp,
                ...(bashAvailability.error ? { error: bashAvailability.error } : {}),
            };
        }

        return {
            claude: null,
            codex: null,
            gemini: null,
            login: { claude: null, codex: null, gemini: null },
            isDetecting: cached.status === 'loading',
            timestamp: 0,
            ...(cached.status === 'error' ? { error: 'Detection error' } : {}),
        };
    }, [bashAvailability, cached, isOnline, machineId, options?.includeLoginStatus]);
}
