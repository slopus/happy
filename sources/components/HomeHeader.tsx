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
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    headerButton: {
        marginRight: 8,
        width: 24,
        height: 24,
    },
    iconButton: {
        color: theme.colors.header.tint,
    },
    logoContainer: {
        marginLeft: 8,
        tintColor: theme.colors.header.tint,
    },
    titleContainer: {
        alignItems: 'center',
    },
    titleText: {
        fontSize: 17,
        color: theme.colors.header.tint,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    subtitleText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
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
        color: theme.colors.status.connected,
    },
    statusConnecting: {
        color: theme.colors.status.connecting,
    },
    statusDisconnected: {
        color: theme.colors.status.disconnected,
    },
    statusError: {
        color: theme.colors.status.error,
    },
    statusDefault: {
        color: theme.colors.status.default,
    },
}));


export const HomeHeader = React.memo(() => {
    const { theme } = useUnistyles();
    return (
        <View style={{ backgroundColor: theme.colors.groupped.background }}>
            <Header
                title={<HeaderTitleWithSubtitle />}
                headerRight={() => <HeaderRight />}
                headerLeft={() => <HeaderLeft />}
                headerShadowVisible={false}
                headerTransparent={true}
            />
        </View>
    )
})

export const HomeHeaderNotAuth = React.memo(() => {
    useSegments(); // Re-rendered automatically when screen navigates back
    const serverInfo = getServerInfo();
    const { theme } = useUnistyles();
    return (
        <Header
            title={<HeaderTitleWithSubtitle subtitle={serverInfo.isCustom ? serverInfo.hostname + (serverInfo.port ? `:${serverInfo.port}` : '') : undefined} />}
            headerRight={() => <HeaderRightNotAuth />}
            headerLeft={() => <HeaderLeft />}
            headerShadowVisible={false}
            headerBackgroundColor={theme.colors.groupped.background}
        />
    )
});

function HeaderRight() {
    const router = useRouter();
    const styles = stylesheet;
    const { theme } = useUnistyles();

    // return (
    //     <Pressable
    //         onPress={() => router.push('/settings')}
    //         hitSlop={15}
    //         style={styles.headerButton}
    //     >
    //         <Ionicons name="settings-outline" size={24} color={theme.colors.header.tint} />
    //     </Pressable>
    // );
    return (
        <Pressable
            onPress={() => router.push('/settings')}
            hitSlop={15}
            style={styles.headerButton}
        >
            <Image
                source={require('@/assets/images/brutalist/Brutalism 9.png')}
                contentFit="contain"
                style={[{ width: 32, height: 32, marginRight: 12, marginTop: -2 }]}
                tintColor={theme.colors.header.tint}
            />
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
            <Ionicons name="server-outline" size={24} color={theme.colors.header.tint} />
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
            tintColor={theme.colors.header.tint}
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
                    text: t('status.connected'),
                    textColor: styles.statusConnected.color
                };
            case 'connecting':
                return {
                    color: styles.statusConnecting.color,
                    isPulsing: true,
                    text: t('status.connecting'),
                    textColor: styles.statusConnecting.color
                };
            case 'disconnected':
                return {
                    color: styles.statusDisconnected.color,
                    isPulsing: false,
                    text: t('status.disconnected'),
                    textColor: styles.statusDisconnected.color
                };
            case 'error':
                return {
                    color: styles.statusError.color,
                    isPulsing: false,
                    text: t('status.error'),
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
                {t('sidebar.sessionsTitle')}
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