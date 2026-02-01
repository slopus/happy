/**
 * Add OpenClaw Machine Page
 *
 * Allows users to add a new OpenClaw machine, either:
 * - Happy Machine: Connect through an existing Happy machine relay
 * - Direct: Connect directly to an OpenClaw gateway URL
 */

import React from 'react';
import { View, Text, ScrollView, TextInput, Pressable, ActivityIndicator, Alert } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { useAllMachines } from '@/sync/storage';
import { sync } from '@/sync/sync';
import type { Machine } from '@/sync/storageTypes';
import { generateSignKeypair } from '@/encryption/libsodium';
import { encodeBase64 } from '@/encryption/base64';

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
        borderRadius: 16,
        overflow: 'hidden',
    },
    input: {
        borderRadius: 16,
        paddingHorizontal: 16,
        paddingVertical: 12,
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default(),
    },
    submitButton: {
        backgroundColor: theme.colors.button.primary.background,
        marginHorizontal: 16,
        marginTop: 24,
        paddingVertical: 14,
        borderRadius: 16,
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

export default function AddOpenClawMachinePage() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const machines = useAllMachines();

    // Form state
    const [machineType, setMachineType] = React.useState<MachineType>('happy');
    const [machineName, setMachineName] = React.useState('');
    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(null);
    const [gatewayUrl, setGatewayUrl] = React.useState('');
    const [gatewayToken, setGatewayToken] = React.useState('');
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
                name = `${machineName} OpenClaw`;
            } else if (machineType === 'direct') {
                // Extract host from URL for name
                try {
                    const url = new URL(gatewayUrl.trim());
                    name = `${url.hostname} OpenClaw`;
                } catch {
                    name = 'My OpenClaw';
                }
            } else {
                name = 'My OpenClaw';
            }
        }

        try {
            // Generate Ed25519 keypair for device authentication
            const keypair = await generateSignKeypair();
            // Derive deviceId from public key SHA-256 hash (hex encoded)
            // This matches the OpenClaw gateway's expected device identity format
            const hashBuffer = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(keypair.publicKey));
            const deviceId = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
            const pairingData = {
                deviceId,
                publicKey: encodeBase64(keypair.publicKey, 'base64url'),
                privateKey: encodeBase64(keypair.privateKey, 'base64url'),
            };

            await sync.createOpenClawMachine({
                type: machineType,
                happyMachineId: machineType === 'happy' ? selectedMachineId! : undefined,
                directConfig: machineType === 'direct' ? {
                    url: gatewayUrl.trim(),
                    token: gatewayToken.trim() || undefined,
                } : undefined,
                metadata: {
                    name,
                    // Store gatewayToken in metadata for type='happy' so it gets encrypted and synced
                    gatewayToken: machineType === 'happy' && gatewayToken.trim() ? gatewayToken.trim() : undefined,
                },
                pairingData,
            });

            router.back();
        } catch (error) {
            console.error('Failed to create OpenClaw machine:', error);
            Alert.alert(
                t('common.error'),
                error instanceof Error ? error.message : 'Failed to create machine'
            );
        } finally {
            setIsSubmitting(false);
        }
    }, [canSubmit, isSubmitting, machineType, selectedMachineId, gatewayUrl, gatewayToken, machineName, router]);

    return (
        <View style={styles.container}>
            <ScrollView contentContainerStyle={styles.scrollContent}>
                {/* Machine Name */}
                <ItemGroup title={`${t('openclaw.sessionName')} (${t('common.optional')})`}>
                    <View style={styles.inputWrapper}>
                        <TextInput
                            style={styles.input}
                            value={machineName}
                            onChangeText={setMachineName}
                            placeholder="My OpenClaw"
                            placeholderTextColor={theme.colors.textSecondary}
                            autoCapitalize="words"
                            autoCorrect={false}
                        />
                    </View>
                </ItemGroup>

                {/* Connection Type */}
                <ItemGroup title={t('openclaw.machineType')}>
                    <Item
                        title={t('openclaw.machineTypeHappy')}
                        subtitle={t('openclaw.machineTypeHappyDescription')}
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
                        title={t('openclaw.machineTypeDirect')}
                        subtitle={t('openclaw.machineTypeDirectDescription')}
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
                    <>
                        <ItemGroup title={t('openclaw.selectMachine')}>
                            {machines.length === 0 ? (
                                <Item
                                    title={t('settings.machines')}
                                    subtitle={t('openclaw.noSessionsDescription')}
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

                        <ItemGroup title={`${t('openclaw.gatewayToken')} (${t('common.optional')})`}>
                            <View style={styles.inputWrapper}>
                                <TextInput
                                    style={styles.input}
                                    value={gatewayToken}
                                    onChangeText={setGatewayToken}
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

                {/* Direct Connection Config */}
                {machineType === 'direct' && (
                    <>
                        <ItemGroup title={t('openclaw.gatewayUrl')}>
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

                        <ItemGroup title={`${t('openclaw.gatewayToken')} (${t('common.optional')})`}>
                            <View style={styles.inputWrapper}>
                                <TextInput
                                    style={styles.input}
                                    value={gatewayToken}
                                    onChangeText={setGatewayToken}
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
                        <Text style={styles.submitButtonText}>{t('openclaw.addMachine')}</Text>
                    )}
                </Pressable>
            </ScrollView>
        </View>
    );
}
