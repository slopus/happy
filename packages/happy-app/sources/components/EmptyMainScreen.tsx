import React from 'react';
import { View, Text, Platform, Pressable } from 'react-native';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/RoundButton';
import { useUnifiedScanner } from '@/hooks/useUnifiedScanner';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { getEmptyMainScreenMode } from '@/utils/emptyMainScreenMode';
import { useRouter } from 'expo-router';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 32,
    },
    title: {
        marginBottom: 16,
        textAlign: 'center',
        fontSize: 24,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    startSessionTitle: {
        textAlign: 'center',
        fontSize: 24,
        lineHeight: 38,
        color: theme.colors.text,
        marginBottom: 12,
        ...Typography.default('semiBold'),
    },
    startSessionDescription: {
        textAlign: 'center',
        fontSize: 16,
        color: theme.colors.textSecondary,
        marginHorizontal: 36,
        marginBottom: 28,
        ...Typography.default(),
    },
    terminalBlock: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        padding: 20,
        marginHorizontal: 24,
        marginBottom: 20,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    terminalText: {
        ...Typography.mono(),
        fontSize: 16,
        color: theme.colors.status.connected,
    },
    terminalTextFirst: {
        marginBottom: 8,
    },
    stepsContainer: {
        marginTop: 12,
        marginHorizontal: 24,
        marginBottom: 48,
        width: 250,
    },
    stepRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 8,
    },
    stepRowLast: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    stepNumber: {
        width: 24,
        height: 24,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    stepNumberText: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
    },
    stepText: {
        ...Typography.default(),
        fontSize: 18,
        color: theme.colors.textSecondary,
    },
    buttonsContainer: {
        alignItems: 'center',
        width: '100%',
    },
    buttonWrapper: {
        width: 240,
        marginBottom: 12,
    },
    buttonWrapperSecondary: {
        width: 240,
    },
    startSessionButton: {
        width: 240,
        height: 48,
        borderRadius: 24,
        backgroundColor: theme.colors.button.primary.background,
        alignItems: 'center',
        justifyContent: 'center',
    },
    startSessionButtonPressed: {
        opacity: 0.9,
    },
    startSessionButtonText: {
        ...Typography.default('semiBold'),
        fontSize: 20,
        lineHeight: 48,
        color: theme.colors.button.primary.tint,
        includeFontPadding: false,
    },
}));

export function EmptyMainScreen() {
    const router = useRouter();
    const { launchScanner, connectWithUrl, isLoading } = useUnifiedScanner();
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const machines = useAllMachines();

    const mode = React.useMemo(() => {
        const hasOnlineMachines = machines.some(machine => isMachineOnline(machine));
        return getEmptyMainScreenMode(hasOnlineMachines);
    }, [machines]);

    return (
        <View style={styles.container}>
            {mode === 'start-session' ? (
                <>
                    <Text style={styles.startSessionTitle}>
                        {t('components.emptySessions.noActiveSessions')}
                    </Text>
                    <Text style={styles.startSessionDescription}>
                        {t('components.emptySessions.startOnConnectedMachines')}
                    </Text>
                    <View style={styles.buttonsContainer}>
                        <Pressable
                            style={({ pressed }) => [
                                styles.startSessionButton,
                                pressed && styles.startSessionButtonPressed,
                            ]}
                            onPress={() => router.push('/new')}
                        >
                            <Text style={styles.startSessionButtonText}>
                                {t('components.emptySessions.startNewSession')}
                            </Text>
                        </Pressable>
                    </View>
                </>
            ) : (
                <>
                    {/* Terminal-style code block */}
                    <Text style={styles.title}>{t('components.emptyMainScreen.readyToCode')}</Text>
                    <View style={styles.terminalBlock}>
                        <Text style={[styles.terminalText, styles.terminalTextFirst]}>
                            $ npm i -g happy-next-cli
                        </Text>
                        <Text style={styles.terminalText}>
                            $ happy
                        </Text>
                    </View>
                    {Platform.OS !== 'web' && (
                        <>
                            <View style={styles.stepsContainer}>
                                <View style={styles.stepRow}>
                                    <View style={styles.stepNumber}>
                                        <Text style={styles.stepNumberText}>1</Text>
                                    </View>
                                    <Text style={styles.stepText}>
                                        {t('components.emptyMainScreen.installCli')}
                                    </Text>
                                </View>
                                <View style={styles.stepRow}>
                                    <View style={styles.stepNumber}>
                                        <Text style={styles.stepNumberText}>2</Text>
                                    </View>
                                    <Text style={styles.stepText}>
                                        {t('components.emptyMainScreen.runIt')}
                                    </Text>
                                </View>
                                <View style={styles.stepRowLast}>
                                    <View style={styles.stepNumber}>
                                        <Text style={styles.stepNumberText}>3</Text>
                                    </View>
                                    <Text style={styles.stepText}>
                                        {t('components.emptyMainScreen.scanQrCode')}
                                    </Text>
                                </View>
                            </View>
                            <View style={styles.buttonsContainer}>
                                <View style={styles.buttonWrapper}>
                                    <RoundButton
                                        title={t('components.emptyMainScreen.openCamera')}
                                        size="large"
                                        loading={isLoading}
                                        onPress={launchScanner}
                                    />
                                </View>
                                <View style={styles.buttonWrapperSecondary}>
                                    <RoundButton
                                        title={t('connect.enterUrlManually')}
                                        size="normal"
                                        display="inverted"
                                        onPress={async () => {
                                            const url = await Modal.prompt(
                                                t('modals.scanOrPasteUrl'),
                                                t('modals.pasteUrlFromTerminalOrDevice'),
                                                {
                                                    placeholder: 'happy://...',
                                                    cancelText: t('common.cancel'),
                                                    confirmText: t('common.authenticate')
                                                }
                                            );

                                            if (url?.trim()) {
                                                connectWithUrl(url.trim());
                                            }
                                        }}
                                    />
                                </View>
                            </View>
                        </>
                    )}
                </>
            )}
        </View>
    );
}
