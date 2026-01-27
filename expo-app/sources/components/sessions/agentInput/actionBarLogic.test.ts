import { describe, expect, it } from 'vitest';
import { getHasAnyAgentInputActions, shouldShowPathAndResumeRow } from './actionBarLogic';

describe('agentInput/actionBarLogic', () => {
    it('shows the path+resume row only in wrap mode', () => {
        expect(shouldShowPathAndResumeRow('wrap')).toBe(true);
        expect(shouldShowPathAndResumeRow('scroll')).toBe(false);
        expect(shouldShowPathAndResumeRow('collapsed')).toBe(false);
    });

    it('treats resume as an action (prevents collapsed menu from being empty)', () => {
        expect(getHasAnyAgentInputActions({
            showPermissionChip: false,
            hasProfile: false,
            hasEnvVars: false,
            hasAgent: false,
            hasMachine: false,
            hasPath: false,
            hasResume: true,
            hasFiles: false,
            hasStop: false,
        })).toBe(true);
    });

    it('returns false when there are no actions', () => {
        expect(getHasAnyAgentInputActions({
            showPermissionChip: false,
            hasProfile: false,
            hasEnvVars: false,
            hasAgent: false,
            hasMachine: false,
            hasPath: false,
            hasResume: false,
            hasFiles: false,
            hasStop: false,
        })).toBe(false);
    });
});

