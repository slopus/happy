import * as React from 'react';
import { Platform } from 'react-native';
import { applySecretRequirementResult, type SecretChoiceByProfileIdByEnvVarName } from '@/utils/secrets/secretRequirementApply';
import { shouldAutoPromptSecretRequirement } from '@/utils/secrets/secretRequirementPromptEligibility';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';
import { Modal } from '@/modal';
import { SecretRequirementModal, type SecretRequirementModalResult } from '@/components/secrets/requirements';
import type { AIBackendProfile, SavedSecret } from '@/sync/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/useMachineEnvPresence';
import { getTempData } from '@/utils/tempDataStore';

export function useSecretRequirementFlow(params: Readonly<{
    router: { push: (options: any) => void };
    navigation: any;
    useProfiles: boolean;
    selectedProfileId: string | null;
    selectedProfile: AIBackendProfile | null;
    setSelectedProfileId: (id: string | null) => void;
    shouldShowSecretSection: boolean;
    selectedMachineId: string | null;
    machineEnvPresence: UseMachineEnvPresenceResult;
    secrets: SavedSecret[];
    setSecrets: (secrets: SavedSecret[]) => void;
    secretBindingsByProfileId: Record<string, Record<string, string>>;
    setSecretBindingsByProfileId: (next: Record<string, Record<string, string>>) => void;
    selectedSecretIdByProfileIdByEnvVarName: SecretChoiceByProfileIdByEnvVarName;
    setSelectedSecretIdByProfileIdByEnvVarName: React.Dispatch<React.SetStateAction<SecretChoiceByProfileIdByEnvVarName>>;
    sessionOnlySecretValueByProfileIdByEnvVarName: SecretChoiceByProfileIdByEnvVarName;
    setSessionOnlySecretValueByProfileIdByEnvVarName: React.Dispatch<React.SetStateAction<SecretChoiceByProfileIdByEnvVarName>>;
    secretRequirementResultId: string | undefined;
    prevProfileIdBeforeSecretPromptRef: React.MutableRefObject<string | null>;
    lastSecretPromptKeyRef: React.MutableRefObject<string | null>;
    suppressNextSecretAutoPromptKeyRef: React.MutableRefObject<string | null>;
    isSecretRequirementModalOpenRef: React.MutableRefObject<boolean>;
}>): Readonly<{
    openSecretRequirementModal: (profile: AIBackendProfile, options: { revertOnCancel: boolean }) => void;
}> {
    const openSecretRequirementModal = React.useCallback((profile: AIBackendProfile, options: { revertOnCancel: boolean }) => {
        const selectedSecretIdByEnvVarName = params.selectedSecretIdByProfileIdByEnvVarName[profile.id] ?? {};
        const sessionOnlySecretValueByEnvVarName = params.sessionOnlySecretValueByProfileIdByEnvVarName[profile.id] ?? {};

        const satisfaction = getSecretSatisfaction({
            profile,
            secrets: params.secrets,
            defaultBindings: params.secretBindingsByProfileId[profile.id] ?? null,
            selectedSecretIds: selectedSecretIdByEnvVarName,
            sessionOnlyValues: sessionOnlySecretValueByEnvVarName,
            machineEnvReadyByName: Object.fromEntries(
                Object.entries(params.machineEnvPresence.meta ?? {}).map(([k, v]) => [k, Boolean(v?.isSet)]),
            ),
        });

        const targetEnvVarName =
            satisfaction.items.find((i) => i.required && !i.isSatisfied)?.envVarName ??
            satisfaction.items[0]?.envVarName ??
            null;
        if (!targetEnvVarName) {
            params.isSecretRequirementModalOpenRef.current = false;
            return;
        }
        params.isSecretRequirementModalOpenRef.current = true;

        if (Platform.OS !== 'web') {
            // On iOS, /new is presented as a navigation modal. Rendering portal-style overlays from the
            // app root (ModalProvider) can appear behind the navigation modal while still blocking touches.
            // Present the secret requirement UI as a navigation modal screen within the same stack instead.
            const secretEnvVarNames = satisfaction.items.map((i) => i.envVarName).filter(Boolean);
            params.router.push({
                pathname: '/new/pick/secret-requirement',
                params: {
                    profileId: profile.id,
                    machineId: params.selectedMachineId ?? '',
                    secretEnvVarName: targetEnvVarName,
                    secretEnvVarNames: secretEnvVarNames.join(','),
                    revertOnCancel: options.revertOnCancel ? '1' : '0',
                    selectedSecretIdByEnvVarName: encodeURIComponent(JSON.stringify(selectedSecretIdByEnvVarName)),
                },
            } as any);
            return;
        }

        const selectedRaw = selectedSecretIdByEnvVarName[targetEnvVarName];
        const selectedSavedSecretIdForProfile =
            typeof selectedRaw === 'string' && selectedRaw.length > 0 && selectedRaw !== ''
                ? selectedRaw
                : null;

        const handleResolve = (result: SecretRequirementModalResult) => {
            if (result.action === 'cancel') {
                params.isSecretRequirementModalOpenRef.current = false;
                // Always allow future prompts for this profile.
                params.lastSecretPromptKeyRef.current = null;
                params.suppressNextSecretAutoPromptKeyRef.current = null;
                if (options.revertOnCancel) {
                    const prev = params.prevProfileIdBeforeSecretPromptRef.current;
                    params.setSelectedProfileId(prev);
                }
                return;
            }

            params.isSecretRequirementModalOpenRef.current = false;

            if (result.action === 'useMachine') {
                params.setSelectedSecretIdByProfileIdByEnvVarName((prev) => ({
                    ...prev,
                    [profile.id]: {
                        ...(prev[profile.id] ?? {}),
                        [result.envVarName]: '',
                    },
                }));
                params.setSessionOnlySecretValueByProfileIdByEnvVarName((prev) => ({
                    ...prev,
                    [profile.id]: {
                        ...(prev[profile.id] ?? {}),
                        [result.envVarName]: null,
                    },
                }));
                return;
            }

            if (result.action === 'enterOnce') {
                params.setSelectedSecretIdByProfileIdByEnvVarName((prev) => ({
                    ...prev,
                    [profile.id]: {
                        ...(prev[profile.id] ?? {}),
                        [result.envVarName]: '',
                    },
                }));
                params.setSessionOnlySecretValueByProfileIdByEnvVarName((prev) => ({
                    ...prev,
                    [profile.id]: {
                        ...(prev[profile.id] ?? {}),
                        [result.envVarName]: result.value,
                    },
                }));
                return;
            }

            if (result.action === 'selectSaved') {
                params.setSessionOnlySecretValueByProfileIdByEnvVarName((prev) => ({
                    ...prev,
                    [profile.id]: {
                        ...(prev[profile.id] ?? {}),
                        [result.envVarName]: null,
                    },
                }));
                params.setSelectedSecretIdByProfileIdByEnvVarName((prev) => ({
                    ...prev,
                    [profile.id]: {
                        ...(prev[profile.id] ?? {}),
                        [result.envVarName]: result.secretId,
                    },
                }));
                if (result.setDefault) {
                    params.setSecretBindingsByProfileId({
                        ...params.secretBindingsByProfileId,
                        [profile.id]: {
                            ...(params.secretBindingsByProfileId[profile.id] ?? {}),
                            [result.envVarName]: result.secretId,
                        },
                    });
                }
            }
        };

        Modal.show({
            component: SecretRequirementModal,
            props: {
                profile,
                secretEnvVarName: targetEnvVarName,
                secretEnvVarNames: satisfaction.items.map((i) => i.envVarName),
                machineId: params.selectedMachineId ?? null,
                secrets: params.secrets,
                defaultSecretId: params.secretBindingsByProfileId[profile.id]?.[targetEnvVarName] ?? null,
                selectedSavedSecretId: selectedSavedSecretIdForProfile,
                selectedSecretIdByEnvVarName: selectedSecretIdByEnvVarName,
                sessionOnlySecretValueByEnvVarName: sessionOnlySecretValueByEnvVarName,
                defaultSecretIdByEnvVarName: params.secretBindingsByProfileId[profile.id] ?? null,
                onSetDefaultSecretId: (id) => {
                    if (!id) return;
                    params.setSecretBindingsByProfileId({
                        ...params.secretBindingsByProfileId,
                        [profile.id]: {
                            ...(params.secretBindingsByProfileId[profile.id] ?? {}),
                            [targetEnvVarName]: id,
                        },
                    });
                },
                onChangeSecrets: params.setSecrets,
                allowSessionOnly: true,
                onResolve: handleResolve,
                onRequestClose: () => handleResolve({ action: 'cancel' }),
            },
            closeOnBackdrop: true,
        });
    }, [
        params.machineEnvPresence.meta,
        params.secrets,
        params.secretBindingsByProfileId,
        params.selectedSecretIdByProfileIdByEnvVarName,
        params.selectedMachineId,
        params.selectedProfileId,
        params.sessionOnlySecretValueByProfileIdByEnvVarName,
        params.setSecretBindingsByProfileId,
        params.router,
    ]);

    // If a selected profile requires an API key and the key isn't available on the selected machine,
    // prompt immediately and revert selection on cancel (so the profile isn't "selected" without a key).
    React.useEffect(() => {
        const isEligible = shouldAutoPromptSecretRequirement({
            useProfiles: params.useProfiles,
            selectedProfileId: params.selectedProfileId,
            shouldShowSecretSection: params.shouldShowSecretSection,
            isModalOpen: params.isSecretRequirementModalOpenRef.current,
            machineEnvPresenceIsLoading: params.machineEnvPresence.isLoading,
            selectedMachineId: params.selectedMachineId,
        });
        if (!isEligible) return;

        const selectedSecretIdByEnvVarName = params.selectedProfileId
            ? (params.selectedSecretIdByProfileIdByEnvVarName[params.selectedProfileId] ?? {})
            : {};
        const sessionOnlySecretValueByEnvVarName = params.selectedProfileId
            ? (params.sessionOnlySecretValueByProfileIdByEnvVarName[params.selectedProfileId] ?? {})
            : {};

        const satisfaction = getSecretSatisfaction({
            profile: params.selectedProfile ?? null,
            secrets: params.secrets,
            defaultBindings: params.selectedProfileId ? (params.secretBindingsByProfileId[params.selectedProfileId] ?? null) : null,
            selectedSecretIds: selectedSecretIdByEnvVarName,
            sessionOnlyValues: sessionOnlySecretValueByEnvVarName,
            machineEnvReadyByName: Object.fromEntries(
                Object.entries(params.machineEnvPresence.meta ?? {}).map(([k, v]) => [k, Boolean(v?.isSet)]),
            ),
        });

        if (satisfaction.isSatisfied) {
            // Reset prompt key when requirements are satisfied so future selections can prompt again if needed.
            params.lastSecretPromptKeyRef.current = null;
            return;
        }

        const missing = satisfaction.items.find((i) => i.required && !i.isSatisfied) ?? null;
        const promptKey = `${params.selectedMachineId ?? 'no-machine'}:${params.selectedProfileId}:${missing?.envVarName ?? 'unknown'}`;
        if (params.suppressNextSecretAutoPromptKeyRef.current === promptKey) {
            // One-shot suppression (used when the user explicitly opened the modal via the badge).
            params.suppressNextSecretAutoPromptKeyRef.current = null;
            return;
        }
        if (params.lastSecretPromptKeyRef.current === promptKey) {
            return;
        }
        params.lastSecretPromptKeyRef.current = promptKey;
        if (!params.selectedProfile) {
            return;
        }
        openSecretRequirementModal(params.selectedProfile, { revertOnCancel: true });
    }, [
        params.secrets,
        params.secretBindingsByProfileId,
        params.machineEnvPresence.isLoading,
        params.machineEnvPresence.meta,
        openSecretRequirementModal,
        params.selectedSecretIdByProfileIdByEnvVarName,
        params.selectedMachineId,
        params.selectedProfileId,
        params.selectedProfile,
        params.sessionOnlySecretValueByProfileIdByEnvVarName,
        params.shouldShowSecretSection,
        params.suppressNextSecretAutoPromptKeyRef,
        params.useProfiles,
    ]);

    // Handle secret requirement results from the native modal route (value stored in-memory only).
    React.useEffect(() => {
        if (typeof params.secretRequirementResultId !== 'string' || params.secretRequirementResultId.length === 0) {
            return;
        }

        const entry = getTempData<{
            profileId: string;
            revertOnCancel: boolean;
            result: SecretRequirementModalResult;
        }>(params.secretRequirementResultId);

        // Always unlock the guard so follow-up prompts can show.
        params.isSecretRequirementModalOpenRef.current = false;

        if (!entry) {
            const setParams = (params.navigation as any)?.setParams;
            if (typeof setParams === 'function') {
                setParams({ secretRequirementResultId: undefined });
            } else {
                params.navigation.dispatch({
                    type: 'SET_PARAMS',
                    payload: { params: { secretRequirementResultId: undefined } },
                } as never);
            }
            return;
        }

        const result = entry?.result;
        if (result?.action === 'cancel') {
            // Allow future prompts for this profile.
            params.lastSecretPromptKeyRef.current = null;
            params.suppressNextSecretAutoPromptKeyRef.current = null;
            if (entry?.revertOnCancel) {
                const prev = params.prevProfileIdBeforeSecretPromptRef.current;
                params.setSelectedProfileId(prev);
            }
        } else if (result) {
            const profileId = entry.profileId;
            const applied = applySecretRequirementResult({
                profileId,
                result,
                selectedSecretIdByProfileIdByEnvVarName: params.selectedSecretIdByProfileIdByEnvVarName,
                sessionOnlySecretValueByProfileIdByEnvVarName: params.sessionOnlySecretValueByProfileIdByEnvVarName,
                secretBindingsByProfileId: params.secretBindingsByProfileId,
            });
            params.setSelectedSecretIdByProfileIdByEnvVarName(applied.nextSelectedSecretIdByProfileIdByEnvVarName);
            params.setSessionOnlySecretValueByProfileIdByEnvVarName(applied.nextSessionOnlySecretValueByProfileIdByEnvVarName);
            if (applied.nextSecretBindingsByProfileId !== params.secretBindingsByProfileId) {
                params.setSecretBindingsByProfileId(applied.nextSecretBindingsByProfileId);
            }
        }

        const setParams = (params.navigation as any)?.setParams;
        if (typeof setParams === 'function') {
            setParams({ secretRequirementResultId: undefined });
        } else {
            params.navigation.dispatch({
                type: 'SET_PARAMS',
                payload: { params: { secretRequirementResultId: undefined } },
            } as never);
        }
    }, [
        params.navigation,
        params.secretBindingsByProfileId,
        params.secretRequirementResultId,
        params.selectedSecretIdByProfileIdByEnvVarName,
        params.sessionOnlySecretValueByProfileIdByEnvVarName,
        params.setSecretBindingsByProfileId,
        params.setSelectedSecretIdByProfileIdByEnvVarName,
        params.setSessionOnlySecretValueByProfileIdByEnvVarName,
    ]);

    return { openSecretRequirementModal };
}
