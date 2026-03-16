import { describe, expect, it } from 'vitest';
import { isOrchestratorV1Enabled } from './featureFlag';

describe('orchestrator feature flag', () => {
    it('is disabled by default', () => {
        expect(isOrchestratorV1Enabled({} as NodeJS.ProcessEnv)).toBe(false);
    });

    it('accepts common truthy values', () => {
        expect(isOrchestratorV1Enabled({ HAPPY_ORCHESTRATOR_V1: '1' } as NodeJS.ProcessEnv)).toBe(true);
        expect(isOrchestratorV1Enabled({ HAPPY_ORCHESTRATOR_V1: 'true' } as NodeJS.ProcessEnv)).toBe(true);
        expect(isOrchestratorV1Enabled({ HAPPY_ORCHESTRATOR_V1: 'YES' } as NodeJS.ProcessEnv)).toBe(true);
    });

    it('treats other values as disabled', () => {
        expect(isOrchestratorV1Enabled({ HAPPY_ORCHESTRATOR_V1: '0' } as NodeJS.ProcessEnv)).toBe(false);
        expect(isOrchestratorV1Enabled({ HAPPY_ORCHESTRATOR_V1: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    });
});
