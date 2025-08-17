import React from 'react';
import { View, Animated, FlatList, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { usePathname, useRouter } from 'expo-router';
import { SessionListViewItem, useSessionListViewData } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import { getSessionName, useSessionStatus, getSessionSubtitle, getSessionAvatarId, formatPathRelativeToHome } from '@/utils/sessionUtils';
import { Avatar } from './Avatar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { Session } from '@/sync/storageTypes';
import { Pressable } from 'react-native-gesture-handler';
import { LegendList } from '@legendapp/list';
import { FlashList } from '@shopify/flash-list';

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

export function SessionsList() {
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const data = useSessionListViewData();
    const pathname = usePathname();
    const selectable = true; //Platform.OS === 'web';
    const dataWithSelected = selectable ? React.useMemo(() => {
        return data?.map(item => ({
            ...item,
            selected: pathname.startsWith(`/session/${item.type === 'session' ? item.session.id : ''}`)
        }));
    }, [data, pathname]) : data;

    // Early return if no data yet
    if (!data) {
        return (
            <View style={{ flex: 1, backgroundColor: '#F2F2F7' }} />
        );
    }

    const keyExtractor = React.useCallback((item: SessionListViewItem & { selected?: boolean }, index: number) => {
        switch (item.type) {
            case 'header': return `header-${item.title}-${index}`;
            case 'project-group': return `project-group-${item.machine.id}-${item.displayPath}-${index}`;
            case 'session': return `session-${item.session.id}`;
            case 'machine': return `machine-${item.machine.id}`;
        }
    }, []);

    const renderItem = React.useCallback(({ item }: { item: SessionListViewItem & { selected?: boolean } }) => {
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

            case 'project-group':
                return (
                    <View style={{
                        paddingHorizontal: 16,
                        paddingVertical: 10,
                        backgroundColor: '#F8F8F8'
                    }}>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: '#000', ...Typography.default('semiBold') }}>
                            {item.displayPath}
                        </Text>
                        <Text style={{ fontSize: 11, color: '#8E8E93', marginTop: 2, ...Typography.default() }}>
                            {item.machine.metadata?.host || item.machine.id}
                        </Text>
                    </View>
                );

            case 'session':
                return (
                    <SessionItem session={item.session} selected={item.selected} />
                );
        }
    }, [router]);

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
            <FlatList
                data={dataWithSelected!}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                contentContainerStyle={{ paddingBottom: safeArea.bottom + 16 }}
                ItemSeparatorComponent={ItemSeparatorComponent}
            />
        </View>
    );
}

// Sub-component that handles session message logic
const SessionItem = React.memo(({ session, selected }: { session: Session; selected?: boolean }) => {
    const sessionStatus = useSessionStatus(session);
    const sessionName = getSessionName(session);
    const sessionSubtitle = getSessionSubtitle(session);
    const router = useRouter();

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
                backgroundColor: selected ? '#f9f9f9' : '#fff'
            }}
            onPress={() => {
                router.push(`/session/${session.id}`);
            }}
        >
            <Avatar id={avatarId} size={48} monochrome={!sessionStatus.isConnected} />
            <View style={{ flex: 1, marginLeft: 16, justifyContent: 'center' }}>
                {/* Title line */}
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 2 }}>
                    <Text style={{
                        fontSize: 15,
                        fontWeight: '500',
                        color: sessionStatus.isConnected ? '#000' : '#999',
                        flex: 1,
                        ...Typography.default('semiBold')
                    }} numberOfLines={1}> {/* {variant !== 'no-path' ? 1 : 2} - issue is we don't have anything to take this space yet and it looks strange - if summaries were more reliably generated, we can add this. While no summary - add something like "New session" or "Empty session", and extend summary to 2 lines once we have it */}
                        {sessionName}
                    </Text>
                    {session.draft && (
                        <Ionicons
                            name="create-outline"
                            size={16}
                            color="#8E8E93"
                            style={{ marginLeft: 6 }}
                        />
                    )}
                </View>

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