import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
import type { VisibleAgentGoalStatus } from './agentGoalStatus';
import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

export type AgentGoalAction = 'clear' | 'pause' | 'resume' | 'edit';

type AgentGoalBarProps = {
    goal: VisibleAgentGoalStatus;
    onAction?: (action: AgentGoalAction) => void;
    inFlightAction?: AgentGoalAction | null;
    onPressDetails?: () => void;
};

type GoalActionConfig = {
    action: AgentGoalAction;
    capability: keyof NonNullable<VisibleAgentGoalStatus['capabilities']>;
    icon: keyof typeof Ionicons.glyphMap;
};

const BASE_ACTION_CONFIG: GoalActionConfig[] = [
    { action: 'edit', capability: 'edit', icon: 'create-outline' },
    { action: 'clear', capability: 'clear', icon: 'trash-outline' },
];

export function AgentGoalBar(props: AgentGoalBarProps) {
    const { theme } = useUnistyles();
    const lifecycleAction: GoalActionConfig | null = props.goal.providerStatus === 'active'
        ? { action: 'pause', capability: 'pause', icon: 'pause-outline' }
        : props.goal.providerStatus === 'paused'
            ? { action: 'resume', capability: 'resume', icon: 'play-outline' }
            : null;
    const actionConfig = lifecycleAction
        ? [BASE_ACTION_CONFIG[0], lifecycleAction, BASE_ACTION_CONFIG[1]]
        : BASE_ACTION_CONFIG;
    const actions = props.onAction
        ? actionConfig.filter((item) => props.goal.capabilities?.[item.capability])
        : [];
    const actionLabels: Record<AgentGoalAction, string> = {
        edit: t('components.agentGoalBar.editGoal'),
        pause: t('components.agentGoalBar.pauseGoal'),
        resume: t('components.agentGoalBar.resumeGoal'),
        clear: t('components.agentGoalBar.clearGoal'),
    };
    const statusLabel = props.goal.providerStatus === 'paused'
        ? t('components.agentGoalBar.statusPaused')
        : props.goal.providerStatus === 'blocked'
            ? t('components.agentGoalBar.statusBlocked')
            : props.goal.providerStatus === 'usageLimited'
                ? t('components.agentGoalBar.statusUsageLimited')
                : props.goal.providerStatus === 'budgetLimited'
                    ? t('components.agentGoalBar.statusBudgetLimited')
                    : null;

    return (
        <Pressable
            accessibilityLabel={[
                t('components.agentGoalBar.accessibilityLabel', { goal: props.goal.text }),
                statusLabel,
            ].filter(Boolean).join('. ')}
            onPress={props.onPressDetails}
            style={({ pressed }) => ({
                backgroundColor: theme.colors.surfaceHigh,
                borderColor: theme.colors.divider,
                borderWidth: 1,
                borderRadius: 14,
                paddingHorizontal: 12,
                paddingVertical: 10,
                marginBottom: 8,
                opacity: pressed && props.onPressDetails ? 0.8 : 1,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
            })}
        >
            <Ionicons name="locate-outline" size={18} color={theme.colors.textSecondary} />
            <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                    style={{
                        color: theme.colors.textSecondary,
                        fontSize: 12,
                        lineHeight: 16,
                        fontWeight: '600',
                    }}
                    numberOfLines={1}
                >
                    {t('components.agentGoalBar.currentGoal')}
                    {statusLabel ? ` · ${statusLabel}` : null}
                </Text>
                <Text
                    style={{
                        color: theme.colors.text,
                        fontSize: 14,
                        lineHeight: 19,
                    }}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                >
                    {props.goal.text}
                </Text>
            </View>
            {actions.length > 0 && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    {actions.map((item) => {
                        const disabled = props.inFlightAction != null;
                        const showSpinner = props.inFlightAction === item.action;
                        return (
                            <Pressable
                                key={item.action}
                                accessibilityRole="button"
                                accessibilityLabel={actionLabels[item.action]}
                                accessibilityState={{ disabled }}
                                disabled={disabled}
                                onPress={() => props.onAction?.(item.action)}
                                hitSlop={8}
                                style={({ pressed }) => ({
                                    width: 30,
                                    height: 30,
                                    borderRadius: 15,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent',
                                    opacity: disabled ? 0.6 : 1,
                                })}
                            >
                                {showSpinner ? (
                                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                ) : (
                                    <Ionicons name={item.icon} size={16} color={theme.colors.button.secondary.tint} />
                                )}
                            </Pressable>
                        );
                    })}
                </View>
            )}
        </Pressable>
    );
}
