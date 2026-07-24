import React, { useEffect } from 'react';
import { Platform, ScrollView, View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { getChangelogEntries, getLatestTitle, setLastViewedTitle } from '@/changelog';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { MobileGlassSurface } from '@/components/MobileGlass';

export default function ChangelogScreen() {
    const insets = useSafeAreaInsets();
    const entries = getChangelogEntries();

    useEffect(() => {
        const latestTitle = getLatestTitle();
        if (latestTitle) {
            setLastViewedTitle(latestTitle);
        }
    }, []);

    if (entries.length === 0) {
        return (
            <View style={styles.container}>
                <View style={styles.emptyState}>
                    <Text style={styles.emptyText}>
                        {t('changelog.noEntriesAvailable')}
                    </Text>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <ScrollView
                style={styles.container}
                contentContainerStyle={[
                    styles.content,
                    {
                        paddingBottom: insets.bottom + 40,
                        maxWidth: layout.maxWidth,
                        alignSelf: 'center',
                        width: '100%'
                    }
                ]}
                showsVerticalScrollIndicator={false}
            >
                {entries.map((entry) => (
                    <View key={entry.title} style={styles.entryContainer}>
                        <Text style={styles.titleText}>
                            {entry.title}
                        </Text>
                        {entry.summary ? (
                            <Text style={styles.summaryText}>
                                {entry.summary}
                            </Text>
                        ) : null}
                        {entry.markdown ? (
                            <MobileGlassSurface enabled={Platform.OS !== 'web'} intensity={64} style={styles.card}>
                                <MarkdownView markdown={entry.markdown} />
                            </MobileGlassSurface>
                        ) : null}
                    </View>
                ))}
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }),
    },
    content: {
        paddingHorizontal: 16,
        paddingTop: 16,
    },
    entryContainer: {
        marginBottom: 32,
    },
    titleText: {
        ...Typography.default('semiBold'),
        fontSize: 20,
        lineHeight: 28,
        color: theme.colors.text,
        marginBottom: 8,
    },
    summaryText: {
        ...Typography.default('regular'),
        fontSize: 15,
        lineHeight: 22,
        color: theme.colors.textSecondary,
        marginBottom: 16,
    },
    card: {
        backgroundColor: Platform.select({ web: theme.colors.surfaceHigh, android: theme.colors.glass.backgroundStrong, default: 'transparent' }),
        borderRadius: Platform.select({ web: 12, default: 20 }),
        padding: 16,
        overflow: 'hidden',
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.glass.border,
        shadowColor: theme.colors.glass.shadow,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: Platform.select({ web: 0, default: 1 }),
        shadowRadius: 20,
    },
    emptyState: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
    },
    emptyText: {
        ...Typography.default('regular'),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    }
}));
