/**
 * Expands ${VAR} references in environment variable values.
 *
 * CONTEXT:
 * Profiles can use ${VAR} syntax to reference daemon's environment:
 * Example: { ANTHROPIC_AUTH_TOKEN: "${Z_AI_AUTH_TOKEN}" }
 *
 * When daemon spawns sessions:
 * - Tmux mode: Shell automatically expands ${VAR}
 * - Non-tmux mode: Node.js spawn does NOT expand ${VAR}
 *
 * This utility ensures ${VAR} expansion works in both modes.
 *
 * @param envVars - Environment variables that may contain ${VAR} references
 * @param sourceEnv - Source environment (usually process.env) to resolve references from
 * @returns New object with all ${VAR} references expanded to actual values
 *
 * @example
 * ```typescript
 * const daemon_env = { Z_AI_AUTH_TOKEN: "sk-real-key" };
 * const profile_vars = { ANTHROPIC_AUTH_TOKEN: "${Z_AI_AUTH_TOKEN}" };
 *
 * const expanded = expandEnvironmentVariables(profile_vars, daemon_env);
 * // Result: { ANTHROPIC_AUTH_TOKEN: "sk-real-key" }
 * ```
 */
export function expandEnvironmentVariables(
    envVars: Record<string, string>,
    sourceEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
    const expanded: Record<string, string> = {};

    for (const [key, value] of Object.entries(envVars)) {
        // Replace all ${VAR} references with actual values from sourceEnv
        const expandedValue = value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
            const resolvedValue = sourceEnv[varName];
            if (resolvedValue === undefined) {
                // Variable not found in source environment - keep placeholder
                // This makes debugging easier (users see what's missing)
                return match;
            }
            return resolvedValue;
        });

        expanded[key] = expandedValue;
    }

    return expanded;
}
