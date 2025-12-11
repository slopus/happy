/**
 * Pure utility functions for environment variable handling
 * These functions are extracted to enable testing without React dependencies
 */

interface EnvironmentVariables {
    [varName: string]: string | null;
}

/**
 * Resolves ${VAR} substitution in a profile environment variable value.
 *
 * Profiles use ${VAR} syntax to reference daemon environment variables.
 * This function resolves those references to actual values, including
 * bash parameter expansion with default values.
 *
 * @param value - Raw value from profile (e.g., "${Z_AI_MODEL}" or "literal-value")
 * @param daemonEnv - Actual environment variables fetched from daemon
 * @returns Resolved value (string), null if substitution variable not set, or original value if not a substitution
 *
 * @example
 * // Substitution found and resolved
 * resolveEnvVarSubstitution('${Z_AI_MODEL}', { Z_AI_MODEL: 'GLM-4.6' }) // 'GLM-4.6'
 *
 * // Substitution with default, variable not set
 * resolveEnvVarSubstitution('${MISSING:-fallback}', {}) // 'fallback'
 *
 * // Not a substitution (literal value)
 * resolveEnvVarSubstitution('https://api.example.com', {}) // 'https://api.example.com'
 */
export function resolveEnvVarSubstitution(
    value: string,
    daemonEnv: EnvironmentVariables
): string | null {
    // Match ${VAR} or ${VAR:-default} or ${VAR:=default} (bash parameter expansion)
    // Group 1: Variable name (required)
    // Group 2: Default value (optional) - includes the :- or := prefix
    // Group 3: The actual default value without prefix (optional)
    const match = value.match(/^\$\{([A-Z_][A-Z0-9_]*)(:-(.*))?(:=(.*))?}$/);
    if (match) {
        const varName = match[1];
        const defaultValue = match[3] ?? match[5]; // :- default or := default

        const daemonValue = daemonEnv[varName];
        if (daemonValue !== undefined && daemonValue !== null) {
            return daemonValue;
        }
        // Variable not set - use default if provided
        if (defaultValue !== undefined) {
            return defaultValue;
        }
        return null;
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
        // Match ${VAR} or ${VAR:-default} or ${VAR:=default} (bash parameter expansion)
        // Only capture the variable name, not the default value
        const match = ev.value.match(/^\$\{([A-Z_][A-Z0-9_]*)(:-.*|:=.*)?\}$/);
        if (match) {
            // Variable name is already validated by regex pattern [A-Z_][A-Z0-9_]*
            refs.add(match[1]);
        }
    });
    return Array.from(refs);
}
