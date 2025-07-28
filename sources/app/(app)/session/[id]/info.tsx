import React, { useMemo, useCallback } from 'react';
import { View, Text, Alert, Pressable, Platform, Animated } from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Avatar } from '@/components/Avatar';
import { useSession } from '@/sync/storage';
import { getSessionName, getSessionState, formatOSPlatform } from '@/utils/sessionUtils';
import * as Clipboard from 'expo-clipboard';

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
    const router = useRouter();
    const { id } = useLocalSearchParams<{ id: string }>();
    const session = useSession(id);

    if (!session) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#8E8E93', fontSize: 17 }}>Session not found</Text>
            </View>
        );
    }

    const sessionName = getSessionName(session);
    const sessionStatus = getSessionState(session);

    const handleCopySessionId = async () => {
        try {
            await Clipboard.setStringAsync(session.id);
            Alert.alert('Success', 'Session ID copied to clipboard');
        } catch (error) {
            Alert.alert('Error', 'Failed to copy session ID');
        }
    };

    const handleCopyMetadata = async () => {
        if (session.metadata) {
            try {
                await Clipboard.setStringAsync(JSON.stringify(session.metadata, null, 2));
                Alert.alert('Success', 'Metadata copied to clipboard');
            } catch (error) {
                Alert.alert('Error', 'Failed to copy metadata');
            }
        }
    };

    const formatDate = (timestamp: number) => {
        return new Date(timestamp).toLocaleString();
    };

    const handleClose = useCallback(() => {
        router.back();
    }, [router]);

    const screenOptions = {
        // headerShown: true,
        headerTitle: 'Session Info',
        headerStyle: {
            backgroundColor: 'white',
        },
        headerTintColor: '#000',
        headerTitleStyle: {
            color: '#000',
            fontSize: 17,
            fontWeight: '600' as const,
        },
        headerRight: Platform.OS === 'ios' ? () => (
            <Pressable onPress={handleClose} hitSlop={10}>
                <Ionicons name="close" size={24} color="#000" />
            </Pressable>
        ) : undefined,
    };

    return (
        <>
            <Stack.Screen options={screenOptions} />

            <ItemList>
                {/* Session Header */}
                <View style={{ alignItems: 'center', paddingVertical: 24, backgroundColor: 'white', marginBottom: 35 }}>
                    <Avatar id={session.id} size={80} monochrome={!sessionStatus.isConnected} />
                    <Text style={{
                        fontSize: 20,
                        fontWeight: '600',
                        marginTop: 12,
                        textAlign: 'center',
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
                            {sessionStatus.shouldShowStatus ? sessionStatus.statusText : 'active'}
                        </Text>
                    </View>
                </View>

                {/* Session Details */}
                <ItemGroup title="Session Details">
                    <Item
                        title="Session ID"
                        subtitle={`${session.id.substring(0, 8)}...${session.id.substring(session.id.length - 8)}`}
                        icon={<Ionicons name="finger-print-outline" size={29} color="#007AFF" />}
                        onPress={handleCopySessionId}
                    />
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
                            subtitle={session.metadata.path}
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
                    {session.lastMessage && (
                        <Item
                            title="Last Message"
                            subtitle={`${session.lastMessage.role === 'user' ? 'You' : 'Claude'} • ${formatDate(session.lastMessage.createdAt)}`}
                            icon={<Ionicons name="chatbubble-outline" size={29} color="#007AFF" />}
                            onPress={() => router.push(`/session/${id}`)}
                        />
                    )}
                </ItemGroup>
            </ItemList>
        </>
    );
});