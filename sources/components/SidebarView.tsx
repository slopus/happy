import { useSessions } from '@/sync/storage';
import * as React from 'react';
import { Text, View, Pressable, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionsList } from './SessionsList';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useHeaderHeight } from '@/utils/responsive';
import { EmptySessionsTablet } from './EmptySessionsTablet';

export const SidebarView = React.memo(() => {
    const sessionsData = useSessions();
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    const headerHeight = useHeaderHeight();

    return (
        <View style={{ flex: 1, paddingTop: safeArea.top, borderRightWidth: 1, borderStyle: 'solid', borderColor: 'rgba(0,0,0,0.05)' }}>
            <View style={{ height: headerHeight, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 }}>
                <View style={{ flex: 1 }} />
                <Text style={{ fontWeight: '600' }}>Happy Coder</Text>
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
                {sessionsData === null && (
                    <View style={{ flex: 1, flexBasis: 0, flexGrow: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <ActivityIndicator />
                    </View>
                )}
                {sessionsData !== null && sessionsData.length === 0 && (
                    <EmptySessionsTablet />
                )}
                {sessionsData !== null && sessionsData.length > 0 && (
                    <SessionsList data={sessionsData} />
                )}
            </View>
        </View>
    )
});