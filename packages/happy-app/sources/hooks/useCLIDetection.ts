import { useState, useEffect } from 'react';
import { useMachine } from '@/sync/storage';
import { machineBash } from '@/sync/ops';

interface CLIAvailability {
    claude: boolean | null; // null = unknown/loading, true = installed, false = not installed
    codex: boolean | null;
    gemini: boolean | null;
    openclaw: boolean | null;
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
 * Detection is automatic when machineId changes. Uses existing machineBash() RPC
 * to run `command -v` checks on the remote machine.
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
    const machine = useMachine(machineId ?? '');
    const platform = machine?.metadata?.platform;
    const [availability, setAvailability] = useState<CLIAvailability>({
        claude: null,
        codex: null,
        gemini: null,
        openclaw: null,
        isDetecting: false,
        timestamp: 0,
    });

    useEffect(() => {
        if (!machineId) {
            setAvailability({ claude: null, codex: null, gemini: null, openclaw: null, isDetecting: false, timestamp: 0 });
            return;
        }

        let cancelled = false;

        const detectCLIs = async () => {
            // Set detecting flag (non-blocking - UI stays responsive)
            setAvailability(prev => ({ ...prev, isDetecting: true }));
            console.log('[useCLIDetection] Starting detection for machineId:', machineId);

            try {
                const isWindows = platform === 'win32';
                // Use a single command to check all CLIs efficiently.
                // On Windows, use PowerShell; elsewhere, use POSIX sh.
                const openClawPosixCheck = '(command -v openclaw >/dev/null 2>&1 || [ -f "$HOME/.openclaw/openclaw.json" ] || [ -n "$OPENCLAW_GATEWAY_URL" ]) && echo "openclaw:true" || echo "openclaw:false"';
                const posixCommand = [
                    '(command -v claude >/dev/null 2>&1 && echo "claude:true" || echo "claude:false")',
                    '(command -v codex >/dev/null 2>&1 && echo "codex:true" || echo "codex:false")',
                    '(command -v gemini >/dev/null 2>&1 && echo "gemini:true" || echo "gemini:false")',
                    openClawPosixCheck,
                ].join(' && ');

                const psCommand = [
                    "$ErrorActionPreference='SilentlyContinue'",
                    "if (Get-Command claude) { 'claude:true' } else { 'claude:false' }",
                    "if (Get-Command codex) { 'codex:true' } else { 'codex:false' }",
                    "if (Get-Command gemini) { 'gemini:true' } else { 'gemini:false' }",
                    "$openclawConfig = Join-Path $env:USERPROFILE '.openclaw\\openclaw.json'",
                    "if ((Get-Command openclaw) -or (Test-Path $openclawConfig) -or $env:OPENCLAW_GATEWAY_URL) { 'openclaw:true' } else { 'openclaw:false' }",
                ].join('; ');
                const command = isWindows ? `powershell -NoProfile -Command "${psCommand}"` : posixCommand;

                const result = await machineBash(
                    machineId,
                    command,
                    '/'
                );

                if (cancelled) return;
                console.log('[useCLIDetection] Result:', { success: result.success, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });

                if (result.success && result.exitCode === 0) {
                    // Parse output: "claude:true\ncodex:false\ngemini:false"
                    const lines = result.stdout.trim().split('\n');
                    const cliStatus: { claude?: boolean; codex?: boolean; gemini?: boolean; openclaw?: boolean } = {};

                    lines.forEach(line => {
                        const [cli, status] = line.split(':');
                        if (cli && status) {
                            cliStatus[cli.trim() as 'claude' | 'codex' | 'gemini' | 'openclaw'] = status.trim() === 'true';
                        }
                    });

                    console.log('[useCLIDetection] Parsed CLI status:', cliStatus);
                    setAvailability({
                        claude: cliStatus.claude ?? null,
                        codex: cliStatus.codex ?? null,
                        gemini: cliStatus.gemini ?? null,
                        openclaw: cliStatus.openclaw ?? null,
                        isDetecting: false,
                        timestamp: Date.now(),
                    });
                } else {
                    // Detection command failed - CONSERVATIVE fallback (don't assume availability)
                    console.log('[useCLIDetection] Detection failed (success=false or exitCode!=0):', result);
                    setAvailability({
                        claude: null,
                        codex: null,
                        gemini: null,
                        openclaw: null,
                        isDetecting: false,
                        timestamp: 0,
                        error: `Detection failed: ${result.stderr || 'Unknown error'}`,
                    });
                }
            } catch (error) {
                if (cancelled) return;

                // Network/RPC error - CONSERVATIVE fallback (don't assume availability)
                console.log('[useCLIDetection] Network/RPC error:', error);
                setAvailability({
                    claude: null,
                    codex: null,
                    gemini: null,
                    openclaw: null,
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
    }, [machineId, platform]);

    return availability;
}
