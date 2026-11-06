import * as React from 'react';
import { Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { GoalBoardButton } from './GoalBoardButton';

export interface GoalBoardTriggerProps {
    completed: number;
    total: number;
    open: boolean;
    onPress: () => void;
}

export const GoalBoardTrigger = React.memo(function GoalBoardTrigger({ completed, total, open, onPress }: GoalBoardTriggerProps) {
    const { theme } = useUnistyles();
    const label = t('goalBoard.trigger', { completed, total });
    return <GoalBoardButton testID="goal-board-trigger" label={label} expanded={open} selected={open} onPress={onPress} variant="chip">
        <Ionicons name="list-outline" size={16} color={theme.colors.textSecondary} />
        <Text style={styles.label}>{label}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={12} color={theme.colors.textSecondary} />
    </GoalBoardButton>;
});

const styles = StyleSheet.create((theme) => ({
    label: { ...Typography.default('semiBold'), fontSize: 12, lineHeight: 18, color: theme.colors.text },
}));
