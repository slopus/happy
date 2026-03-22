import * as React from 'react';
import { memo } from 'react';
import { ScrollView, View, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useFeedItems, storage } from '@/sync/storage';
import { useAuth } from '@/auth/AuthContext';
import { markFeedItemRead } from '@/sync/apiFeed';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { t } from '@/text';

export default memo(function NoticeDetailPage() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const { theme } = useUnistyles();
    const { credentials } = useAuth();
    const feedItems = useFeedItems();
    const item = feedItems.find(i => i.id === id);

    // Mark as read on mount
    React.useEffect(() => {
        if (!item || !item.badge || !credentials) return;
        // Optimistic update
        storage.getState().markFeedItemRead(item.id);
        // Server call
        markFeedItemRead(credentials, item.id).catch(console.error);
    }, [item?.id, credentials]);

    if (!item || item.body.kind !== 'notice') {
        return (
            <View style={styles.container}>
                <View style={styles.emptyContainer}>
                    <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                        {t('feed.noticeNotFound')}
                    </Text>
                </View>
            </View>
        );
    }

    const formatDate = (timestamp: number) => {
        const date = new Date(timestamp);
        return date.toLocaleString();
    };

    const router = useRouter();

    // Parse meta.links as generic navigation links
    const links = React.useMemo(() => {
        const raw = item.meta?.links;
        if (!Array.isArray(raw)) return [];
        return raw.filter(
            (l): l is { label: string; url: string } =>
                !!l && typeof l === 'object' && typeof (l as any).label === 'string' && typeof (l as any).url === 'string'
        );
    }, [item.meta]);

    return (
        <ScrollView style={styles.container} contentContainerStyle={[styles.content, { maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }]}>
            <View style={styles.header}>
                <Ionicons name="notifications" size={28} color={theme.colors.textLink} />
                <Text style={styles.title}>{item.body.title}</Text>
                <Text style={styles.date}>{formatDate(item.createdAt)}</Text>
            </View>
            <View style={styles.body}>
                <Text style={styles.bodyText}>{item.body.text}</Text>
            </View>
            {links.map((link, i) => (
                <Pressable key={i} onPress={() => router.push(link.url as any)} style={styles.linkAction}>
                    <Ionicons name="open-outline" size={18} color={theme.colors.textLink} />
                    <Text style={styles.linkLabel}>{link.label}</Text>
                    <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
                </Pressable>
            ))}
        </ScrollView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    content: {
        padding: 16,
    },
    header: {
        alignItems: 'center',
        paddingVertical: 24,
        gap: 12,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 20,
        lineHeight: 28,
        color: theme.colors.text,
        textAlign: 'center',
    },
    date: {
        ...Typography.default('regular'),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    body: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 12,
        padding: 16,
    },
    bodyText: {
        ...Typography.default('regular'),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text,
    },
    emptyContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
    },
    emptyText: {
        ...Typography.default('regular'),
        fontSize: 16,
    },
    linkAction: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 12,
        padding: 16,
        marginTop: 12,
        gap: 12,
    },
    linkLabel: {
        ...Typography.default('semiBold'),
        flex: 1,
        fontSize: 14,
        color: theme.colors.text,
    },
}));
