import { useState, useEffect } from 'react';
import { machineBash, machineDetectCli } from '@/sync/ops';

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
    isDetecting: boolean; // Explicit loading state
    timestamp: number; // When detection completed
    error?: string; // Detection error message (for debugging)
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
export function useCLIDetection(machineId: string | null): CLIAvailability {
    const [availability, setAvailability] = useState<CLIAvailability>({
        claude: null,
        codex: null,
        gemini: null,
        isDetecting: false,
        timestamp: 0,
    });

    useEffect(() => {
        if (!machineId) {
            setAvailability({ claude: null, codex: null, gemini: null, isDetecting: false, timestamp: 0 });
            return;
        }

        let cancelled = false;

        const detectCLIs = async () => {
            // Set detecting flag (non-blocking - UI stays responsive)
            setAvailability(prev => ({ ...prev, isDetecting: true }));
            debugLog('[useCLIDetection] Starting detection for machineId:', machineId);

            try {
                // Preferred path: ask the daemon directly (no shell).
                const cliStatus = await Promise.race([
                    machineDetectCli(machineId),
                    new Promise<{ supported: false }>((resolve) => {
                        // If the daemon is older/broken and never responds to unknown RPCs,
                        // don't hang the UI—fallback to bash probing quickly.
                        setTimeout(() => resolve({ supported: false }), 2000);
                    }),
                ]);
                if (cancelled) return;

                if (cliStatus.supported) {
                    setAvailability({
                        claude: cliStatus.response.clis.claude.available,
                        codex: cliStatus.response.clis.codex.available,
                        gemini: cliStatus.response.clis.gemini.available,
                        isDetecting: false,
                        timestamp: Date.now(),
                    });
                    return;
                }

                // Use single bash command to check both CLIs efficiently
                // command -v is POSIX compliant and more reliable than which
                const result = await machineBash(
                    machineId,
                    '(command -v claude >/dev/null 2>&1 && echo "claude:true" || echo "claude:false") && ' +
                    '(command -v codex >/dev/null 2>&1 && echo "codex:true" || echo "codex:false") && ' +
                    '(command -v gemini >/dev/null 2>&1 && echo "gemini:true" || echo "gemini:false")',
                    '/'
                );

                if (cancelled) return;
                debugLog('[useCLIDetection] Result:', { success: result.success, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });

                if (result.success && result.exitCode === 0) {
                    // Parse output: "claude:true\ncodex:false\ngemini:false"
                    const lines = result.stdout.trim().split('\n');
                    const cliStatus: { claude?: boolean; codex?: boolean; gemini?: boolean } = {};

                    lines.forEach(line => {
                        const [cli, status] = line.split(':');
                        if (cli && status) {
                            cliStatus[cli.trim() as 'claude' | 'codex' | 'gemini'] = status.trim() === 'true';
                        }
                    });

                    debugLog('[useCLIDetection] Parsed CLI status:', cliStatus);
                    setAvailability({
                        claude: cliStatus.claude ?? null,
                        codex: cliStatus.codex ?? null,
                        gemini: cliStatus.gemini ?? null,
                        isDetecting: false,
                        timestamp: Date.now(),
                    });
                } else {
                    // Detection command failed - CONSERVATIVE fallback (don't assume availability)
                    debugLog('[useCLIDetection] Detection failed (success=false or exitCode!=0):', result);
                    setAvailability({
                        claude: null,
                        codex: null,
                        gemini: null,
                        isDetecting: false,
                        timestamp: 0,
                        error: `Detection failed: ${result.stderr || 'Unknown error'}`,
                    });
                }
            } catch (error) {
                if (cancelled) return;

                // Network/RPC error - CONSERVATIVE fallback (don't assume availability)
                debugLog('[useCLIDetection] Network/RPC error:', error);
                setAvailability({
                    claude: null,
                    codex: null,
                    gemini: null,
                    isDetecting: false,
                    timestamp: 0,
                    error: error instanceof Error ? error.message : 'Detection error',
                });
            }
        };

        detectCLIs();

        // Cleanup: Cancel detection if component unmounts or machineId changes
        return () => {
            cancelled = true;
        };
    }, [machineId]);

    return availability;
}
