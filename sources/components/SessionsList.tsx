import React from 'react';
import { View, Pressable, Animated } from 'react-native';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { SessionListViewItem, useSessionListViewData } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import { getSessionName, useSessionStatus, getSessionSubtitle, getSessionAvatarId } from '@/utils/sessionUtils';
import { Avatar } from './Avatar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { Session } from '@/sync/storageTypes';
import { LegendList } from '@legendapp/list';

// Animated status dot component
function StatusDot({ color, isPulsing }: { color: string; isPulsing?: boolean }) {
    const pulseAnim = React.useRef(new Animated.Value(1)).current;

    React.useEffect(() => {
        if (isPulsing) {
            Animated.loop(
                Animated.sequence([
                    Animated.timing(pulseAnim, {
                        toValue: 0.3,
                        duration: 1000,
                        useNativeDriver: true,
                    }),
                    Animated.timing(pulseAnim, {
                        toValue: 1,
                        duration: 1000,
                        useNativeDriver: true,
                    }),
                ])
            ).start();
        } else {
            pulseAnim.setValue(1);
        }
    }, [isPulsing, pulseAnim]);

    return (
        <Animated.View
            style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: color,
                opacity: pulseAnim,
                marginRight: 4,
            }}
        />
    );
}

interface SessionsListProps {
    selectedSessionId?: string | null;
}

export function SessionsList({ selectedSessionId }: SessionsListProps) {
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const data = useSessionListViewData();
    
    // Early return if no data yet
    if (!data) {
        return (
            <View style={{ flex: 1, backgroundColor: '#F2F2F7' }} />
        );
    }

    const keyExtractor = React.useCallback((item: SessionListViewItem, index: number) => {
        switch (item.type) {
            case 'header': return `header-${item.title}-${index}`;
            case 'session': return `session-${item.session.id}`;
            case 'machine': return `machine-${item.machine.id}`;
        }
    }, []);

    const renderItem = React.useCallback(({ item }: { item: SessionListViewItem }) => {
        switch (item.type) {
            case 'header':
                return (
                    <View style={{ paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8, backgroundColor: '#F2F2F7' }}>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: '#8E8E93', letterSpacing: 0.3, textTransform: 'uppercase', ...Typography.default('semiBold') }}>
                            {item.title}
                        </Text>
                    </View>
                );
                
            case 'machine':
                return (
                    <Pressable
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingHorizontal: 16,
                            paddingVertical: 12,
                            backgroundColor: '#fff'
                        }}
                        onPress={() => router.push('/new-session')}
                    >
                        <Ionicons 
                            name="desktop-outline" 
                            size={24} 
                            color="#007AFF"
                            style={{ marginRight: 12 }}
                        />
                        <Text style={{ fontSize: 15, color: '#000', ...Typography.default() }}>
                            {item.machine.metadata?.host || item.machine.id}
                        </Text>
                    </Pressable>
                );
                
            case 'session':
                return (
                    <SessionItem
                        session={item.session}
                        selectedSessionId={selectedSessionId}
                        router={router}
                    />
                );
        }
    }, [router, selectedSessionId]);

    // ItemSeparatorComponent for FlashList
    const ItemSeparatorComponent = React.useCallback(({ leadingItem, trailingItem }: any) => {
        // Don't render separator if either item is a header
        if (leadingItem?.type === 'header' || trailingItem?.type === 'header') {
            return null;
        }
        
        // Use different indentation for machine separators
        const marginLeft = leadingItem?.type === 'machine' ? 52 : 88;
        
        return <View style={{ height: 0.5, backgroundColor: '#E5E5E7', marginLeft }} />;
    }, []);

    return (
        <View style={{ flex: 1, backgroundColor: '#F2F2F7' }}>
            <LegendList
                data={data}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                estimatedItemSize={88}
                contentContainerStyle={{ paddingBottom: safeArea.bottom + 16 }}
                ItemSeparatorComponent={ItemSeparatorComponent}
            />
        </View>
    );
}

// Sub-component that handles session message logic
const SessionItem = React.memo(({ session, selectedSessionId, router }: {
    session: Session;
    selectedSessionId?: string | null;
    router: any;
}) => {
    const sessionStatus = useSessionStatus(session);
    const sessionName = getSessionName(session);
    const sessionSubtitle = getSessionSubtitle(session);
    const isSelected = selectedSessionId === session.id;

    const avatarId = React.useMemo(() => {
        return getSessionAvatarId(session);
    }, [session]);

    return (
        <Pressable
            style={{
                height: 88,
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 16,
                backgroundColor: isSelected ? 'rgba(0, 0, 0, 0.03)' : '#fff'
            }}
            onPress={() => {
                router.push(`/session/${session.id}`);
            }}
        >
            <Avatar id={avatarId} size={48} monochrome={!sessionStatus.isConnected} />
            <View style={{ flex: 1, marginLeft: 16, justifyContent: 'center' }}>
                {/* Title line */}
                <Text style={{ 
                    fontSize: 15, 
                    fontWeight: '500', 
                    color: sessionStatus.isConnected ? '#000' : '#999',
                    marginBottom: 2,
                    ...Typography.default('semiBold') 
                }} numberOfLines={1}>
                    {sessionName}
                </Text>
                
                {/* Subtitle line */}
                <Text style={{ 
                    fontSize: 13, 
                    color: '#8E8E93',
                    marginBottom: 4,
                    ...Typography.default() 
                }} numberOfLines={1}>
                    {sessionSubtitle}
                </Text>
                
                {/* Status line with dot */}
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={{
                        alignItems: 'center',
                        justifyContent: 'center',
                        height: 16,
                        marginTop: 2
                    }}>
                        <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} />
                    </View>
                    <Text style={{ 
                        fontSize: 12, 
                        color: sessionStatus.statusColor,
                        fontWeight: '500',
                        lineHeight: 16,
                        ...Typography.default()
                    }}>
                        {sessionStatus.statusText}
                    </Text>
                </View>
            </View>
        </Pressable>
    );
});