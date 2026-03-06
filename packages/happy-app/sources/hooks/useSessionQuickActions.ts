import * as React from 'react';
import { useHappyAction } from '@/hooks/useHappyAction';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { Modal } from '@/modal';
import { machineSpawnNewSession, sessionKill } from '@/sync/ops';
import { storage, useLocalSetting, useMachine } from '@/sync/storage';
import { Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { HappyError } from '@/utils/errors';
import { useSessionStatus } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { useRouter } from 'expo-router';

interface UseSessionQuickActionsOptions {
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    onAfterBugReport?: () => void;
}

export function useSessionQuickActions(
    session: Session,
    options: UseSessionQuickActionsOptions = {},
) {
    const {
        onAfterArchive,
        onAfterBugReport,
    } = options;
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const sessionStatus = useSessionStatus(session);
    const machineId = session.metadata?.machineId ?? '';
    const machine = useMachine(machineId);
    const devModeEnabled = useLocalSetting('devModeEnabled');

    const openDetails = React.useCallback(() => {
        router.push(`/session/${session.id}/info`);
    }, [router, session.id]);

    const createBugReportDraft = React.useCallback(() => {
        const sessionMetadata = session.metadata;
        const happyHomeDir = sessionMetadata?.happyHomeDir || machine?.metadata?.happyHomeDir;
        const logFolder = happyHomeDir ? `${happyHomeDir}/logs` : null;

        const metadataLines = [
            ['Source session', session.id],
            ['Agent', formatAgentName(sessionMetadata?.flavor)],
            ['Session path', sessionMetadata?.path ?? null],
            ['Host', sessionMetadata?.host ?? machine?.metadata?.host ?? null],
            ['CLI version', sessionMetadata?.version ?? machine?.metadata?.happyCliVersion ?? null],
            ['OS', sessionMetadata?.os ?? machine?.metadata?.platform ?? null],
            ['Happy home dir', happyHomeDir ?? null],
            ['Log folder', logFolder],
        ].filter((entry): entry is [string, string] => Boolean(entry[1]));

        return [
            'Bug report',
            '',
            'What happened:',
            '',
            'What did you expect to happen:',
            '',
            'How can we reproduce it:',
            '',
            'Metadata:',
            ...metadataLines.map(([label, value]) => `- ${label}: ${value}`),
        ].join('\n');
    }, [machine?.metadata?.happyCliVersion, machine?.metadata?.happyHomeDir, machine?.metadata?.host, machine?.metadata?.platform, session.id, session.metadata]);

    const spawnBugReportSession = React.useCallback(async (approvedNewDirectoryCreation: boolean = false): Promise<void> => {
        const machineId = session.metadata?.machineId;
        const directory = session.metadata?.path;
        if (!machineId || !directory) {
            throw new HappyError('Current session is missing machine or directory metadata.', false);
        }

        if (machine && !isMachineOnline(machine)) {
            throw new HappyError(t('machineLauncher.offlineUnableToSpawn'), false);
        }

        const result = await machineSpawnNewSession({
            machineId,
            directory,
            approvedNewDirectoryCreation,
            agent: toSpawnAgent(session.metadata?.flavor),
        });

        switch (result.type) {
            case 'success': {
                for (let attempt = 0; attempt < 3; attempt++) {
                    await sync.refreshSessions();
                    if (storage.getState().sessions[result.sessionId]) {
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 150));
                }

                if (session.permissionMode) {
                    storage.getState().updateSessionPermissionMode(result.sessionId, session.permissionMode);
                }
                if (session.modelMode) {
                    storage.getState().updateSessionModelMode(result.sessionId, session.modelMode);
                }
                storage.getState().updateSessionDraft(result.sessionId, createBugReportDraft());

                onAfterBugReport?.();
                navigateToSession(result.sessionId);
                return;
            }
            case 'requestToApproveDirectoryCreation': {
                const approved = await Modal.confirm(
                    'Create Directory?',
                    `The directory '${result.directory}' does not exist. Would you like to create it?`,
                    { cancelText: t('common.cancel'), confirmText: t('common.create') },
                );
                if (!approved) {
                    return;
                }
                await spawnBugReportSession(true);
                return;
            }
            case 'error':
                throw new HappyError(result.errorMessage, false);
        }
    }, [createBugReportDraft, machine, navigateToSession, onAfterBugReport, session.metadata?.flavor, session.metadata?.machineId, session.metadata?.path, session.modelMode, session.permissionMode]);

    const [reportingBug, performBugReport] = useHappyAction(async () => {
        await spawnBugReportSession(false);
    });

    const [archivingSession, performArchive] = useHappyAction(async () => {
        const result = await sessionKill(session.id);
        if (!result.success) {
            throw new HappyError(result.message || t('sessionInfo.failedToArchiveSession'), false);
        }
        onAfterArchive?.();
    });

    const archiveSession = React.useCallback(() => {
        performArchive();
    }, [performArchive]);

    return {
        archiveSession,
        archivingSession,
        canArchive: sessionStatus.isConnected,
        canBugReport: __DEV__ || devModeEnabled,
        openDetails,
        reportBug: performBugReport,
        reportingBug,
    };
}

function toSpawnAgent(flavor: string | null | undefined): 'claude' | 'codex' | 'gemini' | 'openclaw' {
    if (flavor === 'codex' || flavor === 'openai' || flavor === 'gpt') {
        return 'codex';
    }
    if (flavor === 'gemini' || flavor === 'openclaw') {
        return flavor;
    }
    return 'claude';
}

function formatAgentName(flavor: string | null | undefined): string {
    if (flavor === 'codex' || flavor === 'openai' || flavor === 'gpt') {
        return 'Codex';
    }
    if (flavor === 'gemini') {
        return 'Gemini';
    }
    if (flavor === 'openclaw') {
        return 'OpenClaw';
    }
    if (flavor === 'claude' || !flavor) {
        return 'Claude';
    }
    return flavor;
}
