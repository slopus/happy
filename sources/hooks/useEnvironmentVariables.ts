import { useState, useEffect, useMemo } from 'react';
import { machineBash } from '@/sync/ops';

// Re-export pure utility functions from envVarUtils for backwards compatibility
export { resolveEnvVarSubstitution, extractEnvVarReferences } from './envVarUtils';

interface EnvironmentVariables {
    [varName: string]: string | null; // null = variable not set in daemon environment
}

interface UseEnvironmentVariablesResult {
    variables: EnvironmentVariables;
    isLoading: boolean;
}

/**
 * Queries environment variable values from the daemon's process environment.
 *
 * IMPORTANT: This queries the daemon's ACTUAL environment (where CLI runs),
 * NOT a new shell session. This ensures ${VAR} substitutions in profiles
 * resolve to the values the daemon was launched with.
 *
 * Performance: Batches multiple variables into a single machineBash() call
 * to minimize network round-trips.
 *
 * @param machineId - Machine to query (null = skip query, return empty result)
 * @param varNames - Array of variable names to fetch (e.g., ['Z_AI_MODEL', 'DEEPSEEK_BASE_URL'])
 * @returns Environment variable values and loading state
 *
 * @example
 * const { variables, isLoading } = useEnvironmentVariables(
 *     machineId,
 *     ['Z_AI_MODEL', 'Z_AI_BASE_URL']
 * );
 * const model = variables['Z_AI_MODEL']; // 'GLM-4.6' or null if not set
 */
export function useEnvironmentVariables(
    machineId: string | null,
    varNames: string[]
): UseEnvironmentVariablesResult {
    const [variables, setVariables] = useState<EnvironmentVariables>({});
    const [isLoading, setIsLoading] = useState(false);

    // Memoize sorted var names for stable dependency (avoid unnecessary re-queries)
    const sortedVarNames = useMemo(() => [...varNames].sort().join(','), [varNames]);

    useEffect(() => {
        // Early exit conditions
        if (!machineId || varNames.length === 0) {
            setVariables({});
            setIsLoading(false);
            return;
        }

        let cancelled = false;
        setIsLoading(true);

        const fetchVars = async () => {
            const results: EnvironmentVariables = {};

            // SECURITY: Validate all variable names to prevent bash injection
            // Only accept valid environment variable names: [A-Z_][A-Z0-9_]*
            const validVarNames = varNames.filter(name => /^[A-Z_][A-Z0-9_]*$/.test(name));

            if (validVarNames.length === 0) {
                // No valid variables to query
                setVariables({});
                setIsLoading(false);
                return;
            }

            // Query variables in a single machineBash() call.
            //
            // IMPORTANT: This runs inside the daemon process environment on the machine, because the
            // RPC handler executes commands using Node's `exec()` without overriding `env`.
            // That means this matches what `${VAR}` expansion uses when spawning sessions on the daemon
            // (see happy-cli: expandEnvironmentVariables(..., process.env)).
            // Prefer a JSON protocol (via `node`) to preserve newlines and distinguish unset vs empty.
            // Fallback to bash-only output if node isn't available.
            const nodeScript = [
                // node -e sets argv[1] to "-e", so args start at argv[2]
                "const keys = process.argv.slice(2);",
                "const out = {};",
                "for (const k of keys) {",
                "  out[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : null;",
                "}",
                "process.stdout.write(JSON.stringify(out));",
            ].join("");
            const jsonCommand = `node -e '${nodeScript.replace(/'/g, "'\\''")}' ${validVarNames.join(' ')}`;
            // Shell fallback uses `printenv` to distinguish unset vs empty via exit code.
            // Note: values containing newlines may not round-trip here; the node/JSON path preserves them.
            const shellFallback = [
                `for name in ${validVarNames.join(' ')}; do`,
                `if printenv "$name" >/dev/null 2>&1; then`,
                `printf "%s=%s\\n" "$name" "$(printenv "$name")";`,
                `else`,
                `printf "%s=__HAPPY_UNSET__\\n" "$name";`,
                `fi;`,
                `done`,
            ].join(' ');

            const command = `if command -v node >/dev/null 2>&1; then ${jsonCommand}; else ${shellFallback}; fi`;

            try {
                const result = await machineBash(machineId, command, '/');

                if (cancelled) return;

                if (result.success && result.exitCode === 0) {
                    const stdout = result.stdout;

                    // JSON protocol: {"VAR":"value","MISSING":null}
                    // Be resilient to any stray output (log lines, warnings) by extracting the last JSON object.
                    const trimmed = stdout.trim();
                    const firstBrace = trimmed.indexOf('{');
                    const lastBrace = trimmed.lastIndexOf('}');
                    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                        const jsonSlice = trimmed.slice(firstBrace, lastBrace + 1);
                        try {
                            const parsed = JSON.parse(jsonSlice) as Record<string, string | null>;
                            validVarNames.forEach((name) => {
                                results[name] = Object.prototype.hasOwnProperty.call(parsed, name) ? parsed[name] : null;
                            });
                        } catch {
                            // Fall through to line parser if JSON is malformed.
                        }
                    }

                    // Fallback line parser: "VAR=value" or "VAR=__HAPPY_UNSET__"
                    if (Object.keys(results).length === 0) {
                        // Do not trim each line: it can corrupt values with meaningful whitespace.
                        const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
                        lines.forEach((line) => {
                            // Ignore unrelated output (warnings, prompts, etc).
                            if (!/^[A-Z_][A-Z0-9_]*=/.test(line)) return;
                            const equalsIndex = line.indexOf('=');
                            if (equalsIndex !== -1) {
                                const name = line.substring(0, equalsIndex);
                                const value = line.substring(equalsIndex + 1);
                                results[name] = value === '__HAPPY_UNSET__' ? null : value;
                            }
                        });
                    }

                    // Ensure all requested variables have entries (even if missing from output)
                    validVarNames.forEach(name => {
                        if (!(name in results)) {
                            results[name] = null;
                        }
                    });
                } else {
                    // Bash command failed - mark all variables as not set
                    validVarNames.forEach(name => {
                        results[name] = null;
                    });
                }
            } catch (err) {
                if (cancelled) return;

                // RPC error (network, encryption, etc.) - mark all as not set
                validVarNames.forEach(name => {
                    results[name] = null;
                });
            }

            if (!cancelled) {
                setVariables(results);
                setIsLoading(false);
            }
        };

        fetchVars();

        // Cleanup: prevent state updates after unmount
        return () => {
            cancelled = true;
        };
    }, [machineId, sortedVarNames]);

    return { variables, isLoading };
}
