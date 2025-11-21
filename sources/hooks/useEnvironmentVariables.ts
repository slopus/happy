import { useState, useEffect, useMemo } from 'react';
import { machineBash } from '@/sync/ops';

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

            // Build batched command: query all variables in single bash invocation
            // Format: echo "VAR1=$VAR1" && echo "VAR2=$VAR2" && ...
            // Using echo with variable expansion ensures we get daemon's environment
            const command = validVarNames
                .map(name => `echo "${name}=$${name}"`)
                .join(' && ');

            try {
                const result = await machineBash(machineId, command, '/');

                if (cancelled) return;

                if (result.success && result.exitCode === 0) {
                    // Parse output: "VAR1=value1\nVAR2=value2\nVAR3="
                    const lines = result.stdout.trim().split('\n');
                    lines.forEach(line => {
                        const equalsIndex = line.indexOf('=');
                        if (equalsIndex !== -1) {
                            const name = line.substring(0, equalsIndex);
                            const value = line.substring(equalsIndex + 1);
                            results[name] = value || null; // Empty string → null (not set)
                        }
                    });

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

/**
 * Resolves ${VAR} substitution in a profile environment variable value.
 *
 * Profiles use ${VAR} syntax to reference daemon environment variables.
 * This function resolves those references to actual values.
 *
 * @param value - Raw value from profile (e.g., "${Z_AI_MODEL}" or "literal-value")
 * @param daemonEnv - Actual environment variables fetched from daemon
 * @returns Resolved value (string), null if substitution variable not set, or original value if not a substitution
 *
 * @example
 * // Substitution found and resolved
 * resolveEnvVarSubstitution('${Z_AI_MODEL}', { Z_AI_MODEL: 'GLM-4.6' }) // 'GLM-4.6'
 *
 * // Substitution not found
 * resolveEnvVarSubstitution('${MISSING_VAR}', {}) // null
 *
 * // Not a substitution (literal value)
 * resolveEnvVarSubstitution('https://api.example.com', {}) // 'https://api.example.com'
 */
export function resolveEnvVarSubstitution(
    value: string,
    daemonEnv: EnvironmentVariables
): string | null {
    const match = value.match(/^\$\{(.+)\}$/);
    if (match) {
        // This is a substitution like ${VAR}
        const varName = match[1];
        return daemonEnv[varName] !== undefined ? daemonEnv[varName] : null;
    }
    // Not a substitution - return literal value
    return value;
}

/**
 * Extracts all ${VAR} references from a profile's environment variables array.
 * Used to determine which daemon environment variables need to be queried.
 *
 * @param environmentVariables - Profile's environmentVariables array from AIBackendProfile
 * @returns Array of unique variable names that are referenced (e.g., ['Z_AI_MODEL', 'Z_AI_BASE_URL'])
 *
 * @example
 * extractEnvVarReferences([
 *   { name: 'ANTHROPIC_BASE_URL', value: '${Z_AI_BASE_URL}' },
 *   { name: 'ANTHROPIC_MODEL', value: '${Z_AI_MODEL}' },
 *   { name: 'API_TIMEOUT_MS', value: '600000' } // Literal, not extracted
 * ]) // Returns: ['Z_AI_BASE_URL', 'Z_AI_MODEL']
 */
export function extractEnvVarReferences(
    environmentVariables: { name: string; value: string }[] | undefined
): string[] {
    if (!environmentVariables) return [];

    const refs = new Set<string>();
    environmentVariables.forEach(ev => {
        const match = ev.value.match(/^\$\{(.+)\}$/);
        if (match) {
            const varName = match[1];
            // SECURITY: Only accept valid environment variable names to prevent bash injection
            // Valid format: [A-Z_][A-Z0-9_]* (uppercase letters, numbers, underscores)
            if (/^[A-Z_][A-Z0-9_]*$/.test(varName)) {
                refs.add(varName);
            }
        }
    });
    return Array.from(refs);
}
