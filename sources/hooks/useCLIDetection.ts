import { useState, useEffect } from 'react';
import { machineBash } from '@/sync/ops';

interface CLIAvailability {
    claude: boolean | null; // null = unknown/loading, true = installed, false = not installed
    codex: boolean | null;
    isDetecting: boolean; // Explicit loading state
    timestamp: number; // When detection completed
    error?: string; // Detection error message (for debugging)
}

/**
 * Detects which CLI tools (claude, codex) are installed on a remote machine.
 *
 * NON-BLOCKING: Detection runs asynchronously in useEffect. UI shows all profiles
 * optimistically while detection is in progress, then updates when results arrive.
 *
 * Detection is automatic when machineId changes. Uses existing machineBash() RPC
 * to run `command -v claude` and `command -v codex` on the remote machine.
 *
 * OPTIMISTIC FALLBACK: If detection fails (network error, timeout, bash error),
 * assumes all CLIs are available. User discovers missing CLI only when spawn fails.
 *
 * @param machineId - The machine to detect CLIs on (null = no detection)
 * @returns CLI availability status for claude and codex
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
        isDetecting: false,
        timestamp: 0,
    });

    useEffect(() => {
        if (!machineId) {
            setAvailability({ claude: null, codex: null, isDetecting: false, timestamp: 0 });
            return;
        }

        let cancelled = false;

        const detectCLIs = async () => {
            // Set detecting flag (non-blocking - UI stays responsive)
            setAvailability(prev => ({ ...prev, isDetecting: true }));

            try {
                // Use single bash command to check both CLIs efficiently
                // command -v is POSIX compliant and more reliable than which
                const result = await machineBash(
                    machineId,
                    '(command -v claude >/dev/null 2>&1 && echo "claude:true" || echo "claude:false") && (command -v codex >/dev/null 2>&1 && echo "codex:true" || echo "codex:false")',
                    '/'
                );

                if (cancelled) return;

                if (result.success && result.exitCode === 0) {
                    // Parse output: "claude:true\ncodex:false"
                    const lines = result.stdout.trim().split('\n');
                    const cliStatus: { claude?: boolean; codex?: boolean } = {};

                    lines.forEach(line => {
                        const [cli, status] = line.split(':');
                        if (cli && status) {
                            cliStatus[cli.trim() as 'claude' | 'codex'] = status.trim() === 'true';
                        }
                    });

                    setAvailability({
                        claude: cliStatus.claude ?? null,
                        codex: cliStatus.codex ?? null,
                        isDetecting: false,
                        timestamp: Date.now(),
                    });
                } else {
                    // Detection command failed - optimistic fallback (assume available)
                    setAvailability({
                        claude: true,
                        codex: true,
                        isDetecting: false,
                        timestamp: Date.now(),
                        error: `Detection failed: ${result.stderr || 'Unknown error'}`,
                    });
                }
            } catch (error) {
                if (cancelled) return;

                // Network/RPC error - optimistic fallback (assume available)
                setAvailability({
                    claude: true,
                    codex: true,
                    isDetecting: false,
                    timestamp: Date.now(),
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
