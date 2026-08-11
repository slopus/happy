import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { TerminalView, type TerminalViewHandle } from '@/components/terminal/TerminalView';
import { MobileKeyboardBar } from '@/components/terminal/MobileKeyboardBar';
import {
    getTerminalConnectionPresentation,
    getTerminalNotices,
    type TerminalConnectionTone,
} from '@/components/terminal/terminalUiState';
import { useTerminalSession, type TerminalSessionCallbacks } from '@/hooks/useTerminalSession';
import {
    terminalApprove,
    terminalCreate,
} from '@/sync/terminalClient';

export default function RemoteTerminalScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const params = useLocalSearchParams<{
        id: string;
        machineId: string;
        name?: string;
        cwd?: string;
    }>();
    const terminalId = params.id;
    const machineId = params.machineId;
    const terminalName = params.name || 'Terminal';
    const terminalCwd = params.cwd || '';

    const viewRef = useRef<TerminalViewHandle>(null);
    const [truncated, setTruncated] = useState(false);
    const [keyboardVisible, setKeyboardVisible] = useState(Platform.OS !== 'web');
    const [isTakingControl, setIsTakingControl] = useState(false);
    const [isReopening, setIsReopening] = useState(false);
    const [dismissedNoticeKeys, setDismissedNoticeKeys] = useState<string[]>([]);

    const callbacksRef = useRef<TerminalSessionCallbacks>({
        onAttach: (result) => {
            setTruncated(result.truncated);
            viewRef.current?.clear();
            if (result.snapshot) {
                viewRef.current?.write(result.snapshot);
            }
            for (const frame of result.replayFrames) {
                viewRef.current?.write(frame.data);
            }
        },
        onOutput: (data) => viewRef.current?.write(data),
        onExit: () => undefined,
        onError: () => undefined,
        onWriter: () => undefined,
    });

    const {
        status,
        writerSocketId,
        isWriter,
        exitCode,
        error,
        sendInput,
        sendResize,
        takeControl,
        epochReset,
        controlReset,
    } = useTerminalSession(
        machineId!,
        terminalId!,
        callbacksRef.current,
    );

    const connectionPresentation = getTerminalConnectionPresentation(status, isWriter, error);
    const statusColor = getStatusColor(connectionPresentation.tone, theme.colors.button.primary.background);
    const notice = getTerminalNotices({ epochReset, controlReset, truncated })
        .find((candidate) => !dismissedNoticeKeys.includes(candidate.key));

    useEffect(() => {
        setDismissedNoticeKeys([]);
    }, [terminalId]);

    const handleTakeControl = async () => {
        if (isTakingControl) return;
        if (writerSocketId) {
            const confirmed = await Modal.confirm(
                'Take control of terminal?',
                'The current controller will become view-only.',
                { cancelText: t('common.cancel'), confirmText: 'Take Control' },
            );
            if (!confirmed) return;
        }

        setIsTakingControl(true);
        try {
            await takeControl();
        } catch (takeoverError) {
            Modal.alert(
                t('common.error'),
                takeoverError instanceof Error ? takeoverError.message : 'Failed to take control',
            );
        } finally {
            setIsTakingControl(false);
        }
    };

    const handleReopen = async () => {
        if (isReopening) return;
        setIsReopening(true);
        if (!machineId || !terminalCwd) {
            router.back();
            setIsReopening(false);
            return;
        }
        try {
            const result = await terminalCreate(machineId, {
                name: terminalName,
                cwd: terminalCwd,
                cols: 80,
                rows: 24,
            });
            if (result.type === 'success') {
                router.replace({
                    pathname: '/remote-terminal/[id]',
                    params: {
                        id: result.terminalId,
                        machineId,
                        name: terminalName,
                        cwd: terminalCwd,
                    },
                });
                return;
            }
            if (result.type === 'awaiting-approval') {
                const approved = await Modal.confirm(
                    'Open Remote Terminal?',
                    `This opens a persistent shell in ${terminalCwd}.`,
                    { cancelText: t('common.cancel'), confirmText: 'Approve' },
                );
                if (!approved) {
                    router.back();
                    return;
                }
                const approvedResult = await terminalApprove(machineId, result.approvalId);
                if (approvedResult.type === 'success') {
                    router.replace({
                        pathname: '/remote-terminal/[id]',
                        params: {
                            id: approvedResult.terminalId,
                            machineId,
                            name: terminalName,
                            cwd: terminalCwd,
                        },
                    });
                } else if (approvedResult.type === 'error') {
                    Modal.alert(t('common.error'), approvedResult.errorMessage);
                }
                return;
            }
            Modal.alert(t('common.error'), result.errorMessage);
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : 'Failed to reopen');
        } finally {
            setIsReopening(false);
        }
    };

    return (
        <View style={styles.container}>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: terminalName,
                    headerBackTitle: t('machine.back'),
                }}
            />

            <View style={[styles.statusBar, { borderBottomColor: theme.colors.divider }]}>
                <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                <Text style={[styles.statusText, { color: statusColor }]}>{connectionPresentation.label}</Text>
                {Platform.OS === 'web' && status === 'attached' && !isWriter && (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Take control of terminal"
                        disabled={isTakingControl}
                        onPress={() => void handleTakeControl()}
                        style={({ pressed }) => [
                            styles.takeControlButton,
                            { backgroundColor: theme.colors.button.primary.background },
                            pressed && !isTakingControl ? styles.buttonPressed : null,
                            isTakingControl ? styles.buttonDisabled : null,
                        ]}
                    >
                        {isTakingControl ? (
                            <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                        ) : (
                            <Text style={[styles.takeControlLabel, { color: theme.colors.button.primary.tint }]}>Take control</Text>
                        )}
                    </Pressable>
                )}
            </View>

            {notice && status === 'attached' && (
                <View style={[styles.noticeBar, { borderBottomColor: theme.colors.divider }]}>
                    <Ionicons name="warning-outline" size={17} color="#FF9F0A" />
                    <Text style={styles.noticeText}>{notice.message}</Text>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Dismiss terminal notice"
                        hitSlop={8}
                        onPress={() => setDismissedNoticeKeys((current) => [...current, notice.key])}
                        style={({ pressed }) => pressed ? styles.noticeDismissPressed : null}
                    >
                        <Ionicons name="close" size={18} color="#8b949e" />
                    </Pressable>
                </View>
            )}

            <View style={styles.terminalContainer}>
                <TerminalView
                    ref={viewRef}
                    onData={(data) => void sendInput(data)}
                    onResize={(cols, rows) => void sendResize(cols, rows)}
                    readOnly={!isWriter || status !== 'attached'}
                />
            </View>

            {status === 'exited' && (
                <View style={styles.exitedOverlay}>
                    <Ionicons name="close-circle-outline" size={44} color="#FF3B30" />
                    <Text style={styles.exitedTitle}>Session exited</Text>
                    <Text style={styles.exitedSubtitle}>
                        {typeof exitCode === 'number'
                            ? `The shell exited with code ${exitCode}.`
                            : 'The shell is no longer running on the machine.'}
                    </Text>
                    <Pressable
                        accessibilityRole="button"
                        disabled={isReopening}
                        onPress={() => void handleReopen()}
                        style={({ pressed }) => [
                            styles.exitedButton,
                            pressed && !isReopening ? styles.buttonPressed : null,
                            isReopening ? styles.buttonDisabled : null,
                        ]}
                    >
                        {isReopening ? (
                            <ActivityIndicator size="small" color="#ffffff" />
                        ) : (
                            <Text style={styles.exitedButtonLabel}>Reopen</Text>
                        )}
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        disabled={isReopening}
                        style={({ pressed }) => [
                            styles.exitedButtonSecondary,
                            pressed ? styles.secondaryButtonPressed : null,
                        ]}
                        onPress={() => router.back()}
                    >
                        <Text style={styles.exitedButtonSecondaryLabel}>Back to machine</Text>
                    </Pressable>
                </View>
            )}

            {Platform.OS !== 'web' && (
                <MobileKeyboardBar
                    visible={keyboardVisible && status === 'attached'}
                    readOnly={!isWriter}
                    takingControl={isTakingControl}
                    onTakeControl={() => void handleTakeControl()}
                    onKey={(data) => void sendInput(data)}
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: '#0d1117',
    },
    statusBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.groupped.background,
        gap: 8,
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    statusText: {
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, monospace',
    },
    takeControlButton: {
        minWidth: 108,
        height: 32,
        marginLeft: 'auto',
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 12,
    },
    takeControlLabel: {
        fontSize: 13,
        fontWeight: '600',
    },
    buttonPressed: {
        opacity: 0.92,
        transform: [{ scale: 0.97 }],
    },
    buttonDisabled: {
        opacity: 0.65,
    },
    noticeBar: {
        minHeight: 38,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        backgroundColor: '#161b22',
        gap: 8,
    },
    noticeText: {
        flex: 1,
        fontSize: 12,
        lineHeight: 17,
        color: '#c9d1d9',
    },
    noticeDismissPressed: {
        opacity: 0.55,
    },
    terminalContainer: {
        flex: 1,
        backgroundColor: '#0d1117',
    },
    exitedOverlay: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(13, 17, 23, 0.92)',
        paddingHorizontal: 32,
        gap: 8,
    },
    exitedTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: '#e6edf3',
        marginTop: 8,
    },
    exitedSubtitle: {
        fontSize: 14,
        color: '#8b949e',
        textAlign: 'center',
        marginBottom: 12,
    },
    exitedButton: {
        backgroundColor: '#238636',
        borderRadius: 8,
        minWidth: 128,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 28,
    },
    exitedButtonLabel: {
        color: '#ffffff',
        fontSize: 15,
        fontWeight: '600',
    },
    exitedButtonSecondary: {
        paddingVertical: 10,
        paddingHorizontal: 12,
    },
    secondaryButtonPressed: {
        opacity: 0.6,
    },
    exitedButtonSecondaryLabel: {
        color: '#8b949e',
        fontSize: 14,
    },
}));

function getStatusColor(tone: TerminalConnectionTone, infoColor: string): string {
    switch (tone) {
        case 'success': return '#34C759';
        case 'info': return infoColor;
        case 'warning': return '#FF9F0A';
        case 'danger': return '#FF3B30';
    }
}
