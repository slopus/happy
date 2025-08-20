import * as React from 'react';
import { Header } from './navigation/Header';
import { useSocketStatus } from '@/sync/storage';
import { Pressable, Text, View } from 'react-native';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useSegments } from 'expo-router';
import { getServerInfo } from '@/sync/serverConfig';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    headerButton: {
        marginRight: 8,
        width: 24,
        height: 24,
    },
    iconButton: {
        color: theme.colors.headerTint,
    },
    logoContainer: {
        marginLeft: 8,
        tintColor: theme.colors.headerTint,
    },
    titleContainer: {
        alignItems: 'center',
    },
    titleText: {
        fontSize: 17,
        color: theme.colors.headerTint,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    subtitleText: {
        fontSize: 12,
        color: theme.colors.subtitleText,
        marginTop: -2,
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -2,
    },
    statusDot: {
        marginRight: 4,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
    },
    // Status colors
    statusConnected: {
        color: theme.colors.statusConnected,
    },
    statusConnecting: {
        color: theme.colors.statusConnecting,
    },
    statusDisconnected: {
        color: theme.colors.statusDisconnected,
    },
    statusError: {
        color: theme.colors.statusError,
    },
    statusDefault: {
        color: theme.colors.statusDefault,
    },
}));


export const HomeHeader = React.memo(() => {
    return (
        <Header
            title={<HeaderTitleWithSubtitle />}
            headerRight={() => <HeaderRight />}
            headerLeft={() => <HeaderLeft />}
            headerShadowVisible={false}
        />
    )
})

export const HomeHeaderNotAuth = React.memo(() => {
    useSegments(); // Re-rendered automatically when screen navigates back
    const serverInfo = getServerInfo();
    return (
        <Header
            title={<HeaderTitleWithSubtitle subtitle={serverInfo.isCustom ? serverInfo.hostname + (serverInfo.port ? `:${serverInfo.port}` : '') : undefined} />}
            headerRight={() => <HeaderRightNotAuth />}
            headerLeft={() => <HeaderLeft />}
            headerShadowVisible={false}
        />
    )
});

function HeaderRight() {
    const router = useRouter();
    const styles = stylesheet;
    const { theme } = useUnistyles();

    return (
        <Pressable
            onPress={() => router.push('/settings')}
            hitSlop={15}
            style={styles.headerButton}
        >
            <Ionicons name="settings-outline" size={24} color={theme.colors.headerTint} />
        </Pressable>
    );
}

function HeaderRightNotAuth() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const styles = stylesheet;
    

    return (
        <Pressable
            onPress={() => router.push('/server')}
            hitSlop={15}
            style={styles.headerButton}
        >
            <Ionicons name="server-outline" size={24} color={theme.colors.headerTint} />
        </Pressable>
    );
}

function HeaderLeft() {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <Image
            source={require('@/assets/images/logo-black.png')}
            contentFit="contain"
            style={[{ width: 24, height: 24 }, styles.logoContainer]}
            tintColor={theme.colors.headerTint}
        />
    );
}

function HeaderTitleWithSubtitle({ subtitle }: { subtitle?: string }) {
    const socketStatus = useSocketStatus();
    const styles = stylesheet;

    // Get connection status styling (matching sessionUtils.ts pattern)
    const getConnectionStatus = () => {
        const { status } = socketStatus;
        switch (status) {
            case 'connected':
                return {
                    color: styles.statusConnected.color,
                    isPulsing: false,
                    text: 'connected',
                    textColor: styles.statusConnected.color
                };
            case 'connecting':
                return {
                    color: styles.statusConnecting.color,
                    isPulsing: true,
                    text: 'connecting',
                    textColor: styles.statusConnecting.color
                };
            case 'disconnected':
                return {
                    color: styles.statusDisconnected.color,
                    isPulsing: false,
                    text: 'disconnected',
                    textColor: styles.statusDisconnected.color
                };
            case 'error':
                return {
                    color: styles.statusError.color,
                    isPulsing: false,
                    text: 'connection error',
                    textColor: styles.statusError.color
                };
            default:
                return {
                    color: styles.statusDefault.color,
                    isPulsing: false,
                    text: '',
                    textColor: styles.statusDefault.color
                };
        }
    };

    const hasCustomSubtitle = !!subtitle;
    const connectionStatus = getConnectionStatus();
    const showConnectionStatus = !hasCustomSubtitle && connectionStatus.text;

    return (
        <View style={styles.titleContainer}>
            <Text style={styles.titleText}>
                Sessions
            </Text>
            {hasCustomSubtitle && (
                <Text style={styles.subtitleText}>
                    {subtitle}
                </Text>
            )}
            {showConnectionStatus && (
                <View style={styles.statusContainer}>
                    <StatusDot
                        color={connectionStatus.color}
                        isPulsing={connectionStatus.isPulsing}
                        size={6}
                        style={styles.statusDot}
                    />
                    <Text style={[
                        styles.statusText,
                        { color: connectionStatus.textColor }
                    ]}>
                        {connectionStatus.text}
                    </Text>
                </View>
            )}
        </View>
    );
}