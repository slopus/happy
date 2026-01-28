import { logger } from '@/ui/logger';

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
    const undefinedVars: string[] = [];

    for (const [key, value] of Object.entries(envVars)) {
        // Replace all ${VAR} and ${VAR:-default} references with actual values from sourceEnv
        const expandedValue = value.replace(/\$\{([^}]+)\}/g, (match, expr) => {
            // Support bash parameter expansion: ${VAR:-default}
            // Example: ${Z_AI_BASE_URL:-https://api.z.ai/api/anthropic}
            const colonDashIndex = expr.indexOf(':-');
            let varName: string;
            let defaultValue: string | undefined;

            if (colonDashIndex !== -1) {
                // Split ${VAR:-default} into varName and defaultValue
                varName = expr.substring(0, colonDashIndex);
                defaultValue = expr.substring(colonDashIndex + 2);
            } else {
                // Simple ${VAR} reference
                varName = expr;
            }

            const resolvedValue = sourceEnv[varName];
            if (resolvedValue !== undefined) {
                // Variable found in source environment - use its value
                // Log for debugging (mask secret-looking values)
                const isSensitive = varName.toLowerCase().includes('token') ||
                                   varName.toLowerCase().includes('key') ||
                                   varName.toLowerCase().includes('secret');
                const displayValue = isSensitive
                    ? (resolvedValue ? `<${resolvedValue.length} chars>` : '<empty>')
                    : resolvedValue;
                logger.debug(`[EXPAND ENV] Expanded ${varName} from daemon env: ${displayValue}`);

                // Warn if empty string (common mistake)
                if (resolvedValue === '') {
                    logger.warn(`[EXPAND ENV] WARNING: ${varName} is set but EMPTY in daemon environment`);
                }

                return resolvedValue;
            } else if (defaultValue !== undefined) {
                // Variable not found but default value provided - use default
                logger.debug(`[EXPAND ENV] Using default value for ${varName}: ${defaultValue}`);
                return defaultValue;
            } else {
                // Variable not found and no default - keep placeholder and warn
                undefinedVars.push(varName);
                return match;
            }
        });

        expanded[key] = expandedValue;
    }

    // Log warning if any variables couldn't be resolved
    if (undefinedVars.length > 0) {
        logger.warn(`[EXPAND ENV] Undefined variables referenced in profile environment: ${undefinedVars.join(', ')}`);
        logger.warn(`[EXPAND ENV] Session may fail to authenticate. Set these in daemon environment before launching:`);
        undefinedVars.forEach(varName => {
            logger.warn(`[EXPAND ENV]   ${varName}=<your-value>`);
        });
    }

    return expanded;
}
