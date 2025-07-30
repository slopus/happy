import { useSessions } from '@/sync/storage';
import * as React from 'react';
import { Text, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionsList } from './SessionsList';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

export const SidebarView = React.memo(() => {
    const sessionsData = useSessions();
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    
    return (
        <View style={{ flex: 1, paddingTop: safeArea.top, borderRightWidth: 1, borderStyle: 'solid', borderColor: 'rgba(0,0,0,0.05)' }}>
            <View style={{ height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 }}>
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
            {sessionsData && (
                <SessionsList data={sessionsData} />
            )}
        </View>
    )
});