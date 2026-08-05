import React from 'react';
import { View, Text, Platform, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/RoundButton';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

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
    terminalBlock: {
        backgroundColor: Platform.select({ web: theme.colors.surfaceHighest, default: theme.colors.surfaceHigh }),
        borderRadius: Platform.select({ web: 8, default: 12 }),
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
        backgroundColor: Platform.select({ web: theme.colors.surfaceHigh, default: theme.colors.surfaceHighest }),
        borderWidth: Platform.OS === 'web' ? 0 : 1,
        borderColor: theme.colors.divider,
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
    manualUrlButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        minHeight: 40,
        paddingHorizontal: 14,
        borderRadius: 20,
    },
    manualUrlButtonPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    manualUrlButtonText: {
        fontSize: 15,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
}));

export function EmptyMainScreen() {
    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const enterUrlManually = React.useCallback(async () => {
        const url = await Modal.prompt(
            t('modals.authenticateTerminal'),
            t('modals.pasteUrlFromTerminal'),
            {
                placeholder: 'happy://terminal?...',
                cancelText: t('common.cancel'),
                confirmText: t('common.authenticate'),
            },
        );

        if (url?.trim()) {
            connectWithUrl(url.trim());
        }
    }, [connectWithUrl]);

    return (
        <View style={styles.container}>
            {/* Terminal-style code block */}
            <Text style={styles.title}>{t('components.emptyMainScreen.readyToCode')}</Text>
            <View style={styles.terminalBlock}>
                <Text style={[styles.terminalText, styles.terminalTextFirst]}>
                    $ npm i -g happy
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
                                onPress={connectTerminal}
                            />
                        </View>
                        <Pressable
                            onPress={enterUrlManually}
                            accessibilityRole="button"
                            accessibilityLabel={t('connect.enterUrlManually')}
                            style={({ pressed }) => [
                                styles.manualUrlButton,
                                pressed && styles.manualUrlButtonPressed,
                            ]}
                        >
                            <Ionicons name="link-outline" size={17} color={theme.colors.textSecondary} />
                            <Text style={styles.manualUrlButtonText}>
                                {t('connect.enterUrlManually')}
                            </Text>
                        </Pressable>
                    </View>
                </>
            )}
        </View>
    );
}
