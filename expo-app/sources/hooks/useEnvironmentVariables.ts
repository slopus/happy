import { useState, useEffect, useLayoutEffect, useMemo } from 'react';
import { machineBash, machinePreviewEnv, type EnvPreviewSecretsPolicy, type PreviewEnvValue } from '@/sync/ops';

// Re-export pure utility functions from envVarUtils for backwards compatibility
export { resolveEnvVarSubstitution, extractEnvVarReferences } from './envVarUtils';

const SECRET_NAME_REGEX = /TOKEN|KEY|SECRET|AUTH|PASS|PASSWORD|COOKIE/i;

interface EnvironmentVariables {
    [varName: string]: string | null; // null = variable not set in daemon environment
}

interface UseEnvironmentVariablesResult {
    variables: EnvironmentVariables;
    meta: Record<string, PreviewEnvValue>;
    policy: EnvPreviewSecretsPolicy | null;
    isPreviewEnvSupported: boolean;
    isLoading: boolean;
}

interface UseEnvironmentVariablesOptions {
    /**
     * When provided, the daemon will compute an effective spawn environment:
     * effective = { ...daemon.process.env, ...expand(extraEnv) }
     * This makes previews exactly match what sessions will receive.
     */
    extraEnv?: Record<string, string>;
    /**
     * Marks variables as sensitive (at minimum). The daemon may also treat vars as sensitive
     * based on name heuristics (TOKEN/KEY/etc).
     */
    sensitiveKeys?: string[];
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
    varNames: string[],
    options?: UseEnvironmentVariablesOptions
): UseEnvironmentVariablesResult {
    const [variables, setVariables] = useState<EnvironmentVariables>({});
    const [meta, setMeta] = useState<Record<string, PreviewEnvValue>>({});
    const [policy, setPolicy] = useState<EnvPreviewSecretsPolicy | null>(null);
    const [isPreviewEnvSupported, setIsPreviewEnvSupported] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    // Memoize sorted var names for stable dependency (avoid unnecessary re-queries)
    const sortedVarNames = useMemo(() => [...varNames].sort().join(','), [varNames]);
    const extraEnvKey = useMemo(() => {
        const entries = Object.entries(options?.extraEnv ?? {}).sort(([a], [b]) => a.localeCompare(b));
        return JSON.stringify(entries);
    }, [options?.extraEnv]);
    const sensitiveKeysKey = useMemo(() => {
        const entries = [...(options?.sensitiveKeys ?? [])].sort((a, b) => a.localeCompare(b));
        return JSON.stringify(entries);
    }, [options?.sensitiveKeys]);

    // IMPORTANT:
    // We intentionally use a layout effect so `isLoading` flips to true before any consumer `useEffect`
    // (e.g. auto-prompt logic) can run in the same commit. This prevents a race where:
    // - consumer sees `isLoading=false` (initial) + `isSet=false` (initial)
    // - and incorrectly treats the requirement as "missing" before the preflight check begins.
    const useSafeLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

    useSafeLayoutEffect(() => {
        // Early exit conditions
        if (!machineId || varNames.length === 0) {
            setVariables({});
            setMeta({});
            setPolicy(null);
            setIsPreviewEnvSupported(false);
            setIsLoading(false);
            return;
        }

        let cancelled = false;
        setIsLoading(true);

        const fetchVars = async () => {
            const results: EnvironmentVariables = {};
            const metaResults: Record<string, PreviewEnvValue> = {};

            // SECURITY: Validate all variable names to prevent bash injection
            // Only accept valid environment variable names: [A-Z_][A-Z0-9_]*
            const validVarNames = varNames.filter(name => /^[A-Z_][A-Z0-9_]*$/.test(name));

            if (validVarNames.length === 0) {
                // No valid variables to query
                setVariables({});
                setMeta({});
                setPolicy(null);
                setIsPreviewEnvSupported(false);
                setIsLoading(false);
                return;
            }

            // Prefer daemon-native env preview if supported (more accurate + supports secret policy).
            const preview = await machinePreviewEnv(machineId, {
                keys: validVarNames,
                extraEnv: options?.extraEnv,
                sensitiveKeys: options?.sensitiveKeys,
            });

            if (cancelled) return;

            if (preview.supported) {
                const response = preview.response;
                validVarNames.forEach((name) => {
                    const entry = response.values[name];
                    if (entry) {
                        metaResults[name] = entry;
                        results[name] = entry.value;
                    } else {
                        // Defensive fallback: treat as unset.
                        metaResults[name] = {
                            value: null,
                            isSet: false,
                            isSensitive: false,
                            isForcedSensitive: false,
                            sensitivitySource: 'none',
                            display: 'unset',
                        };
                        results[name] = null;
                    }
                });

                if (!cancelled) {
                    setVariables(results);
                    setMeta(metaResults);
                    setPolicy(response.policy);
                    setIsPreviewEnvSupported(true);
                    setIsLoading(false);
                }
                return;
            }

            // Fallback (older daemon): use bash probing for non-sensitive variables only.
            // Never fetch secret-like values into UI memory via bash.
            const sensitiveKeysSet = new Set(options?.sensitiveKeys ?? []);
            const safeVarNames = validVarNames.filter((name) => !SECRET_NAME_REGEX.test(name) && !sensitiveKeysSet.has(name));

            // Mark excluded keys as hidden (conservative).
            validVarNames.forEach((name) => {
                if (safeVarNames.includes(name)) return;
                const isForcedSensitive = SECRET_NAME_REGEX.test(name);
                metaResults[name] = {
                    value: null,
                    isSet: true,
                    isSensitive: true,
                    isForcedSensitive,
                    sensitivitySource: isForcedSensitive ? 'forced' : 'hinted',
                    display: 'hidden',
                };
                results[name] = null;
            });

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
            const jsonCommand = `node -e '${nodeScript.replace(/'/g, "'\\''")}' ${safeVarNames.join(' ')}`;
            // Shell fallback uses `printenv` to distinguish unset vs empty via exit code.
            // Note: values containing newlines may not round-trip here; the node/JSON path preserves them.
            const shellFallback = [
                `for name in ${safeVarNames.join(' ')}; do`,
                `if printenv "$name" >/dev/null 2>&1; then`,
                `printf "%s=%s\\n" "$name" "$(printenv "$name")";`,
                `else`,
                `printf "%s=__HAPPY_UNSET__\\n" "$name";`,
                `fi;`,
                `done`,
            ].join(' ');

            const command = `if command -v node >/dev/null 2>&1; then ${jsonCommand}; else ${shellFallback}; fi`;

            try {
                if (safeVarNames.length === 0) {
                    if (!cancelled) {
                        setVariables(results);
                        setMeta(metaResults);
                        setPolicy(null);
                        setIsPreviewEnvSupported(false);
                        setIsLoading(false);
                    }
                    return;
                }

                const result = await machineBash(machineId, command, '/');

                if (cancelled) return;

                if (result.success && result.exitCode === 0) {
                    const stdout = result.stdout;

                    // JSON protocol: {"VAR":"value","MISSING":null}
                    // Be resilient to any stray output (log lines, warnings) by extracting the last JSON object.
                    let parsedJson = false;
                    const trimmed = stdout.trim();
                    const firstBrace = trimmed.indexOf('{');
                    const lastBrace = trimmed.lastIndexOf('}');
                    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                        const jsonSlice = trimmed.slice(firstBrace, lastBrace + 1);
                        try {
                            const parsed = JSON.parse(jsonSlice) as Record<string, string | null>;
                            safeVarNames.forEach((name) => {
                                results[name] = Object.prototype.hasOwnProperty.call(parsed, name) ? parsed[name] : null;
                            });
                            parsedJson = true;
                        } catch {
                            // Fall through to line parser if JSON is malformed.
                        }
                    }

                    // Fallback line parser: "VAR=value" or "VAR=__HAPPY_UNSET__"
                    if (!parsedJson) {
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
                    safeVarNames.forEach(name => {
                        if (!(name in results)) {
                            results[name] = null;
                        }
                    });
                } else {
                    // Bash command failed - mark all variables as not set
                    safeVarNames.forEach(name => {
                        results[name] = null;
                    });
                }
            } catch (err) {
                if (cancelled) return;

                // RPC error (network, encryption, etc.) - mark all as not set
                safeVarNames.forEach(name => {
                    results[name] = null;
                });
            }

            if (!cancelled) {
                safeVarNames.forEach((name) => {
                    const value = results[name];
                    metaResults[name] = {
                        value,
                        isSet: value !== null,
                        isSensitive: false,
                        isForcedSensitive: false,
                        sensitivitySource: 'none',
                        display: value === null ? 'unset' : 'full',
                    };
                });
                setVariables(results);
                setMeta(metaResults);
                setPolicy(null);
                setIsPreviewEnvSupported(false);
                setIsLoading(false);
            }
        };

        fetchVars();

        // Cleanup: prevent state updates after unmount
        return () => {
            cancelled = true;
        };
    }, [extraEnvKey, machineId, sensitiveKeysKey, sortedVarNames]);

    return { variables, meta, policy, isPreviewEnvSupported, isLoading };
}
