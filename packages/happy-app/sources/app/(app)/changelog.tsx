import React, { useEffect } from 'react';
import { Platform, View, Text, Image as RNImage } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import { getChangelogEntries, getLatestTitle, setLastViewedTitle } from '@/changelog';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/openExternalUrl';

// Changelog images must be bundled, so each path used in CHANGELOG.md needs an entry here
const CHANGELOG_IMAGES: Record<string, number> = {
    'images/mouse-on-the-phone.webp': require('@/changelog/images/mouse-on-the-phone.webp'),
};

type SummarySegment =
    | { type: 'text'; text: string }
    | { type: 'link'; label: string; url: string }
    | { type: 'image'; path: string };

const SUMMARY_INLINE = /!\[[^\]]*\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)/g;

function parseSummary(summary: string): SummarySegment[] {
    const segments: SummarySegment[] = [];
    let last = 0;
    for (const match of summary.matchAll(SUMMARY_INLINE)) {
        if (match.index! > last) {
            segments.push({ type: 'text', text: summary.slice(last, match.index) });
        }
        if (match[1]) {
            segments.push({ type: 'image', path: match[1] });
        } else {
            segments.push({ type: 'link', label: match[2], url: match[3] });
        }
        last = match.index! + match[0].length;
    }
    if (last < summary.length) {
        segments.push({ type: 'text', text: summary.slice(last) });
    }
    return segments;
}

function SummaryLine({ summary }: { summary: string }) {
    return (
        <Text style={styles.summaryText}>
            {parseSummary(summary).map((segment, index) => {
                if (segment.type === 'image') {
                    const source = CHANGELOG_IMAGES[segment.path];
                    // expo-image renders a block-level div on web, so the core Image keeps inline flow
                    return source ? (
                        <RNImage key={index} source={source} style={styles.summaryImage} resizeMode="contain" />
                    ) : null;
                }
                if (segment.type === 'link') {
                    return (
                        <Text
                            key={index}
                            accessibilityRole="link"
                            style={styles.summaryLink}
                            {...(Platform.OS === 'web'
                                ? { onClick: () => openExternalUrl(segment.url) } as any
                                : { onPress: () => openExternalUrl(segment.url) })}
                        >
                            {segment.label}
                        </Text>
                    );
                }
                return <Text key={index}>{segment.text}</Text>;
            })}
        </Text>
    );
}

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
            {entries.map((entry) => {
                const titleImage = entry.titleImage ? CHANGELOG_IMAGES[entry.titleImage] : undefined;
                const title = titleImage ? (
                    <View style={styles.titleRow}>
                        <Text style={styles.titleText}>{entry.title}</Text>
                        <Image
                            source={titleImage}
                            style={{ width: 28, height: 28 }}
                            contentFit="contain"
                        />
                    </View>
                ) : entry.title;
                return (
                <ItemGroup key={entry.title} title={title} titleStyle={styles.titleText}>
                    <View style={styles.cardContent}>
                        {entry.summary ? (
                            <SummaryLine summary={entry.summary} />
                        ) : null}
                        {entry.markdown ? (
                            <MarkdownView markdown={entry.markdown} />
                        ) : null}
                    </View>
                </ItemGroup>
                );
            })}
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
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    cardContent: {
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 6,
    },
    // 16 matches MarkdownView's gap between the bullet list and the paragraph
    // after it (list marginBottom 8 + text marginTop 8), so the space above and
    // below the list reads the same.
    summaryText: {
        ...Typography.default('regular'),
        fontSize: 16,
        lineHeight: 23,
        color: theme.colors.text,
        marginBottom: 16,
    },
    summaryLink: {
        textDecorationLine: 'underline',
        cursor: 'pointer',
    },
    summaryImage: {
        width: 20,
        height: 20,
        transform: [{ translateY: 3 }],
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
