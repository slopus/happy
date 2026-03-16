export const ORCHESTRATOR_V1_ENV_KEY = 'HAPPY_ORCHESTRATOR_V1';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isOrchestratorV1Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env[ORCHESTRATOR_V1_ENV_KEY];
    if (!raw) {
        return false;
    }
    return ENABLED_VALUES.has(raw.trim().toLowerCase());
}
