import * as React from 'react';
import { View, Pressable, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Header } from './navigation/Header';
import { SettingsView } from './SettingsView';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { isUsingCustomServer } from '@/sync/serverConfig';
import { useSocketStatus } from '@/sync/storage';
import { StatusDot } from './StatusDot';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    headerButton: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    logoContainer: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    titleText: {
        fontSize: 17,
        color: theme.colors.header.tint,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
}));

function HeaderTitle() {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const socketStatus = useSocketStatus();
    
    const getConnectionStatus = () => {
        const { status } = socketStatus;
        switch (status) {
            case 'connected':
                return {
                    color: theme.colors.status.connected,
                    isPulsing: false,
                    text: t('status.connected'),
                    textColor: theme.colors.status.connected
                };
            case 'connecting':
                return {
                    color: theme.colors.status.connecting,
                    isPulsing: true,
                    text: t('status.connecting'),
                    textColor: theme.colors.status.connecting
                };
            case 'disconnected':
                return {
                    color: theme.colors.status.disconnected,
                    isPulsing: false,
                    text: t('status.disconnected'),
                    textColor: theme.colors.status.disconnected
                };
            case 'error':
                return {
                    color: theme.colors.status.error,
                    isPulsing: false,
                    text: t('status.error'),
                    textColor: theme.colors.status.error
                };
            default:
                return {
                    color: theme.colors.status.default,
                    isPulsing: false,
                    text: '',
                    textColor: theme.colors.status.default
                };
        }
    };

    const connectionStatus = getConnectionStatus();
    
    return (
        <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={styles.titleText}>
                {t('tabs.settings')}
            </Text>
            {connectionStatus.text && (
                <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginTop: -2,
                }}>
                    <StatusDot
                        color={connectionStatus.color}
                        isPulsing={connectionStatus.isPulsing}
                        size={6}
                        style={{ marginRight: 4 }}
                    />
                    <Text style={{
                        fontSize: 12,
                        fontWeight: '500',
                        lineHeight: 16,
                        color: connectionStatus.textColor,
                        ...Typography.default(),
                    }}>
                        {connectionStatus.text}
                    </Text>
                </View>
            )}
        </View>
    );
}

function HeaderLeft() {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View style={styles.logoContainer}>
            <Image
                source={require('@/assets/images/logo-black.png')}
                contentFit="contain"
                style={[{ width: 24, height: 24 }]}
                tintColor={theme.colors.header.tint}
            />
        </View>
    );
}

function HeaderRight() {
    const router = useRouter();
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const isCustomServer = isUsingCustomServer();

    if (!isCustomServer) {
        // Return empty view to maintain header centering
        return <View style={styles.headerButton} />;
    }

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

export const SettingsViewWrapper = React.memo(() => {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <View style={styles.container}>
            <View style={{ backgroundColor: theme.colors.groupped.background }}>
                <Header
                    title={<HeaderTitle />}
                    headerRight={() => <HeaderRight />}
                    headerLeft={() => <HeaderLeft />}
                    headerShadowVisible={false}
                    headerTransparent={true}
                />
            </View>
            <SettingsView />
        </View>
    );
});