/**
 * Add Moltbot Machine Page
 *
 * Allows users to add a new Moltbot machine, either:
 * - Happy Machine: Connect through an existing Happy machine relay
 * - Direct: Connect directly to a Moltbot gateway URL
 */

import React from 'react';
import { View, Text, ScrollView, TextInput, Pressable, ActivityIndicator, Alert } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { useAllMachines } from '@/sync/storage';
import { sync } from '@/sync/sync';
import type { Machine } from '@/sync/storageTypes';

type MachineType = 'happy' | 'direct';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    scrollContent: {
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
        paddingBottom: 24,
    },
    inputWrapper: {
        backgroundColor: theme.colors.surface,
        borderRadius: 10,
        overflow: 'hidden',
    },
    input: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        fontSize: 17,
        color: theme.colors.text,
        outlineStyle: 'none',
        outlineWidth: 0,
        outlineColor: 'transparent',
        ...Typography.default(),
    },
    submitButton: {
        backgroundColor: theme.colors.button.primary.background,
        marginHorizontal: 16,
        marginTop: 24,
        paddingVertical: 14,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        height: 50,
    },
    submitButtonDisabled: {
        opacity: 0.5,
    },
    submitButtonText: {
        color: '#FFFFFF',
        fontSize: 17,
        ...Typography.default('semiBold'),
    },
    typeIcon: {
        width: 28,
        height: 28,
        borderRadius: 6,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

interface MachineItemProps {
    machine: Machine;
    isSelected: boolean;
    onSelect: () => void;
}

const MachineItem = React.memo(({ machine, isSelected, onSelect }: MachineItemProps) => {
    const { theme } = useUnistyles();

    return (
        <Item
            title={machine.metadata?.displayName || machine.metadata?.host || machine.id}
            subtitle={machine.metadata?.platform || ''}
            subtitleLines={1}
            rightElement={isSelected ? (
                <Ionicons name="checkmark-circle" size={24} color={theme.colors.status.connected} />
            ) : (
                <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: theme.colors.divider }} />
            )}
            onPress={onSelect}
            showChevron={false}
        />
    );
});

export default function AddMoltbotMachinePage() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const machines = useAllMachines();

    // Form state
    const [machineType, setMachineType] = React.useState<MachineType>('happy');
    const [machineName, setMachineName] = React.useState('');
    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(null);
    const [gatewayUrl, setGatewayUrl] = React.useState('');
    const [gatewayPassword, setGatewayPassword] = React.useState('');
    const [isSubmitting, setIsSubmitting] = React.useState(false);

    // Auto-select first machine
    React.useEffect(() => {
        if (machineType === 'happy' && !selectedMachineId && machines.length > 0) {
            setSelectedMachineId(machines[0].id);
        }
    }, [machines, machineType, selectedMachineId]);

    const canSubmit = React.useMemo(() => {
        if (machineType === 'happy') {
            return !!selectedMachineId;
        } else {
            return !!gatewayUrl.trim();
        }
    }, [machineType, selectedMachineId, gatewayUrl]);

    const handleSubmit = React.useCallback(async () => {
        if (!canSubmit || isSubmitting) return;

        setIsSubmitting(true);

        // Auto-generate name if empty
        let name = machineName.trim();
        if (!name) {
            if (machineType === 'happy' && selectedMachineId) {
                const selectedMachine = machines.find(m => m.id === selectedMachineId);
                const machineName = selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host || 'Machine';
                name = `${machineName} Moltbot`;
            } else if (machineType === 'direct') {
                // Extract host from URL for name
                try {
                    const url = new URL(gatewayUrl.trim());
                    name = `${url.hostname} Moltbot`;
                } catch {
                    name = 'My Moltbot';
                }
            } else {
                name = 'My Moltbot';
            }
        }

        try {
            await sync.createMoltbotMachine({
                type: machineType,
                happyMachineId: machineType === 'happy' ? selectedMachineId! : undefined,
                directConfig: machineType === 'direct' ? {
                    url: gatewayUrl.trim(),
                    password: gatewayPassword.trim() || undefined,
                } : undefined,
                metadata: {
                    name,
                },
            });

            router.back();
        } catch (error) {
            console.error('Failed to create Moltbot machine:', error);
            Alert.alert(
                t('common.error'),
                error instanceof Error ? error.message : 'Failed to create machine'
            );
        } finally {
            setIsSubmitting(false);
        }
    }, [canSubmit, isSubmitting, machineType, selectedMachineId, gatewayUrl, gatewayPassword, machineName, router]);

    return (
        <View style={styles.container}>
            <ScrollView contentContainerStyle={styles.scrollContent}>
                {/* Machine Name */}
                <ItemGroup title={`${t('moltbot.sessionName')} (${t('common.optional')})`}>
                    <View style={styles.inputWrapper}>
                        <TextInput
                            style={styles.input}
                            value={machineName}
                            onChangeText={setMachineName}
                            placeholder="My Moltbot"
                            placeholderTextColor={theme.colors.textSecondary}
                            autoCapitalize="words"
                            autoCorrect={false}
                        />
                    </View>
                </ItemGroup>

                {/* Connection Type */}
                <ItemGroup title={t('moltbot.machineType')}>
                    <Item
                        title={t('moltbot.machineTypeHappy')}
                        subtitle={t('moltbot.machineTypeHappyDescription')}
                        subtitleLines={2}
                        leftElement={
                            <View style={[styles.typeIcon, { backgroundColor: theme.colors.status.connected + '20' }]}>
                                <Ionicons name="cloud" size={16} color={theme.colors.status.connected} />
                            </View>
                        }
                        rightElement={machineType === 'happy' ? (
                            <Ionicons name="checkmark-circle" size={24} color={theme.colors.status.connected} />
                        ) : null}
                        onPress={() => setMachineType('happy')}
                        showChevron={false}
                    />
                    <Item
                        title={t('moltbot.machineTypeDirect')}
                        subtitle={t('moltbot.machineTypeDirectDescription')}
                        subtitleLines={2}
                        leftElement={
                            <View style={[styles.typeIcon, { backgroundColor: theme.colors.surfacePressed }]}>
                                <Ionicons name="link" size={16} color={theme.colors.text} />
                            </View>
                        }
                        rightElement={machineType === 'direct' ? (
                            <Ionicons name="checkmark-circle" size={24} color={theme.colors.status.connected} />
                        ) : null}
                        onPress={() => setMachineType('direct')}
                        showChevron={false}
                    />
                </ItemGroup>

                {/* Happy Machine Selection */}
                {machineType === 'happy' && (
                    <ItemGroup title={t('moltbot.selectMachine')}>
                        {machines.length === 0 ? (
                            <Item
                                title={t('settings.machines')}
                                subtitle={t('moltbot.noSessionsDescription')}
                                disabled
                                showChevron={false}
                            />
                        ) : (
                            machines.map((machine) => (
                                <MachineItem
                                    key={machine.id}
                                    machine={machine}
                                    isSelected={selectedMachineId === machine.id}
                                    onSelect={() => setSelectedMachineId(machine.id)}
                                />
                            ))
                        )}
                    </ItemGroup>
                )}

                {/* Direct Connection Config */}
                {machineType === 'direct' && (
                    <>
                        <ItemGroup title={t('moltbot.gatewayUrl')}>
                            <View style={styles.inputWrapper}>
                                <TextInput
                                    style={styles.input}
                                    value={gatewayUrl}
                                    onChangeText={setGatewayUrl}
                                    placeholder="ws://localhost:18789"
                                    placeholderTextColor={theme.colors.textSecondary}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    keyboardType="url"
                                />
                            </View>
                        </ItemGroup>

                        <ItemGroup title={`${t('moltbot.gatewayPassword')} (${t('common.optional')})`}>
                            <View style={styles.inputWrapper}>
                                <TextInput
                                    style={styles.input}
                                    value={gatewayPassword}
                                    onChangeText={setGatewayPassword}
                                    placeholder=""
                                    placeholderTextColor={theme.colors.textSecondary}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    secureTextEntry
                                />
                            </View>
                        </ItemGroup>
                    </>
                )}

                {/* Submit Button */}
                <Pressable
                    style={[styles.submitButton, !canSubmit && styles.submitButtonDisabled]}
                    onPress={handleSubmit}
                    disabled={!canSubmit || isSubmitting}
                >
                    {isSubmitting ? (
                        <ActivityIndicator color="#FFFFFF" />
                    ) : (
                        <Text style={styles.submitButtonText}>{t('moltbot.addMachine')}</Text>
                    )}
                </Pressable>
            </ScrollView>
        </View>
    );
}
