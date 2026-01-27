import * as React from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/RoundButton';
import { useMachineCapabilitiesCache } from '@/hooks/useMachineCapabilitiesCache';
import { DetectedClisList } from '@/components/machines/DetectedClisList';
import { t } from '@/text';
import type { CustomModalInjectedProps } from '@/modal';
import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';

type Props = CustomModalInjectedProps & {
    machineId: string;
    isOnline: boolean;
};

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        width: 360,
        maxWidth: '92%',
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
        elevation: 5,
    },
    header: {
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    body: {
        paddingVertical: 4,
    },
    footer: {
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
        alignItems: 'center',
    },
}));

export function DetectedClisModal({ onClose, machineId, isOnline }: Props) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const { state, refresh } = useMachineCapabilitiesCache({
        machineId,
        // Cache-first: never auto-fetch on mount; user can explicitly refresh.
        enabled: false,
        request: CAPABILITIES_REQUEST_NEW_SESSION,
    });

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>{t('machine.detectedClis')}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Pressable
                        onPress={() => refresh()}
                        hitSlop={10}
                        style={{ padding: 2 }}
                        accessibilityRole="button"
                        accessibilityLabel="Refresh"
                        disabled={!isOnline || state.status === 'loading'}
                    >
                        {state.status === 'loading'
                            ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                            : <Ionicons name="refresh" size={20} color={isOnline ? theme.colors.textSecondary : theme.colors.divider} />}
                    </Pressable>
                    <Pressable
                        onPress={onClose as any}
                        hitSlop={10}
                        style={{ padding: 2 }}
                        accessibilityRole="button"
                        accessibilityLabel="Close"
                    >
                        <Ionicons name="close" size={22} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>
            </View>

            <View style={styles.body}>
                <DetectedClisList state={state} layout="stacked" />
            </View>

            <View style={styles.footer}>
                <RoundButton title={t('common.ok')} size="normal" onPress={onClose} />
            </View>
        </View>
    );
}
