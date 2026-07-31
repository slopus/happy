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
    iconContainer: {
        marginBottom: 24,
    },
    titleText: {
        fontSize: 20,
        color: theme.colors.textSecondary,
        textAlign: 'center',
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
    button: {
        backgroundColor: theme.colors.button.primary.background,
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 12,
        flexDirection: 'row',
        alignItems: 'center',
    },
    buttonDisabled: {
        backgroundColor: theme.colors.textSecondary,
        opacity: 0.6,
    },
    buttonIcon: {
        marginRight: 8,
    },
    buttonText: {
        fontSize: 16,
        color: theme.colors.button.primary.tint,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
}));

export function shouldShowSessionEmptyState(sessionCount: number): boolean {
    return sessionCount === 0;
}

export function EmptySessionsTablet({ title = t('sidebar.emptySessionsTitle') }: { title?: string }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const machines = useAllMachines();
    
    const hasOnlineMachines = React.useMemo(() => {
        return machines.some(machine => isMachineOnline(machine));
    }, [machines]);
    
    const handleStartNewSession = () => {
        router.navigate('/new');
    };
    
    return (
        <View style={styles.container}>
            <Ionicons 
                name="terminal-outline" 
                size={64} 
                color={theme.colors.textSecondary}
                style={styles.iconContainer}
            />
            
            <Text style={styles.titleText}>
                {title}
            </Text>
            
            {hasOnlineMachines ? (
                <>
                    <Text style={styles.descriptionText}>
                        {t('sidebar.emptySessionsOnlineDescription')}
                    </Text>
                    <Pressable
                        style={styles.button}
                        onPress={handleStartNewSession}
                    >
                        <Ionicons
                            name="add"
                            size={20}
                            color={theme.colors.button.primary.tint}
                            style={styles.buttonIcon}
                        />
                        <Text style={styles.buttonText}>
                            {t('newSession.title')}
                        </Text>
                    </Pressable>
                </>
            ) : (
                <Text style={styles.descriptionText}>
                    {t('sidebar.emptySessionsOfflineDescription')}
                </Text>
            )}
        </View>
    );
}
