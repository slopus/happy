import React, { useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { TerminalView, type TerminalViewHandle } from '@/components/terminal/TerminalView';
import { MobileKeyboardBar } from '@/components/terminal/MobileKeyboardBar';
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
    const [sessionError, setSessionError] = useState<string | null>(null);
    const [keyboardVisible, setKeyboardVisible] = useState(Platform.OS !== 'web');

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
        onError: (message) => setSessionError(message),
        onWriter: () => undefined,
    });

    const {
        status,
        isWriter,
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

    const statusLabel = (() => {
        switch (status) {
            case 'connecting': return 'Connecting…';
            case 'attached': return isWriter ? 'Connected' : 'View only';
            case 'reconnecting': return 'Reconnecting…';
            case 'exited': return 'Session exited';
            case 'error': return sessionError || 'Connection error';
            case 'detached': return 'Detached';
        }
    })();

    const statusColor = status === 'attached'
        ? isWriter ? '#34C759' : '#FF9F0A'
        : status === 'reconnecting' || status === 'connecting'
            ? '#FF9F0A'
            : '#FF3B30';

    const handleReopen = async () => {
        if (!machineId || !terminalCwd) {
            router.back();
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
        }
    };

    return (
        <View style={styles.container}>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: terminalName,
                    headerBackTitle: t('machine.back'),
                    headerRight: () => status === 'attached' && !isWriter ? (
                        <Pressable onPress={takeControl} hitSlop={10}>
                            <Ionicons name="hand-left-outline" size={22} color={theme.colors.text} />
                        </Pressable>
                    ) : null,
                }}
            />

            <View style={[styles.statusBar, { borderBottomColor: theme.colors.divider }]}>
                <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
                {epochReset && status === 'attached' && (
                    <Text style={styles.epochResetText}>Daemon restarted; unsent input dropped</Text>
                )}
                {controlReset && status === 'attached' && !epochReset && (
                    <Text style={styles.epochResetText}>Input queue reset; unsent input dropped</Text>
                )}
                {truncated && (
                    <Text style={styles.truncatedText}>Output was truncated while you were away</Text>
                )}
            </View>

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
                        The shell is no longer running on the machine.
                    </Text>
                    <Pressable style={styles.exitedButton} onPress={handleReopen}>
                        <Text style={styles.exitedButtonLabel}>Reopen</Text>
                    </Pressable>
                    <Pressable style={styles.exitedButtonSecondary} onPress={() => router.back()}>
                        <Text style={styles.exitedButtonSecondaryLabel}>Back to machine</Text>
                    </Pressable>
                </View>
            )}

            {Platform.OS !== 'web' && (
                <MobileKeyboardBar
                    visible={keyboardVisible && status === 'attached' && isWriter}
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
    truncatedText: {
        flex: 1,
        textAlign: 'right',
        fontSize: 12,
        color: '#FF9F0A',
    },
    epochResetText: {
        flex: 1,
        textAlign: 'right',
        fontSize: 12,
        color: '#FF9F0A',
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
        paddingHorizontal: 28,
        paddingVertical: 12,
    },
    exitedButtonLabel: {
        color: '#ffffff',
        fontSize: 15,
        fontWeight: '600',
    },
    exitedButtonSecondary: {
        paddingVertical: 10,
    },
    exitedButtonSecondaryLabel: {
        color: '#8b949e',
        fontSize: 14,
    },
}));
