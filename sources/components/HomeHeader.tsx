import * as React from 'react';
import { Header } from './navigation/Header';
import { useSocketStatus } from '@/sync/storage';
import { Pressable, Text, View } from 'react-native';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useSegments } from 'expo-router';
import { getServerInfo } from '@/sync/serverConfig';


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
    return (
        <Pressable
            onPress={() => router.push('/settings')}
            hitSlop={15}
            style={{ marginRight: 8, width: 24, height: 24 }}
        >
            <Ionicons name="settings-outline" size={24} color="#000" />
        </Pressable>
    );
}

function HeaderRightNotAuth() {
    const router = useRouter();

    return (
        <Pressable
            onPress={() => router.push('/server')}
            hitSlop={15}
            style={{ marginRight: 8, width: 24, height: 24 }}
        >
            <Ionicons name="server-outline" size={24} color="#000" />
        </Pressable>
    );
}

function HeaderLeft() {
    return (
        <View
            style={{ marginLeft: 8, width: 24, height: 24 }}
        />
    );
}

function HeaderTitleWithSubtitle({ subtitle }: { subtitle?: string }) {
    const socketStatus = useSocketStatus();

    // Get connection status styling (matching sessionUtils.ts pattern)
    const getConnectionStatus = () => {
        const { status } = socketStatus;
        switch (status) {
            case 'connected':
                return {
                    color: '#34C759',
                    isPulsing: false,
                    text: 'connected',
                    textColor: '#34C759'
                };
            case 'connecting':
                return {
                    color: '#007AFF',
                    isPulsing: true,
                    text: 'connecting',
                    textColor: '#007AFF'
                };
            case 'disconnected':
                return {
                    color: '#999',
                    isPulsing: false,
                    text: 'disconnected',
                    textColor: '#999'
                };
            case 'error':
                return {
                    color: '#FF3B30',
                    isPulsing: false,
                    text: 'connection error',
                    textColor: '#FF3B30'
                };
            default:
                return {
                    color: '#8E8E93',
                    isPulsing: false,
                    text: '',
                    textColor: '#8E8E93'
                };
        }
    };

    const hasCustomSubtitle = !!subtitle;
    const connectionStatus = getConnectionStatus();
    const showConnectionStatus = !hasCustomSubtitle && connectionStatus.text;
    const titleFontSize = (hasCustomSubtitle || showConnectionStatus) ? 20 : 24;

    return (
        <View style={{ alignItems: 'center' }}>
            <Text style={{ fontSize: titleFontSize, color: '#000', ...Typography.logo() }}>
                Happy
            </Text>
            {hasCustomSubtitle && (
                <Text style={{ fontSize: 12, color: '#8E8E93', marginTop: 2 }}>
                    {subtitle}
                </Text>
            )}
            {showConnectionStatus && (
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                    <StatusDot
                        color={connectionStatus.color}
                        isPulsing={connectionStatus.isPulsing}
                        size={6}
                        style={{ marginRight: 4 }}
                    />
                    <Text style={{
                        fontSize: 12,
                        color: connectionStatus.textColor,
                        fontWeight: '500',
                        lineHeight: 16,
                        ...Typography.default()
                    }}>
                        {connectionStatus.text}
                    </Text>
                </View>
            )}
        </View>
    );
}