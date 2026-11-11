import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import type { GoalTaskStatus } from '@slopus/happy-wire';
import { t } from '@/text';

const icons = { pending: 'ellipse-outline', running: 'flash-outline', review: 'time-outline', done: 'checkmark-circle', blocked: 'pause-circle-outline', unknown: 'help-circle-outline' } as const;
export function ProjectTaskStatus({ status }: { status: GoalTaskStatus }) {
    const { theme } = useUnistyles();
    const label = t(`goalBoard.status.${status}`);
    const color = status === 'done' ? theme.colors.success : status === 'running' ? theme.colors.textLink : status === 'blocked' ? theme.colors.warning : theme.colors.textSecondary;
    return <View accessibilityRole="image" accessibilityLabel={label} {...{ title: label }} testID={`project-task-status-${status}`}><Ionicons name={icons[status]} size={15} color={color} /></View>;
}
