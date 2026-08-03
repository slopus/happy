import React from 'react';
import { Platform, View, FlatList } from 'react-native';
import { Text } from '@/components/StyledText';
import { useAllSessions } from '@/sync/storage';
import { Session } from '@/sync/storageTypes';
import { Avatar } from '@/components/Avatar';
import { getSessionName, getSessionSubtitle, getSessionAvatarId } from '@/utils/sessionUtils';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { Pressable } from 'react-native';
import { t } from '@/text';
import { MobileGlassSurface } from '@/components/MobileGlass';

interface SessionHistoryItem {
    type: 'session' | 'date-header';
    session?: Session;
    date?: string;
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'stretch',
        backgroundColor: Platform.select({ web: theme.colors.groupped.background, default: 'transparent' }),
    },
    contentContainer: {
        flex: 1,
        maxWidth: layout.maxWidth,
    },
    dateHeader: {
        backgroundColor: Platform.select({ web: theme.colors.groupped.background, default: 'transparent' }),
        paddingTop: 20,
        paddingBottom: 8,
        paddingHorizontal: 24,
    },
    dateHeaderText: {
        ...Typography.default('semiBold'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: 14,
        fontWeight: '600',
        letterSpacing: 0.1,
    },
    sessionCard: {
        backgroundColor: Platform.select({ web: theme.colors.surface, android: theme.colors.glass.backgroundStrong, default: 'transparent' }),
        marginHorizontal: 16,
        marginBottom: 1,
        overflow: 'hidden',
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.glass.border,
    },
    sessionPressable: {
        paddingVertical: 16,
        paddingHorizontal: 16,
        flexDirection: 'row',
        alignItems: 'center',
        width: '100%',
    },
    sessionCardFirst: {
        borderTopLeftRadius: Platform.select({ web: 12, default: 18 }),
        borderTopRightRadius: Platform.select({ web: 12, default: 18 }),
    },
    sessionCardLast: {
        borderBottomLeftRadius: Platform.select({ web: 12, default: 18 }),
        borderBottomRightRadius: Platform.select({ web: 12, default: 18 }),
        marginBottom: 12,
    },
    sessionCardSingle: {
        borderRadius: Platform.select({ web: 12, default: 18 }),
        marginBottom: 12,
    },
    sessionContent: {
        flex: 1,
        marginLeft: 16,
    },
    sessionTitle: {
        fontSize: 15,
        fontWeight: '500',
        color: theme.colors.text,
        marginBottom: 2,
        ...Typography.default('semiBold'),
    },
    sessionSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 32,
    },
    emptyText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
}));

function formatDateHeader(date: Date): string {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const sessionDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    
    if (sessionDate.getTime() === today.getTime()) {
        return t('sessionHistory.today');
    } else if (sessionDate.getTime() === yesterday.getTime()) {
        return t('sessionHistory.yesterday');
    } else {
        const diffTime = today.getTime() - sessionDate.getTime();
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        return t('sessionHistory.daysAgo', { count: diffDays });
    }
}

function groupSessionsByDate(sessions: Session[]): SessionHistoryItem[] {
    const sortedSessions = sessions
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt);
    
    const items: SessionHistoryItem[] = [];
    let currentDateGroup: Session[] = [];
    let currentDateString: string | null = null;
    
    for (const session of sortedSessions) {
        const sessionDate = new Date(session.updatedAt);
        const dateString = sessionDate.toDateString();
        
        if (currentDateString !== dateString) {
            // Process previous group
            if (currentDateGroup.length > 0) {
                items.push({
                    type: 'date-header',
                    date: formatDateHeader(new Date(currentDateString!)),
                });
                currentDateGroup.forEach(sess => {
                    items.push({ type: 'session', session: sess });
                });
            }
            
            // Start new group
            currentDateString = dateString;
            currentDateGroup = [session];
        } else {
            currentDateGroup.push(session);
        }
    }
    
    // Process final group
    if (currentDateGroup.length > 0) {
        items.push({
            type: 'date-header',
            date: formatDateHeader(new Date(currentDateString!)),
        });
        currentDateGroup.forEach(sess => {
            items.push({ type: 'session', session: sess });
        });
    }
    
    return items;
}

export default function SessionHistory() {
    const safeArea = useSafeAreaInsets();
    const allSessions = useAllSessions();
    const navigateToSession = useNavigateToSession();
    
    const groupedItems = React.useMemo(() => {
        return groupSessionsByDate(allSessions);
    }, [allSessions]);
    
    const renderItem = React.useCallback(({ item, index }: { item: SessionHistoryItem, index: number }) => {
        if (item.type === 'date-header') {
            return (
                <View style={styles.dateHeader}>
                    <Text style={styles.dateHeaderText}>
                        {item.date}
                    </Text>
                </View>
            );
        }
        
        if (item.type === 'session' && item.session) {
            const session = item.session;
            const sessionName = getSessionName(session);
            const sessionSubtitle = getSessionSubtitle(session);
            const avatarId = getSessionAvatarId(session);
            
            // Determine card styling based on position within date group
            const prevItem = index > 0 ? groupedItems[index - 1] : null;
            const nextItem = index < groupedItems.length - 1 ? groupedItems[index + 1] : null;
            
            const isFirst = prevItem?.type === 'date-header';
            const isLast = nextItem?.type === 'date-header' || nextItem == null;
            const isSingle = isFirst && isLast;
            
            return (
                <MobileGlassSurface
                    enabled={Platform.OS !== 'web'}
                    intensity={64}
                    style={[
                        styles.sessionCard,
                        isSingle ? styles.sessionCardSingle : 
                        isFirst ? styles.sessionCardFirst :
                        isLast ? styles.sessionCardLast : {}
                    ]}
                >
                <Pressable
                    style={({ pressed }) => [styles.sessionPressable, Platform.OS !== 'web' && pressed && { opacity: 0.72 }]}
                    onPress={() => navigateToSession(session.id)}
                >
                    <Avatar id={avatarId} size={48} />
                    <View style={styles.sessionContent}>
                        <Text style={styles.sessionTitle} numberOfLines={1}>
                            {sessionName}
                        </Text>
                        <Text style={styles.sessionSubtitle} numberOfLines={1}>
                            {sessionSubtitle}
                        </Text>
                    </View>
                </Pressable>
                </MobileGlassSurface>
            );
        }
        
        return null;
    }, [groupedItems, navigateToSession]);
    
    const keyExtractor = React.useCallback((item: SessionHistoryItem, index: number) => {
        if (item.type === 'date-header') {
            return `date-${item.date}-${index}`;
        }
        if (item.type === 'session' && item.session) {
            return `session-${item.session.id}`;
        }
        return `item-${index}`;
    }, []);
    
    if (!allSessions) {
        return (
            <View style={styles.container}>
                <View style={styles.contentContainer} />
            </View>
        );
    }
    
    if (groupedItems.length === 0) {
        return (
            <View style={styles.container}>
                <View style={styles.contentContainer}>
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyText}>
                            {t('sessionHistory.empty')}
                        </Text>
                    </View>
                </View>
            </View>
        );
    }
    
    return (
        <View style={styles.container}>
            <View style={styles.contentContainer}>
                <FlatList
                    data={groupedItems}
                    renderItem={renderItem}
                    keyExtractor={keyExtractor}
                    contentContainerStyle={{ 
                        paddingBottom: safeArea.bottom + 16,
                        paddingTop: 8,
                    }}
                />
            </View>
        </View>
    );
}
