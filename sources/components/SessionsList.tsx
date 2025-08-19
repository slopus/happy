import React from 'react';
import { View, Pressable, FlatList } from 'react-native';
import { Text } from '@/components/StyledText';
import { usePathname, useRouter } from 'expo-router';
import { SessionListViewItem, useSessionListViewData } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import { getSessionName, useSessionStatus, getSessionSubtitle, getSessionAvatarId, formatPathRelativeToHome } from '@/utils/sessionUtils';
import { Avatar } from './Avatar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { Session } from '@/sync/storageTypes';
import { StatusDot } from './StatusDot';

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
                            {item.machine.metadata?.displayName || item.machine.metadata?.host || item.machine.id}
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

        // Use standard indentation for separators
        const marginLeft = 88;

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
                        marginTop: 2,
                        marginRight: 4
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