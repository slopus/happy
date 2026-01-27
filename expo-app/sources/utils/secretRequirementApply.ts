import type { SecretRequirementModalResult } from '@/components/secrets/requirements';

export type SecretChoiceByProfileIdByEnvVarName = Record<string, Record<string, string | null>>;

export type SecretBindingsByProfileId = Record<string, Record<string, string>>;

export type ApplySecretRequirementResultInput = Readonly<{
    profileId: string;
    result: SecretRequirementModalResult;
    selectedSecretIdByProfileIdByEnvVarName: SecretChoiceByProfileIdByEnvVarName;
    sessionOnlySecretValueByProfileIdByEnvVarName: SecretChoiceByProfileIdByEnvVarName;
    secretBindingsByProfileId: SecretBindingsByProfileId;
}>;

export type ApplySecretRequirementResultOutput = Readonly<{
    nextSelectedSecretIdByProfileIdByEnvVarName: SecretChoiceByProfileIdByEnvVarName;
    nextSessionOnlySecretValueByProfileIdByEnvVarName: SecretChoiceByProfileIdByEnvVarName;
    nextSecretBindingsByProfileId: SecretBindingsByProfileId;
}>;

export function applySecretRequirementResult(
    input: ApplySecretRequirementResultInput,
): ApplySecretRequirementResultOutput {
    const { profileId, result } = input;

    const nextSelected: SecretChoiceByProfileIdByEnvVarName = { ...input.selectedSecretIdByProfileIdByEnvVarName };
    const nextSessionOnly: SecretChoiceByProfileIdByEnvVarName = { ...input.sessionOnlySecretValueByProfileIdByEnvVarName };
    let nextBindings: SecretBindingsByProfileId = input.secretBindingsByProfileId;

    const ensureProfileMap = (map: SecretChoiceByProfileIdByEnvVarName) => {
        const existing = map[profileId] ?? {};
        const copy = { ...existing };
        map[profileId] = copy;
        return copy;
    };

    if (result.action === 'useMachine') {
        const selected = ensureProfileMap(nextSelected);
        selected[result.envVarName] = '';

        const sessionOnly = ensureProfileMap(nextSessionOnly);
        sessionOnly[result.envVarName] = null;
    } else if (result.action === 'enterOnce') {
        const selected = ensureProfileMap(nextSelected);
        selected[result.envVarName] = '';

        const sessionOnly = ensureProfileMap(nextSessionOnly);
        sessionOnly[result.envVarName] = result.value;
    } else if (result.action === 'selectSaved') {
        const selected = ensureProfileMap(nextSelected);
        selected[result.envVarName] = result.secretId;

        const sessionOnly = ensureProfileMap(nextSessionOnly);
        sessionOnly[result.envVarName] = null;

        if (result.setDefault) {
            nextBindings = { ...nextBindings };
            nextBindings[profileId] = {
                ...(nextBindings[profileId] ?? {}),
                [result.envVarName]: result.secretId,
            };
        }
    }

    return {
        nextSelectedSecretIdByProfileIdByEnvVarName: nextSelected,
        nextSessionOnlySecretValueByProfileIdByEnvVarName: nextSessionOnly,
        nextSecretBindingsByProfileId: nextBindings,
    };
}
