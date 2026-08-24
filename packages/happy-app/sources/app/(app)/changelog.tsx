import React, { useEffect } from 'react';
import { Platform, View, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import { getChangelogEntries, getLatestTitle, setLastViewedTitle } from '@/changelog';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export default function ChangelogScreen() {
    const entries = getChangelogEntries();
    const safeArea = useSafeAreaInsets();
    const indicatorTopInset = safeArea.top + MOBILE_GLASS_HEADER_HEIGHT;

    useEffect(() => {
        const latestTitle = getLatestTitle();
        if (latestTitle) {
            setLastViewedTitle(latestTitle);
        }
    }, []);

    if (entries.length === 0) {
        return (
            <View style={styles.emptyState}>
                <Text style={styles.emptyText}>
                    {t('changelog.noEntriesAvailable')}
                </Text>
            </View>
        );
    }

    return (
        <ItemList
            containerStyle={{
                paddingTop: Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0,
            }}
            automaticallyAdjustsScrollIndicatorInsets={Platform.OS !== 'ios'}
            scrollIndicatorInsets={Platform.OS === 'ios' ? { top: indicatorTopInset } : undefined}
        >
            {entries.map((entry) => (
                <ItemGroup key={entry.title} title={entry.title} titleStyle={styles.titleText}>
                    <View style={styles.cardContent}>
                        {entry.summary ? (
                            <Text style={styles.summaryText}>
                                {entry.summary}
                            </Text>
                        ) : null}
                        {entry.markdown ? (
                            <MarkdownView markdown={entry.markdown} />
                        ) : null}
                    </View>
                </ItemGroup>
            ))}
        </ItemList>
    );
}

const styles = StyleSheet.create((theme) => ({
    titleText: {
        ...Typography.default('semiBold'),
        fontSize: 20,
        lineHeight: 28,
        color: theme.colors.text,
        textTransform: 'none',
        letterSpacing: 0,
    },
    cardContent: {
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 6,
    },
    summaryText: {
        ...Typography.default('regular'),
        fontSize: 16,
        lineHeight: 23,
        color: theme.colors.text,
        marginBottom: 12,
    },
    emptyState: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
        backgroundColor: theme.colors.groupped.background,
    },
    emptyText: {
        ...Typography.default('regular'),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.textSecondary,
    }
}));
