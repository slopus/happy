import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { GoalBoardButton as Button } from '../goalBoard/GoalBoardButton';
import type { ProjectSessionMonitorProps, ProjectTaskSessionsProps } from './ProjectSessionMonitor.types';
/** Native retains the existing task action; the desktop monitor has no native UI. */
export function ProjectSessionMonitor({ children }: ProjectSessionMonitorProps) { return <>{children}</>; }
export function GlobalSessionEntry(_props: { compact?: boolean } = {}) { return null; }
export function ProjectSessionSummary() { return null; }
export function ProjectTaskSessions({ task, onFallback, disabled, offline }: ProjectTaskSessionsProps) {
    const { theme } = useUnistyles();
    return <Button variant="toolbar" label={t('projectGoals.openChat')} disabled={disabled || offline} onPress={onFallback} testID={`project-task-chat-${task.id}`}><Ionicons name="chatbubble-outline" size={17} color={theme.colors.textSecondary} /></Button>;
}
