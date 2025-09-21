import { Header } from '@/components/navigation/Header';
import { StatusDot } from '@/components/StatusDot';
import { Typography } from '@/constants/Typography';
import { useSocketStatus } from '@/sync/storage';
import { t } from '@/text';
import { useIsTablet } from '@/utils/responsive';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { View, Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

export const ZenHeader = React.memo(() => {
    const isTablet = useIsTablet();
    return (
        <Header
            title={isTablet ? <HeaderTitleTablet /> : <HeaderTitle />}
            headerRight={() => <HeaderRight />}
            headerLeft={isTablet ? () => null : () => <HeaderLeft />}
            headerShadowVisible={false}
            headerTransparent={true}
        />
    )
});

function HeaderTitleTablet() {
    const { theme } = useUnistyles();
    return (
        <Text style={{
            fontSize: 17,
            color: theme.colors.header.tint,
            fontWeight: '600',
            ...Typography.default('semiBold'),
        }}>
            Zen
        </Text>
    );
}

function HeaderTitle() {
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
            <Text style={{
                fontSize: 17,
                color: theme.colors.header.tint,
                fontWeight: '600',
                ...Typography.default('semiBold'),
            }}>
                Zen
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
    const { theme } = useUnistyles();
    return (
        <View style={{
            width: 32,
            height: 32,
            alignItems: 'center',
            justifyContent: 'center',
        }}>
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
    const { theme } = useUnistyles();
    // return (
    //     <Pressable
    //         onPress={() => router.push('/zen/add')}
    //         hitSlop={15}
    //         style={{
    //             width: 32,
    //             height: 32,
    //             alignItems: 'center',
    //             justifyContent: 'center',
    //         }}
    //     >
    //         <Ionicons name="add-outline" size={24} color={theme.colors.header.tint} />
    //     </Pressable>
    // );
    return <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }} />;
}   