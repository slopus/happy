import * as React from 'react';
import { useIsDesktopModalScene } from './DesktopModalScene';
import { View, Text, ScrollView, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useFeedItems, useFeedLoaded, useRealtimeStatus } from '@/sync/storage';
import { t } from '@/text';
import { ItemGroup } from '@/components/ItemGroup';
import { UpdateBanner } from './UpdateBanner';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { useIsTablet } from '@/utils/responsive';
import { Header } from './navigation/Header';
import { Image } from 'expo-image';
import { FeedItemCard } from './FeedItemCard';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    emptyIcon: {
        marginBottom: 16,
    },
    emptyTitle: {
        fontSize: 20,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        marginBottom: 8,
        textAlign: 'center',
    },
}));

interface InboxViewProps {
}

// Header components for tablet mode only (phone mode header is in MainView)
function HeaderTitleTablet() {
    const { theme } = useUnistyles();
    return (
        <Text style={{
            fontSize: 17,
            color: theme.colors.header.tint,
            fontWeight: '600',
            ...Typography.default('semiBold'),
        }}>
            {t('tabs.inbox')}
        </Text>
    );
}

export const InboxView = React.memo(({}: InboxViewProps) => {
    const allFeedItems = useFeedItems();
    // Ignore persisted social events as well as events from older servers.
    const feedItems = React.useMemo(() => allFeedItems.filter(item => item.body.kind === 'text'), [allFeedItems]);
    const feedLoaded = useFeedLoaded();
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();
    const inDesktopModal = useIsDesktopModalScene();
    const realtimeStatus = useRealtimeStatus();
    const isLoading = !feedLoaded;
    const isEmpty = !isLoading && feedItems.length === 0;

    if (isLoading) {
        return (
            <View style={styles.container}>
                {isTablet && !inDesktopModal && (
                    <View style={{ backgroundColor: theme.colors.groupped.background }}>
                        <Header
                            title={<HeaderTitleTablet />}
                            headerLeft={() => null}
                            headerShadowVisible={false}
                            headerTransparent={true}
                        />
                        {realtimeStatus !== 'disconnected' && (
                            <VoiceAssistantStatusBar variant="full" />
                        )}
                    </View>
                )}
                <UpdateBanner />
                <View style={styles.emptyContainer}>
                    <ActivityIndicator size="large" color={theme.colors.textSecondary} />
                </View>
            </View>
        );
    }

    if (isEmpty) {
        return (
            <View style={styles.container}>
                {isTablet && !inDesktopModal && (
                    <View style={{ backgroundColor: theme.colors.groupped.background }}>
                        <Header
                            title={<HeaderTitleTablet />}
                            headerLeft={() => null}
                            headerShadowVisible={false}
                            headerTransparent={true}
                        />
                        {realtimeStatus !== 'disconnected' && (
                            <VoiceAssistantStatusBar variant="full" />
                        )}
                    </View>
                )}
                <UpdateBanner />
                <View style={styles.emptyContainer}>
                    <Image
                        source={require('@/assets/images/brutalist/Brutalism-10.png')}
                        contentFit="contain"
                        style={[{ width: 64, height: 64 }, styles.emptyIcon]}
                        tintColor={theme.colors.textSecondary}
                    />
                    <Text style={styles.emptyTitle}>{t('inbox.emptyTitle')}</Text>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {isTablet && !inDesktopModal && (
                <View style={{ backgroundColor: theme.colors.groupped.background }}>
                    <Header
                        title={<HeaderTitleTablet />}
                        headerLeft={() => null}
                        headerShadowVisible={false}
                        headerTransparent={true}
                    />
                    {realtimeStatus !== 'disconnected' && (
                        <VoiceAssistantStatusBar variant="full" />
                    )}
                </View>
            )}
            <ScrollView contentContainerStyle={{
                maxWidth: layout.maxWidth,
                alignSelf: 'center',
                width: '100%'
            }}>
                <UpdateBanner />

                {feedItems.length > 0 && (
                    <>
                        <ItemGroup title={t('inbox.updates')}>
                            {feedItems.map((item) => (
                                <FeedItemCard
                                    key={item.id}
                                    item={item}
                                />
                            ))}
                        </ItemGroup>
                    </>
                )}
                
            </ScrollView>
        </View>
    );
});
