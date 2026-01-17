import { logger } from '@/ui/logger';

/**
 * Expands ${VAR} references in environment variable values.
 *
 * CONTEXT:
 * Profiles can use ${VAR} syntax to reference daemon's environment:
 * Example: { ANTHROPIC_AUTH_TOKEN: "${Z_AI_AUTH_TOKEN}" }
 *
 * When daemon spawns sessions:
 * - Tmux mode: tmux launches a shell, but shells do not expand ${VAR} placeholders embedded inside env values automatically
 * - Non-tmux mode: Node.js spawn does NOT expand ${VAR} placeholders
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
    sourceEnv: NodeJS.ProcessEnv = process.env,
    options?: {
        warnOnUndefined?: boolean;
    }
): Record<string, string> {
    const expanded: Record<string, string> = {};
    const undefinedVars: string[] = [];
    const assignedEnv: Record<string, string> = {};

    function readEnv(varName: string): string | undefined {
        if (Object.prototype.hasOwnProperty.call(assignedEnv, varName)) {
            return assignedEnv[varName];
        }
        return sourceEnv[varName];
    }

    for (const [key, value] of Object.entries(envVars)) {
        // Replace all ${VAR}, ${VAR:-default}, and ${VAR:=default} references with actual values from sourceEnv
        const expandedValue = value.replace(/\$\{([^}]+)\}/g, (match, expr) => {
            // Support bash parameter expansion: ${VAR:-default} and ${VAR:=default}
            // Example: ${Z_AI_BASE_URL:-https://api.z.ai/api/anthropic}
            const colonDashIndex = expr.indexOf(':-');
            const colonEqIndex = expr.indexOf(':=');
            let varName: string;
            let defaultValue: string | undefined;
            let operator: ':-' | ':=' | null = null;

            if (colonDashIndex !== -1 || colonEqIndex !== -1) {
                // Split ${VAR:-default} or ${VAR:=default} into varName and defaultValue
                const idx = colonDashIndex !== -1 && (colonEqIndex === -1 || colonDashIndex < colonEqIndex)
                    ? colonDashIndex
                    : colonEqIndex;
                operator = idx === colonDashIndex ? ':-' : ':=';
                varName = expr.substring(0, idx);
                defaultValue = expr.substring(idx + 2);
            } else {
                // Simple ${VAR} reference
                varName = expr;
            }

            const resolvedValue = readEnv(varName);
            const shouldTreatEmptyAsMissing = defaultValue !== undefined;
            const isMissing = resolvedValue === undefined || (shouldTreatEmptyAsMissing && resolvedValue === '');

            if (!isMissing) {
                // Variable found in source environment - use its value
                if (process.env.DEBUG) {
                    logger.debug(`[EXPAND ENV] Expanded ${varName} from daemon env`);
                }

                // Warn if empty string (common mistake)
                if (resolvedValue === '' && !Object.prototype.hasOwnProperty.call(assignedEnv, varName)) {
                    logger.warn(`[EXPAND ENV] WARNING: ${varName} is set but EMPTY in daemon environment`);
                }

                return resolvedValue;
            } else if (defaultValue !== undefined) {
                // Variable not found but default value provided - use default
                if (process.env.DEBUG) {
                    logger.debug(`[EXPAND ENV] Using default value for ${varName}`);
                }
                if (operator === ':=') {
                    assignedEnv[varName] = defaultValue;
                }
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
    const warnOnUndefined = options?.warnOnUndefined ?? true;
    if (warnOnUndefined && undefinedVars.length > 0) {
        logger.warn(`[EXPAND ENV] Undefined variables referenced in profile environment: ${undefinedVars.join(', ')}`);
        logger.warn(`[EXPAND ENV] Session may fail to authenticate. Set these in daemon environment before launching:`);
        undefinedVars.forEach(varName => {
            logger.warn(`[EXPAND ENV]   ${varName}=<your-value>`);
        });
    }

    return expanded;
}
