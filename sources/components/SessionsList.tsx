import React from 'react';
import { View, Pressable, Animated } from 'react-native';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { SessionListItem } from '@/sync/storage';
import { getSessionName, useSessionStatus, getSessionSubtitle, formatOSPlatform } from '@/utils/sessionUtils';
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
    data: SessionListItem[];
    selectedSessionId?: string | null;
}

export function SessionsList({ data, selectedSessionId }: SessionsListProps) {
    const router = useRouter();
    const safeArea = useSafeAreaInsets();

    const keyExtractor = React.useCallback((item: SessionListItem, index: number) => {
        if (typeof item === 'string') {
            return `header-${item}-${index}`;
        }
        return `session-${item.id}`;
    }, []);

    const renderItem = React.useCallback(({ item, index }: { item: SessionListItem; index: number }) => {
        if (typeof item === 'string') {
            const isOnline = item === 'online';
            const title = isOnline ? 'Active Sessions' : 'Previous Sessions';
            return (
                <View style={{ paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8, backgroundColor: '#F2F2F7' }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: '#8E8E93', letterSpacing: 0.3, textTransform: 'uppercase', ...Typography.default('semiBold') }}>{title}</Text>
                </View>
            );
        }

        const session = item;
        return (
            <SessionItem
                session={session}
                selectedSessionId={selectedSessionId}
                router={router}
            />
        );
    }, [router, selectedSessionId]);

    const getItemType = React.useCallback((item: SessionListItem) => {
        return typeof item === 'string' ? 'header' : 'session';
    }, []);

    // ItemSeparatorComponent for FlashList
    const ItemSeparatorComponent = React.useCallback(({ leadingItem, trailingItem }: any) => {
        // Don't render separator if either item is a section header
        const leadingIsHeader = typeof leadingItem === 'string';
        const trailingIsHeader = typeof trailingItem === 'string';
        
        if (leadingIsHeader || trailingIsHeader) {
            return null;
        }
        
        return <View style={{ height: 0.5, backgroundColor: '#E5E5E7', marginLeft: 88 }} />;
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
            <Avatar id={session.id} size={48} monochrome={!sessionStatus.isConnected} />
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
                
                {/* Status line with dot and OS info */}
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
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
                    {session.metadata?.os && (
                        <Text style={{ 
                            fontSize: 11, 
                            color: '#8E8E93',
                            ...Typography.default() 
                        }}>
                            {formatOSPlatform(session.metadata.os)}
                        </Text>
                    )}
                </View>
            </View>
        </Pressable>
    );
});