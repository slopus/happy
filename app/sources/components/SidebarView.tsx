import { useSessions } from '@/sync/storage';
import * as React from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionsList } from './SessionsList';

export const SidebarView = React.memo(() => {
    const sessionsData = useSessions();
    const safeArea = useSafeAreaInsets();
    return (
        <View style={{ flex: 1, paddingTop: safeArea.top, borderRightWidth: 1, borderStyle: 'solid', borderColor: 'rgba(0,0,0,0.05)' }}>
            <View style={{ height: 44, justifyContent: 'center', alignContent: 'center' }}>
                <Text style={{ textAlign: 'center', fontWeight: '600' }}>Happy Coder</Text>
            </View>
            {sessionsData && (
                <SessionsList data={sessionsData} />
            )}
        </View>
    )
});