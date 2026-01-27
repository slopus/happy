import { Ionicons, Octicons } from '@expo/vector-icons';
import * as React from 'react';
import { t } from '@/text';
import type { AgentId } from '@/agents/catalog';
import { getAgentCore } from '@/agents/catalog';
import type { ActionListItem } from '@/components/ui/lists/ActionListSection';
import { hapticsLight } from '@/components/haptics';
import { formatResumeChipLabel, RESUME_CHIP_ICON_NAME, RESUME_CHIP_ICON_SIZE } from './ResumeChip';

export function buildAgentInputActionMenuActions(opts: {
    actionBarIsCollapsed: boolean;
    hasAnyActions: boolean;
    tint: string;
    agentId: AgentId;
    profileLabel: string | null;
    profileIcon: string;
    envVarsCount?: number;
    agentType?: AgentId;
    machineName?: string | null;
    currentPath?: string | null;
    resumeSessionId?: string | null;
    sessionId?: string;
    onProfileClick?: () => void;
    onEnvVarsClick?: () => void;
    onAgentClick?: () => void;
    onMachineClick?: () => void;
    onPathClick?: () => void;
    onResumeClick?: () => void;
    onFileViewerPress?: () => void;
    canStop?: boolean;
    onStop?: () => void;
    dismiss: () => void;
    blurInput: () => void;
}): ActionListItem[] {
    if (!opts.actionBarIsCollapsed || !opts.hasAnyActions) return [] as ActionListItem[];

    const actions: ActionListItem[] = [];

    if (opts.onProfileClick) {
        actions.push({
            id: 'profile',
            label: opts.profileLabel ?? t('profiles.noProfile'),
            icon: <Ionicons name={opts.profileIcon as any} size={16} color={opts.tint} />,
            onPress: () => {
                hapticsLight();
                opts.dismiss();
                opts.onProfileClick?.();
            },
        });
    }

    if (opts.onEnvVarsClick) {
        actions.push({
            id: 'env-vars',
            label:
                opts.envVarsCount === undefined
                    ? t('agentInput.envVars.title')
                    : t('agentInput.envVars.titleWithCount', { count: opts.envVarsCount }),
            icon: <Ionicons name="list-outline" size={16} color={opts.tint} />,
            onPress: () => {
                hapticsLight();
                opts.dismiss();
                opts.onEnvVarsClick?.();
            },
        });
    }

    if (opts.agentType && opts.onAgentClick) {
        actions.push({
            id: 'agent',
            label: t(getAgentCore(opts.agentId).displayNameKey),
            icon: <Octicons name="cpu" size={16} color={opts.tint} />,
            onPress: () => {
                hapticsLight();
                opts.dismiss();
                opts.onAgentClick?.();
            },
        });
    }

    if (opts.machineName !== undefined && opts.onMachineClick) {
        actions.push({
            id: 'machine',
            label: opts.machineName === null ? t('agentInput.noMachinesAvailable') : opts.machineName,
            icon: <Ionicons name="desktop-outline" size={16} color={opts.tint} />,
            onPress: () => {
                hapticsLight();
                opts.dismiss();
                opts.onMachineClick?.();
            },
        });
    }

    if (opts.currentPath && opts.onPathClick) {
        actions.push({
            id: 'path',
            label: opts.currentPath,
            icon: <Ionicons name="folder-outline" size={16} color={opts.tint} />,
            onPress: () => {
                hapticsLight();
                opts.dismiss();
                opts.onPathClick?.();
            },
        });
    }

    if (opts.onResumeClick) {
        actions.push({
            id: 'resume',
            label: formatResumeChipLabel({
                resumeSessionId: opts.resumeSessionId,
                labelTitle: t('newSession.resume.title'),
                labelOptional: t('newSession.resume.optional'),
            }),
            icon: <Ionicons name={RESUME_CHIP_ICON_NAME} size={RESUME_CHIP_ICON_SIZE} color={opts.tint} />,
            onPress: () => {
                hapticsLight();
                opts.dismiss();
                opts.blurInput();
                opts.onResumeClick?.();
            },
        });
    }

    if (opts.sessionId && opts.onFileViewerPress) {
        actions.push({
            id: 'files',
            label: t('agentInput.actionMenu.files'),
            icon: <Octicons name="git-branch" size={16} color={opts.tint} />,
            onPress: () => {
                hapticsLight();
                opts.dismiss();
                opts.onFileViewerPress?.();
            },
        });
    }

    if (opts.canStop && opts.onStop) {
        actions.push({
            id: 'stop',
            label: t('agentInput.actionMenu.stop'),
            icon: <Octicons name="stop" size={16} color={opts.tint} />,
            onPress: () => {
                opts.dismiss();
                opts.onStop?.();
            },
        });
    }

    return actions;
}
