import React, { useMemo, useCallback } from 'react';
import { View, Text, Pressable, Platform, Animated } from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Avatar } from '@/components/Avatar';
import { useSession } from '@/sync/storage';
import { getSessionName, useSessionStatus, formatOSPlatform, formatPathRelativeToHome, getSessionAvatarId } from '@/utils/sessionUtils';
import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import { sessionKill } from '@/sync/ops';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';

// Animated status dot component
function StatusDot({ color, isPulsing, size = 8 }: { color: string; isPulsing?: boolean; size?: number }) {
    const pulseAnim = React.useRef(new Animated.Value(1)).current;

    React.useEffect(() => {
        if (isPulsing) {
            Animated.loop(
                Animated.sequence([
                    Animated.timing(pulseAnim, {
                        toValue: 0.3,
                        duration: 1000,
                        useNativeDriver: true,
                    }),
                    Animated.timing(pulseAnim, {
                        toValue: 1,
                        duration: 1000,
                        useNativeDriver: true,
                    }),
                ])
            ).start();
        } else {
            pulseAnim.setValue(1);
        }
    }, [isPulsing, pulseAnim]);

    return (
        <Animated.View
            style={{
                width: size,
                height: size,
                borderRadius: size / 2,
                backgroundColor: color,
                opacity: pulseAnim,
                marginRight: 4,
            }}
        />
    );
}

export default React.memo(() => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { id } = useLocalSearchParams<{ id: string }>();
    const session = useSession(id);

    const handleClose = useCallback(() => {
        router.back();
    }, [router]);

    const handleCopySessionId = useCallback(async () => {
        if (!session) return;
        try {
            await Clipboard.setStringAsync(session.id);
            Modal.alert('Success', 'Happy Session ID copied to clipboard');
        } catch (error) {
            Modal.alert('Error', 'Failed to copy Happy Session ID');
        }
    }, [session]);

    const handleCopyMetadata = useCallback(async () => {
        if (!session?.metadata) return;
        try {
            await Clipboard.setStringAsync(JSON.stringify(session.metadata, null, 2));
            Modal.alert('Success', 'Metadata copied to clipboard');
        } catch (error) {
            Modal.alert('Error', 'Failed to copy metadata');
        }
    }, [session]);

    const handleKillSession = useCallback(async () => {
        if (!session) return;

        Modal.alert(
            'Kill Session',
            'Are you sure you want to terminate this session? This will immediately stop the session process.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Kill Session',
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            const result = await sessionKill(session.id);
                            if (result.success) {
                                Modal.alert('Success', result.message);
                                router.back(); // Go back after killing session
                            } else {
                                Modal.alert('Error', result.message || 'Failed to kill session');
                            }
                        } catch (error) {
                            Modal.alert('Error', error instanceof Error ? error.message : 'Failed to kill session');
                        }
                    }
                }
            ]
        );
    }, [session, router]);

    const formatDate = useCallback((timestamp: number) => {
        return new Date(timestamp).toLocaleString();
    }, []);

    if (!session) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 17, ...Typography.default('semiBold') }}>Session not found</Text>
            </View>
        );
    }

    const sessionName = getSessionName(session);
    const sessionStatus = useSessionStatus(session);

    return (
        <>
            <ItemList>
                {/* Session Header */}
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                    <View style={{ alignItems: 'center', paddingVertical: 24, backgroundColor: theme.colors.surface, marginBottom: 8, borderRadius: 12, marginHorizontal: 16, marginTop: 16 }}>
                        <Avatar id={getSessionAvatarId(session)} size={80} monochrome={!sessionStatus.isConnected} />
                        <Text style={{
                            fontSize: 20,
                            fontWeight: '600',
                            marginTop: 12,
                            textAlign: 'center',
                            color: theme.colors.text,
                            ...Typography.default('semiBold')
                        }}>
                            {sessionName}
                        </Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
                            <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} size={10} />
                            <Text style={{
                                fontSize: 15,
                                color: sessionStatus.statusColor,
                                fontWeight: '500',
                                ...Typography.default()
                            }}>
                                {sessionStatus.statusText}
                            </Text>
                        </View>
                    </View>
                </View>

                {/* Quick Actions */}
                <ItemGroup title="Quick Actions">
                    {sessionStatus.isConnected && (
                        <Item
                            title="Kill Session"
                            subtitle="Immediately terminate the session"
                            icon={<Ionicons name="skull-outline" size={29} color="#FF3B30" />}
                            onPress={handleKillSession}
                        />
                    )}
                    {session.metadata?.machineId && (
                        <Item
                            title="View Machine"
                            subtitle="View machine details and sessions"
                            icon={<Ionicons name="server-outline" size={29} color="#007AFF" />}
                            onPress={() => router.push(`/machine/${session.metadata?.machineId}`)}
                        />
                    )}
                </ItemGroup>

                {/* Session Details */}
                <ItemGroup>
                    <Item
                        title="Happy Session ID"
                        subtitle={`${session.id.substring(0, 8)}...${session.id.substring(session.id.length - 8)}`}
                        icon={<Ionicons name="finger-print-outline" size={29} color="#007AFF" />}
                        onPress={handleCopySessionId}
                    />
                    {session.metadata?.claudeSessionId && (
                        <Item
                            title="Claude Code Session ID"
                            subtitle={`${session.metadata.claudeSessionId.substring(0, 8)}...${session.metadata.claudeSessionId.substring(session.metadata.claudeSessionId.length - 8)}`}
                            icon={<Ionicons name="code-outline" size={29} color="#9C27B0" />}
                            onPress={async () => {
                                try {g
                                    await Clipboard.setStringAsync(session.metadata!.claudeSessionId!);
                                    Modal.alert('Success', 'Claude Code Session ID copied to clipboard');
                                } catch (error) {
                                    Modal.alert('Error', 'Failed to copy Claude Code Session ID');
                                }
                            }}
                        />
                    )}
                    <Item
                        title="Connection Status"
                        detail={sessionStatus.isConnected ? "Connected" : "Disconnected"}
                        icon={<Ionicons name="pulse-outline" size={29} color={sessionStatus.isConnected ? "#34C759" : "#8E8E93"} />}
                        showChevron={false}
                    />
                    <Item
                        title="Created"
                        subtitle={formatDate(session.createdAt)}
                        icon={<Ionicons name="calendar-outline" size={29} color="#007AFF" />}
                        showChevron={false}
                    />
                    <Item
                        title="Last Updated"
                        subtitle={formatDate(session.updatedAt)}
                        icon={<Ionicons name="time-outline" size={29} color="#007AFF" />}
                        showChevron={false}
                    />
                    <Item
                        title="Sequence"
                        detail={session.seq.toString()}
                        icon={<Ionicons name="git-commit-outline" size={29} color="#007AFF" />}
                        showChevron={false}
                    />
                </ItemGroup>

                {/* Metadata */}
                {session.metadata && (
                    <ItemGroup title="Metadata">
                        <Item
                            title="Host"
                            subtitle={session.metadata.host}
                            icon={<Ionicons name="desktop-outline" size={29} color="#5856D6" />}
                            showChevron={false}
                        />
                        <Item
                            title="Path"
                            subtitle={formatPathRelativeToHome(session.metadata.path, session.metadata.homeDir)}
                            icon={<Ionicons name="folder-outline" size={29} color="#5856D6" />}
                            showChevron={false}
                        />
                        {session.metadata.version && (
                            <Item
                                title="Version"
                                subtitle={session.metadata.version}
                                icon={<Ionicons name="git-branch-outline" size={29} color="#5856D6" />}
                                showChevron={false}
                            />
                        )}
                        {session.metadata.os && (
                            <Item
                                title="Operating System"
                                subtitle={formatOSPlatform(session.metadata.os)}
                                icon={<Ionicons name="hardware-chip-outline" size={29} color="#5856D6" />}
                                showChevron={false}
                            />
                        )}
                        {session.metadata.hostPid && (
                            <Item
                                title="Process ID"
                                subtitle={session.metadata.hostPid.toString()}
                                icon={<Ionicons name="terminal-outline" size={29} color="#5856D6" />}
                                showChevron={false}
                            />
                        )}
                        {session.metadata.happyHomeDir && (
                            <Item
                                title="Happy Home"
                                subtitle={formatPathRelativeToHome(session.metadata.happyHomeDir, session.metadata.homeDir)}
                                icon={<Ionicons name="home-outline" size={29} color="#5856D6" />}
                                showChevron={false}
                            />
                        )}
                        <Item
                            title="Copy Metadata"
                            icon={<Ionicons name="copy-outline" size={29} color="#007AFF" />}
                            onPress={handleCopyMetadata}
                        />
                    </ItemGroup>
                )}

                {/* Agent State */}
                {session.agentState && (
                    <ItemGroup title="Agent State">
                        <Item
                            title="Controlled by User"
                            detail={session.agentState.controlledByUser ? "Yes" : "No"}
                            icon={<Ionicons name="person-outline" size={29} color="#FF9500" />}
                            showChevron={false}
                        />
                        {session.agentState.requests && Object.keys(session.agentState.requests).length > 0 && (
                            <Item
                                title="Pending Requests"
                                detail={Object.keys(session.agentState.requests).length.toString()}
                                icon={<Ionicons name="hourglass-outline" size={29} color="#FF9500" />}
                                showChevron={false}
                            />
                        )}
                    </ItemGroup>
                )}

                {/* Activity */}
                <ItemGroup title="Activity">
                    <Item
                        title="Thinking"
                        detail={session.thinking ? "Yes" : "No"}
                        icon={<Ionicons name="bulb-outline" size={29} color={session.thinking ? "#FFCC00" : "#8E8E93"} />}
                        showChevron={false}
                    />
                    {session.thinking && (
                        <Item
                            title="Thinking Since"
                            subtitle={formatDate(session.thinkingAt)}
                            icon={<Ionicons name="timer-outline" size={29} color="#FFCC00" />}
                            showChevron={false}
                        />
                    )}
                </ItemGroup>
            </ItemList>
        </>
    );
});