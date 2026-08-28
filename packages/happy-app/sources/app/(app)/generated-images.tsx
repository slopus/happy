import * as React from 'react';
import { ActivityIndicator, FlatList, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useGeneratedImages, type GeneratedImageEntry } from '@/hooks/useGeneratedImages';
import { useGeneratedImagesPlugin } from '@/hooks/useGeneratedImagesPlugin';
import { t } from '@/text';
import { layout } from '@/components/layout';
import { GeneratedImageCard } from '@/components/GeneratedImageCard';

const CARD_GAP = 10;
const MIN_CARD_WIDTH = 154;

function GeneratedImagesContent() {
    const { theme } = useUnistyles();
    const dimensions = useWindowDimensions();
    const images = useGeneratedImages();
    const contentWidth = Math.min(layout.maxWidth, dimensions.width);
    const columns = Math.max(2, Math.floor((contentWidth - 32 + CARD_GAP) / (MIN_CARD_WIDTH + CARD_GAP)));
    const cardWidth = Math.floor((contentWidth - 32 - CARD_GAP * (columns - 1)) / columns);
    const cardHeight = Math.round(cardWidth * 1.92);

    const renderItem = React.useCallback(({ item, index }: { item: GeneratedImageEntry; index: number }) => (
        <GeneratedImageCard
            item={item}
            cardWidth={cardWidth}
            cardHeight={cardHeight}
            isLastColumn={(index + 1) % columns === 0}
        />
    ), [cardHeight, cardWidth, columns]);

    if (images.length === 0) {
        return (
            <View style={[styles.empty, { backgroundColor: theme.colors.groupped.background }]}>
                <Ionicons name="images-outline" size={42} color={theme.colors.textSecondary} />
                <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
                    {t('generatedImages.emptyTitle')}
                </Text>
                <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                    {t('generatedImages.emptyDescription')}
                </Text>
            </View>
        );
    }

    return (
        <FlatList
            data={images}
            extraData={`${columns}:${cardWidth}`}
            key={columns}
            keyExtractor={(item) => item.id}
            numColumns={columns}
            renderItem={renderItem}
            style={[styles.container, { backgroundColor: theme.colors.groupped.background }]}
            contentContainerStyle={[styles.content, { maxWidth: layout.maxWidth }]}
            ListHeaderComponent={(
                <View style={styles.header}>
                    <Text style={[styles.headerTitle, { color: theme.colors.text }]}>
                        {t('generatedImages.title')}
                    </Text>
                    <Text style={[styles.headerSubtitle, { color: theme.colors.textSecondary }]}>
                        {t('generatedImages.subtitle', { count: images.length })}
                    </Text>
                </View>
            )}
        />
    );
}

export default React.memo(function GeneratedImagesScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { status } = useGeneratedImagesPlugin();

    React.useEffect(() => {
        if (status?.installed === false) router.replace('/');
    }, [router, status]);

    if (status?.installed !== true) {
        return (
            <View
                style={[styles.guard, { backgroundColor: theme.colors.groupped.background }]}
                testID="generated-images-plugin-guard"
            >
                <ActivityIndicator color={theme.colors.accent} />
            </View>
        );
    }

    return <GeneratedImagesContent />;
});

const styles = StyleSheet.create(() => ({
    container: {
        flex: 1,
    },
    content: {
        alignSelf: 'center',
        paddingBottom: 28,
        paddingHorizontal: 16,
        width: '100%',
    },
    header: {
        paddingBottom: 12,
        paddingTop: 18,
    },
    headerTitle: {
        fontSize: 22,
        fontWeight: '700',
        letterSpacing: 0,
    },
    headerSubtitle: {
        fontSize: 13,
        lineHeight: 18,
        marginTop: 4,
    },
    empty: {
        alignItems: 'center',
        flex: 1,
        justifyContent: 'center',
        paddingHorizontal: 28,
    },
    emptyTitle: {
        fontSize: 18,
        fontWeight: '700',
        marginTop: 14,
        textAlign: 'center',
    },
    emptyText: {
        fontSize: 14,
        lineHeight: 20,
        marginTop: 8,
        textAlign: 'center',
    },
    guard: {
        alignItems: 'center',
        flex: 1,
        justifyContent: 'center',
    },
}));
