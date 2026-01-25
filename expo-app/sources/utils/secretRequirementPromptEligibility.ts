export type SecretRequirementAutoPromptEligibilityParams = Readonly<{
    useProfiles: boolean;
    selectedProfileId: string | null;
    shouldShowSecretSection: boolean;
    isModalOpen: boolean;
    machineEnvPresenceIsLoading: boolean;
    /**
     * Used for prompt-key generation. Not required for eligibility; can be null when no machine is selected.
     */
    selectedMachineId: string | null;
}>;

/**
 * Gate for auto-opening the Secret Requirement UI.
 *
 * IMPORTANT:
 * We intentionally do NOT require `selectedMachineId` here:
 * if there is no machine selected, users must still satisfy secrets via a saved secret or session-only value.
 */
export function shouldAutoPromptSecretRequirement(params: SecretRequirementAutoPromptEligibilityParams): boolean {
    if (!params.useProfiles) return false;
    if (!params.selectedProfileId) return false;
    if (!params.shouldShowSecretSection) return false;
    if (params.isModalOpen) return false;

    // When a machine IS selected, wait for env presence to settle so we don't spuriously prompt.
    if (params.selectedMachineId && params.machineEnvPresenceIsLoading) return false;

    return true;
}

