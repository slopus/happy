import * as React from 'react';

import { t } from '@/text';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { storage } from '@/sync/storage';
import { machineSpawnNewSession } from '@/sync/ops';
import { resolveTerminalSpawnOptions } from '@/sync/terminalSettings';
import { createWorktree } from '@/utils/createWorktree';
import { getMissingRequiredConfigEnvVarNames } from '@/utils/profiles/profileConfigRequirements';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';
import type { SecretChoiceByProfileIdByEnvVarName } from '@/utils/secrets/secretRequirementApply';
import { clearNewSessionDraft } from '@/sync/persistence';
import { getBuiltInProfile } from '@/sync/profileUtils';
import type { AIBackendProfile, SavedSecret, Settings } from '@/sync/settings';
import { getAgentCore, type AgentId } from '@/agents/catalog';
import { buildResumeCapabilityOptionsFromUiState, buildSpawnEnvironmentVariablesFromUiState, buildSpawnSessionExtrasFromUiState, getAgentResumeExperimentsFromSettings, getNewSessionPreflightIssues, getResumeRuntimeSupportPrefetchPlan } from '@/agents/catalog';
import { describeAcpLoadSessionSupport } from '@/agents/acpRuntimeResume';
import { canAgentResume } from '@/agents/resumeCapabilities';
import { formatResumeSupportDetailCode } from '@/components/sessions/new/modules/formatResumeSupportDetailCode';
import { transformProfileToEnvironmentVars } from '@/components/sessions/new/modules/profileHelpers';
import type { UseMachineEnvPresenceResult } from '@/hooks/useMachineEnvPresence';
import { getMachineCapabilitiesSnapshot, prefetchMachineCapabilities } from '@/hooks/useMachineCapabilitiesCache';
import type { PermissionMode, ModelMode } from '@/sync/permissionTypes';
import { SPAWN_SESSION_ERROR_CODES } from '@happy/protocol';

export function useCreateNewSession(params: Readonly<{
    router: { push: (options: any) => void; replace: (path: any, options?: any) => void };

    selectedMachineId: string | null;
    selectedPath: string;
    selectedMachine: any;

    setIsCreating: (v: boolean) => void;
    setIsResumeSupportChecking: (v: boolean) => void;

    sessionType: 'simple' | 'worktree';
    settings: Settings;
    useProfiles: boolean;
    selectedProfileId: string | null;
    profileMap: Map<string, AIBackendProfile>;

    recentMachinePaths: Array<{ machineId: string; path: string }>;

    agentType: AgentId;
    permissionMode: PermissionMode;
    modelMode: ModelMode;

    sessionPrompt: string;
    resumeSessionId: string;
    agentNewSessionOptions?: Record<string, unknown> | null;

    machineEnvPresence: UseMachineEnvPresenceResult;
    secrets: SavedSecret[];
    secretBindingsByProfileId: Record<string, Record<string, string>>;
    selectedSecretIdByProfileIdByEnvVarName: SecretChoiceByProfileIdByEnvVarName;
    sessionOnlySecretValueByProfileIdByEnvVarName: SecretChoiceByProfileIdByEnvVarName;

    selectedMachineCapabilities: any;
}>): Readonly<{
    handleCreateSession: () => void;
}> {
    const handleCreateSession = React.useCallback(async () => {
            if (!params.selectedMachineId) {
                Modal.alert(t('common.error'), t('newSession.noMachineSelected'));
                return;
            }
        if (!params.selectedPath) {
            Modal.alert(t('common.error'), t('newSession.noPathSelected'));
            return;
        }

        params.setIsCreating(true);

        try {
            let actualPath = params.selectedPath;

            // Handle worktree creation
            if (params.sessionType === 'worktree' && params.settings.experiments === true) {
                const worktreeResult = await createWorktree(params.selectedMachineId, params.selectedPath);

                if (!worktreeResult.success) {
                    if (worktreeResult.error === 'Not a Git repository') {
                        Modal.alert(t('common.error'), t('newSession.worktree.notGitRepo'));
                    } else {
                        Modal.alert(t('common.error'), t('newSession.worktree.failed', { error: worktreeResult.error || 'Unknown error' }));
                    }
                    params.setIsCreating(false);
                    return;
                }

                actualPath = worktreeResult.worktreePath;
            }

            // Save settings
            const updatedPaths = [{ machineId: params.selectedMachineId, path: params.selectedPath }, ...params.recentMachinePaths.filter(rp => rp.machineId !== params.selectedMachineId)].slice(0, 10);
            const profilesActive = params.useProfiles;

            // Keep prod session creation behavior unchanged:
            // only persist/apply profiles & model when an explicit opt-in flag is enabled.
            const settingsUpdate: Parameters<typeof sync.applySettings>[0] = {
                recentMachinePaths: updatedPaths,
                lastUsedAgent: params.agentType,
                lastUsedPermissionMode: params.permissionMode,
            };
            if (profilesActive) {
                settingsUpdate.lastUsedProfile = params.selectedProfileId;
            }
            sync.applySettings(settingsUpdate);

            // Get environment variables from selected profile
            let environmentVariables = undefined;
            if (profilesActive && params.selectedProfileId) {
                const selectedProfile = params.profileMap.get(params.selectedProfileId) || getBuiltInProfile(params.selectedProfileId);
                if (selectedProfile) {
                    environmentVariables = transformProfileToEnvironmentVars(selectedProfile);

                    // Spawn-time secret injection overlay (saved key / session-only key)
                    const selectedSecretIdByEnvVarName = params.selectedSecretIdByProfileIdByEnvVarName[params.selectedProfileId] ?? {};
                    const sessionOnlySecretValueByEnvVarName = params.sessionOnlySecretValueByProfileIdByEnvVarName[params.selectedProfileId] ?? {};
                    const machineEnvReadyByName = Object.fromEntries(
                        Object.entries(params.machineEnvPresence.meta ?? {}).map(([k, v]) => [k, Boolean(v?.isSet)]),
                    );

                    if (params.machineEnvPresence.isPreviewEnvSupported && !params.machineEnvPresence.isLoading) {
                        const missingConfig = getMissingRequiredConfigEnvVarNames(selectedProfile, machineEnvReadyByName);
                        if (missingConfig.length > 0) {
                            Modal.alert(
                                t('common.error'),
                                t('profiles.requirements.missingConfigForProfile', { env: missingConfig.join(', ') })
                            );
                            params.setIsCreating(false);
                            return;
                        }
                    }

                    const satisfaction = getSecretSatisfaction({
                        profile: selectedProfile,
                        secrets: params.secrets,
                        defaultBindings: params.secretBindingsByProfileId[params.selectedProfileId] ?? null,
                        selectedSecretIds: selectedSecretIdByEnvVarName,
                        sessionOnlyValues: sessionOnlySecretValueByEnvVarName,
                        machineEnvReadyByName,
                    });

                    if (!satisfaction.isSatisfied) {
                        // If not satisfied, prompt the user to resolve secrets.
                        // Note: The wizard already encourages resolving before creating; this is a last-resort guard.
                        Modal.alert(t('common.error'), t('profiles.requirements.modalBody'));
                        params.setIsCreating(false);
                        return;
                    }

                    // Inject any secrets that were satisfied via saved key or session-only.
                    // Machine-env satisfied secrets are not injected (daemon will resolve from its env).
                    for (const item of satisfaction.items) {
                        if (!item.isSatisfied) continue;
                        let injected: string | null = null;

                        if (item.satisfiedBy === 'sessionOnly') {
                            injected = sessionOnlySecretValueByEnvVarName[item.envVarName] ?? null;
                        } else if (
                            item.satisfiedBy === 'selectedSaved' ||
                            item.satisfiedBy === 'rememberedSaved' ||
                            item.satisfiedBy === 'defaultSaved'
                        ) {
                            const id = item.savedSecretId;
                            const secret = id ? (params.secrets.find((k) => k.id === id) ?? null) : null;
                            injected = sync.decryptSecretValue(secret?.encryptedValue ?? null);
                        }

                        if (typeof injected === 'string' && injected.length > 0) {
                            environmentVariables = {
                                ...environmentVariables,
                                [item.envVarName]: injected,
                            };
                        }
                    }
                }
            }

            environmentVariables = buildSpawnEnvironmentVariablesFromUiState({
                agentId: params.agentType,
                environmentVariables,
                newSessionOptions: params.agentNewSessionOptions,
            });

            const terminal = resolveTerminalSpawnOptions({
                settings: storage.getState().settings,
                machineId: params.selectedMachineId,
            });

            const machineCapsSnapshot = getMachineCapabilitiesSnapshot(params.selectedMachineId);
            const machineCapsResults = machineCapsSnapshot?.response.results as any;
            const experiments = getAgentResumeExperimentsFromSettings(params.agentType, params.settings);
            const preflightIssues = getNewSessionPreflightIssues({
                agentId: params.agentType,
                experiments,
                resumeSessionId: params.resumeSessionId,
                results: machineCapsResults,
            });
            const blockingIssue = preflightIssues[0] ?? null;
            if (blockingIssue) {
                const openMachine = await Modal.confirm(
                    t(blockingIssue.titleKey),
                    t(blockingIssue.messageKey),
                    { confirmText: t(blockingIssue.confirmTextKey) }
                );
                if (openMachine && blockingIssue.action === 'openMachine') {
                    params.router.push(`/machine/${params.selectedMachineId}` as any);
                }
                params.setIsCreating(false);
                return;
            }

            const resumeDecision = await (async (): Promise<{ resume?: string; reason?: string }> => {
                const wanted = params.resumeSessionId.trim();
                if (!wanted) return {};

                const computeOptions = (results: any) => buildResumeCapabilityOptionsFromUiState({ settings: params.settings, results });

                const snapshot = getMachineCapabilitiesSnapshot(params.selectedMachineId!);
                const results = snapshot?.response.results as any;
                let options = computeOptions(results);

                if (!canAgentResume(params.agentType, options)) {
                    const plan = getResumeRuntimeSupportPrefetchPlan({ agentId: params.agentType, settings: params.settings, results });
                    if (plan) {
                        params.setIsResumeSupportChecking(true);
                        try {
                            await prefetchMachineCapabilities({
                                machineId: params.selectedMachineId!,
                                request: plan.request,
                                timeoutMs: plan.timeoutMs,
                            });
                        } catch {
                            // Non-blocking: we'll fall back to starting a new session if resume is still gated.
                        } finally {
                            params.setIsResumeSupportChecking(false);
                        }

                        const snapshot2 = getMachineCapabilitiesSnapshot(params.selectedMachineId!);
                        const results2 = snapshot2?.response.results as any;
                        options = computeOptions(results2);
                    }
                }

                if (canAgentResume(params.agentType, options)) return { resume: wanted };

                const snapshotFinal = getMachineCapabilitiesSnapshot(params.selectedMachineId!);
                const resultsFinal = snapshotFinal?.response.results as any;
                const desc = describeAcpLoadSessionSupport(params.agentType, resultsFinal);
                const detailLines: string[] = [];
                if (desc.code) {
                    detailLines.push(formatResumeSupportDetailCode(desc.code));
                }
                if (desc.rawMessage) {
                    detailLines.push(desc.rawMessage);
                }
                const detail = detailLines.length > 0 ? `\n\n${t('common.details')}: ${detailLines.join('\n')}` : '';
                return { reason: `${t('newSession.resume.cannotApplyBody')}${detail}` };
            })();

            if (params.resumeSessionId.trim() && !resumeDecision.resume) {
                const proceed = await Modal.confirm(
                    t('session.resumeFailed'),
                    resumeDecision.reason ?? t('newSession.resume.cannotApplyBody'),
                    { confirmText: t('common.continue') },
                );
                if (!proceed) {
                    params.setIsCreating(false);
                    return;
                }
            }

            const result = await machineSpawnNewSession({
                machineId: params.selectedMachineId,
                directory: actualPath,
                approvedNewDirectoryCreation: true,
                agent: params.agentType,
                profileId: profilesActive ? (params.selectedProfileId ?? '') : undefined,
                environmentVariables,
                resume: resumeDecision.resume,
                ...buildSpawnSessionExtrasFromUiState({
                    agentId: params.agentType,
                    settings: params.settings,
                    resumeSessionId: params.resumeSessionId,
                }),
                terminal,
            });

            if (result.type === 'success' && result.sessionId) {
                // Clear draft state on successful session creation
                clearNewSessionDraft();

                await sync.refreshSessions();

                // Set permission mode and model mode on the session
                storage.getState().updateSessionPermissionMode(result.sessionId, params.permissionMode);
                if (getAgentCore(params.agentType).model.supportsSelection && params.modelMode && params.modelMode !== 'default') {
                    storage.getState().updateSessionModelMode(result.sessionId, params.modelMode);
                }

                // Send initial message if provided
                if (params.sessionPrompt.trim()) {
                    await sync.sendMessage(result.sessionId, params.sessionPrompt);
                }

                params.router.replace(`/session/${result.sessionId}`, {
                    dangerouslySingular() {
                        return 'session'
                    },
                });
            } else if (result.type === 'requestToApproveDirectoryCreation') {
                Modal.alert(t('common.error'), t('newSession.failedToStart'));
                params.setIsCreating(false);
            } else if (result.type === 'error') {
                const extraDetail = (() => {
                    switch (result.errorCode) {
                        case SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED:
                            return 'Resume is not supported for this agent on this machine.';
                        case SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK:
                            return 'The agent process exited before it could connect. Check that the agent CLI is installed and available to the daemon (PATH).';
                        case SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT:
                            return 'Session startup timed out. The machine may be slow or the agent CLI may be stuck starting.';
                        default:
                            return null;
                    }
                })();
                const detail = extraDetail ? `\n\n${t('common.details')}: ${extraDetail}` : '';
                Modal.alert(t('common.error'), `${result.errorMessage}${detail}`);
                params.setIsCreating(false);
            } else {
                throw new Error('Session spawning failed - no session ID returned.');
            }
        } catch (error) {
            console.error('Failed to start session', error);
            let errorMessage = 'Failed to start session. Make sure the daemon is running on the target machine.';
            if (error instanceof Error) {
                if (error.message.includes('timeout')) {
                    errorMessage = 'Session startup timed out. The machine may be slow or the daemon may not be responding.';
                } else if (error.message.includes('Socket not connected')) {
                    errorMessage = 'Not connected to server. Check your internet connection.';
                }
            }
            Modal.alert(t('common.error'), errorMessage);
            params.setIsCreating(false);
        }
    }, [
        params.agentType,
        params.machineEnvPresence.meta,
        params.modelMode,
        params.permissionMode,
        params.profileMap,
        params.recentMachinePaths,
        params.resumeSessionId,
        params.router,
        params.agentNewSessionOptions,
        params.settings,
        params.secretBindingsByProfileId,
        params.secrets,
        params.selectedMachineCapabilities,
        params.selectedSecretIdByProfileIdByEnvVarName,
        params.selectedMachineId,
        params.selectedPath,
        params.selectedProfileId,
        params.sessionOnlySecretValueByProfileIdByEnvVarName,
        params.sessionPrompt,
        params.sessionType,
        params.setIsCreating,
        params.setIsResumeSupportChecking,
        params.useProfiles,
    ]);

    return { handleCreateSession };
}
