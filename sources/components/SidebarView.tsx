import { useSessionListViewData, useEntitlement, useSocketStatus, useSetting } from '@/sync/storage';
import * as React from 'react';
import { Text, View, Pressable, ActivityIndicator, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionsList } from './SessionsList';
import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter, useSegments } from 'expo-router';
import { useHeaderHeight } from '@/utils/responsive';
import { EmptySessionsTablet } from './EmptySessionsTablet';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { FAB } from './FAB';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';
import { useRealtimeStatus } from '@/sync/storage';

export const SidebarView = React.memo(() => {
    const sessionListViewData = useSessionListViewData();
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    const headerHeight = useHeaderHeight();
    const socketStatus = useSocketStatus();
    const isExperimental = useSetting('experiments');
    const realtimeStatus = useRealtimeStatus();

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
                    text: 'error',
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

    const handleNewSession = () => {
        router.push('/new-session');
    }

    return (
        <>
            <View style={{ flex: 1, paddingTop: safeArea.top, borderRightWidth: 1, borderStyle: 'solid', borderColor: 'rgba(0,0,0,0.05)' }}>
                <View style={{ height: headerHeight, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 }}>
                    <View style={{ flex: 1 }} />
                    <View style={{ flexDirection: 'column', alignItems: 'center' }}>
                        <Text style={{
                            fontSize: Platform.OS === 'web' ? 18 : 16,
                            ...Typography.logo()
                        }}>Happy</Text>
                        {getConnectionStatus().text && (
                            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                                <StatusDot
                                    color={getConnectionStatus().color}
                                    isPulsing={getConnectionStatus().isPulsing}
                                    size={6}
                                    style={{ marginRight: 4 }}
                                />
                                <Text style={{
                                    fontSize: 11,
                                    color: getConnectionStatus().textColor,
                                    fontWeight: '500',
                                    lineHeight: 16,
                                    ...Typography.default()
                                }}>
                                    {getConnectionStatus().text}
                                </Text>
                            </View>
                        )}
                    </View>
                    <View style={{ flex: 1, alignItems: 'flex-end' }}>
                        <Pressable
                            onPress={() => router.push('/settings')}
                            hitSlop={10}
                        >
                            <Ionicons name="settings-outline" size={24} color="#000" />
                        </Pressable>
                    </View>
                </View>
                {realtimeStatus !== 'disconnected' && (
                    <VoiceAssistantStatusBar variant="sidebar" />
                )}
                <View style={{ flex: 1, flexBasis: 0, flexGrow: 1 }}>
                    {sessionListViewData === null && (
                        <View style={{ flex: 1, flexBasis: 0, flexGrow: 1, justifyContent: 'center', alignItems: 'center' }}>
                            <ActivityIndicator />
                        </View>
                    )}
                    {sessionListViewData !== null && sessionListViewData.length === 0 && (
                        <EmptySessionsTablet />
                    )}
                    {sessionListViewData !== null && sessionListViewData.length > 0 && (
                        <SessionsList />
                    )}
                </View>
            </View>
            {isExperimental && (
                <FAB onPress={handleNewSession} />
            )}
        </>
    )
});