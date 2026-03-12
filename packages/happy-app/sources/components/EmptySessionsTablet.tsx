import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { useRouter } from 'expo-router';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 48,
    },
    titleText: {
        fontSize: 20,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginTop: 8,
        marginBottom: 8,
        ...Typography.default('regular'),
    },
    descriptionText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginBottom: 24,
        ...Typography.default(),
    },
}));

export function EmptySessionsTablet() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const machines = useAllMachines();
    
    const hasOnlineMachines = React.useMemo(() => {
        return machines.some(machine => isMachineOnline(machine));
    }, [machines]);
    
    return (
        <View style={styles.container}>
            <Ionicons 
                name="terminal-outline" 
                size={64} 
                color={theme.colors.textSecondary}
            />
            
            <Text style={styles.titleText}>
                {t('components.emptySessions.noActiveSessions')}
            </Text>
            
            {hasOnlineMachines ? (
                <Text style={styles.descriptionText}>
                    {t('components.emptySessions.startOnConnectedMachines')}
                </Text>
            ) : (
                <Text style={styles.descriptionText}>
                    {t('components.emptySessions.openTerminalToStart')}
                </Text>
            )}
        </View>
    );
}
