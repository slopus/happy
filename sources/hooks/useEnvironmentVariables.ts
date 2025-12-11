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
