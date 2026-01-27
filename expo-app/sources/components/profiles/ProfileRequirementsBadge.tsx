import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AIBackendProfile } from '@/sync/settings';
import { t } from '@/text';
import { useProfileEnvRequirements } from '@/hooks/useProfileEnvRequirements';
import { hasRequiredSecret } from '@/sync/profileSecrets';

export interface ProfileRequirementsBadgeProps {
    profile: AIBackendProfile;
    machineId: string | null;
    onPressIn?: () => void;
    onPress?: () => void;
    /**
     * Optional override when the API key requirement is satisfied via a saved/session key
     * (not the machine environment). Used by New Session flows.
     */
    overrideReady?: boolean;
    /**
     * Optional override for machine-env preflight readiness/loading.
     * When provided, this component will NOT run its own env preflight hook.
     */
    machineEnvOverride?: {
        isReady: boolean;
        isLoading: boolean;
    } | null;
}

export function ProfileRequirementsBadge(props: ProfileRequirementsBadgeProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const show = hasRequiredSecret(props.profile);
    const requirements = useProfileEnvRequirements(
        props.machineEnvOverride ? null : props.machineId,
        props.machineEnvOverride ? null : (show ? props.profile : null),
    );

    if (!show) {
        return null;
    }

    const machineIsReady = props.machineEnvOverride ? props.machineEnvOverride.isReady : requirements.isReady;
    const machineIsLoading = props.machineEnvOverride ? props.machineEnvOverride.isLoading : requirements.isLoading;

    const isReady = machineIsReady || props.overrideReady === true;
    const isLoading = machineIsLoading && !isReady;

    const statusColor = isLoading
        ? theme.colors.status.connecting
        : isReady
            ? theme.colors.status.connected
            : theme.colors.status.disconnected;

    const label = isReady
        ? t('secrets.badgeReady')
        : t('secrets.badgeRequired');

    const iconName = isLoading
        ? 'time-outline'
        : isReady
            ? 'checkmark-circle-outline'
            : 'key-outline';

    return (
        <Pressable
            onPressIn={(e) => {
                e?.stopPropagation?.();
                props.onPressIn?.();
            }}
            onPress={(e) => {
                e?.stopPropagation?.();
                props.onPress?.();
            }}
            style={({ pressed }) => [
                styles.badge,
                {
                    borderColor: statusColor,
                    opacity: pressed ? 0.85 : 1,
                },
            ]}
        >
            <View style={styles.badgeRow}>
                <Ionicons name={iconName as any} size={14} color={statusColor} />
                <Text style={[styles.badgeText, { color: statusColor }]} numberOfLines={1}>
                    {label}
                </Text>
            </View>
        </Pressable>
    );
}


const stylesheet = StyleSheet.create((theme) => ({
    badge: {
        maxWidth: 140,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 6,
        backgroundColor: theme.colors.surface,
    },
    badgeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    badgeText: {
        fontSize: 12,
        fontWeight: '600',
    },
}));
