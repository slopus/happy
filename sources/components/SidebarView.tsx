import { useSessionListViewData, useEntitlement } from '@/sync/storage';
import * as React from 'react';
import { Text, View, Pressable, ActivityIndicator, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionsList } from './SessionsList';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useHeaderHeight } from '@/utils/responsive';
import { EmptySessionsTablet } from './EmptySessionsTablet';
import { PlusPlus } from './PlusPlus';
import { Typography } from '@/constants/Typography';

export const SidebarView = React.memo(() => {
    const sessionListViewData = useSessionListViewData();
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    const headerHeight = useHeaderHeight();
    const isPro = __DEV__ || useEntitlement('pro');

    return (
        <View style={{ flex: 1, paddingTop: safeArea.top, borderRightWidth: 1, borderStyle: 'solid', borderColor: 'rgba(0,0,0,0.05)' }}>
            <View style={{ height: headerHeight, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 }}>
                <View style={{ flex: 1 }} />
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text style={{ 
                        fontSize: Platform.OS === 'web' ? 18 : 16,
                        ...Typography.logo()
                    }}>Happy Coder</Text>
                    {isPro && <PlusPlus fontSize={Platform.OS === 'web' ? 18 : 16} />}
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
    )
});