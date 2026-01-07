import React from 'react';
import { View, Text, ScrollView, ActivityIndicator } from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { CommonActions, useNavigation } from '@react-navigation/native';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { Typography } from '@/constants/Typography';
import { useAllMachines } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import { isMachineOnline } from '@/utils/machineUtils';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { ItemList } from '@/components/ItemList';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    scrollContainer: {
        flex: 1,
    },
    scrollContent: {
        paddingVertical: 16,
        alignItems: 'center',
    },
    contentWrapper: {
        width: '100%',
        maxWidth: layout.maxWidth,
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    emptyText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
    offlineWarning: {
        marginHorizontal: 16,
        marginTop: 16,
        marginBottom: 8,
        padding: 16,
        backgroundColor: theme.colors.box.warning.background,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.box.warning.border,
    },
    offlineWarningTitle: {
        fontSize: 14,
        color: theme.colors.box.warning.text,
        marginBottom: 8,
        ...Typography.default('semiBold'),
    },
    offlineWarningText: {
        fontSize: 13,
        color: theme.colors.box.warning.text,
        lineHeight: 20,
        marginBottom: 4,
        ...Typography.default(),
    },
}));

export default function MachinePickerScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ selectedId?: string }>();
    const machines = useAllMachines();

    const handleSelectMachine = (machineId: string) => {
        const state = navigation.getState();
        const previousRoute = state.routes[state.index - 1];
        if (previousRoute) {
            navigation.dispatch({
                ...CommonActions.setParams({ machineId }),
                source: previousRoute.key,
            } as never);
        }
        router.back();
    };

    if (machines.length === 0) {
        return (
            <>
                <Stack.Screen
                    options={{
                        headerShown: true,
                        headerTitle: 'Select Machine',
                        headerBackTitle: t('common.back')
                    }}
                />
                <View style={styles.container}>
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyText}>
                            No machines available
                        </Text>
                    </View>
                </View>
            </>
        );
    }

    return (
        <>
            <ItemList>
                {machines.length === 0 && (
                    <View style={styles.offlineWarning}>
                        <Text style={styles.offlineWarningTitle}>
                            All machines offline
                        </Text>
                        <View style={{ marginTop: 4 }}>
                            <Text style={styles.offlineWarningText}>
                                {t('machine.offlineHelp')}
                            </Text>
                        </View>
                    </View>
                )}

                <ItemGroup>
                    {machines.map((machine) => {
                        const displayName = machine.metadata?.displayName || machine.metadata?.host || machine.id;
                        const hostName = machine.metadata?.host || machine.id;
                        const offline = !isMachineOnline(machine);
                        const isSelected = params.selectedId === machine.id;

                        return (
                            <Item
                                key={machine.id}
                                title={displayName}
                                subtitle={displayName !== hostName ? hostName : undefined}
                                leftElement={
                                    <Ionicons
                                        name="desktop-outline"
                                        size={24}
                                        color={offline ? theme.colors.textSecondary : theme.colors.text}
                                    />
                                }
                                detail={offline ? 'offline' : 'online'}
                                detailStyle={{
                                    color: offline ? theme.colors.status.disconnected : theme.colors.status.connected
                                }}
                                titleStyle={{
                                    color: offline ? theme.colors.textSecondary : theme.colors.text
                                }}
                                subtitleStyle={{
                                    color: theme.colors.textSecondary
                                }}
                                selected={isSelected}
                                onPress={() => handleSelectMachine(machine.id)}
                                showChevron={false}
                            />
                        );
                    })}
                </ItemGroup>
            </ItemList>
        </>
    );
}