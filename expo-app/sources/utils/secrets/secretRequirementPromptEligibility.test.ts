import { describe, expect, it } from 'vitest';
import { shouldAutoPromptSecretRequirement } from './secretRequirementPromptEligibility';

describe('shouldAutoPromptSecretRequirement', () => {
    it('does not require a selected machine (still enforces saved/once secrets)', () => {
        const decision = shouldAutoPromptSecretRequirement({
            useProfiles: true,
            selectedProfileId: 'p1',
            shouldShowSecretSection: true,
            isModalOpen: false,
            machineEnvPresenceIsLoading: false,
            selectedMachineId: null,
        });

        expect(decision).toBe(true);
    });
});

