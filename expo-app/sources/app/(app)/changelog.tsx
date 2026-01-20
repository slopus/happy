import React, { useEffect } from 'react';
import { ScrollView, View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { getChangelogEntries, getLatestVersion, setLastViewedVersion } from '@/changelog';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { t } from '@/text';

const styles = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    content: {
        paddingHorizontal: 16,
        paddingTop: 16,
    },
    entryContainer: {
        marginBottom: 32,
    },
    versionHeader: {
        ...Typography.default('semiBold'),
        fontSize: 20,
        lineHeight: 28,
        color: theme.colors.text,
        marginBottom: 8,
    },
    dateText: {
        ...Typography.default('regular'),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.textSecondary,
        marginBottom: 12,
    },
    summaryText: {
        ...Typography.default('regular'),
        fontSize: 15,
        lineHeight: 22,
        color: theme.colors.textSecondary,
        marginBottom: 16,
    },
    changesContainer: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 12,
        padding: 16,
    },
    changeItem: {
        ...Typography.default('regular'),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text,
        marginBottom: 12,
    },
    bulletPoint: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        color: theme.colors.textLink,
        marginRight: 10,
        alignSelf: 'flex-start',
        marginTop: 1,
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

export default function ChangelogScreen() {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const entries = getChangelogEntries();
    
    useEffect(() => {
        // Mark as viewed when component mounts
        const latestVersion = getLatestVersion();
        if (latestVersion > 0) {
            setLastViewedVersion(latestVersion);
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
                    <View key={entry.version} style={styles.entryContainer}>
                        <Text style={styles.versionHeader}>
                            {t('changelog.version', { version: entry.version })}
                        </Text>
                        <Text style={styles.dateText}>
                            {entry.date}
                        </Text>
                        {entry.summary && (
                            <Text style={styles.summaryText}>
                                {entry.summary}
                            </Text>
                        )}
                        <View style={styles.changesContainer}>
                            {entry.changes.map((change, index) => (
                                <View key={index} style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                                    <Text style={styles.bulletPoint}>•</Text>
                                    <Text style={[styles.changeItem, { flex: 1 }]}>
                                        {change}
                                    </Text>
                                </View>
                            ))}
                        </View>
                    </View>
                ))}
            </ScrollView>
        </View>
    );
}