import * as React from 'react';
import { Platform, View } from 'react-native';
import { Text } from '@/components/StyledText';
import { StyleSheet } from 'react-native-unistyles';
import { SessionsList } from '@/components/SessionsList';
import { useArchivedSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * The archive: sessions the user filed away, hidden from the main list.
 *
 * Deliberately the same list component as the main screen — same rows, same
 * grouping, same long-press actions (which offer "move out of archive" instead
 * of "archive" for anything shown here). Nothing on this screen is a different
 * kind of session; they only differ by where the user chose to keep them.
 */
export default React.memo(function ArchiveScreen() {
    const items = useArchivedSessionListViewData();

    const empty = React.useMemo(() => (
        <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{t('archive.empty')}</Text>
            <Text style={styles.emptyDescription}>{t('archive.emptyDescription')}</Text>
        </View>
    ), []);

    return (
        <View style={styles.container}>
            <SessionsList items={items} emptyComponent={empty} bottomContentInset={32} />
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        // Same pattern as every other sub-screen (session/recent,
        // text-selection): mobile stays transparent so the shared glass
        // backdrop shows through under the translucent native header —
        // an opaque fill here gave this screen a flat, different-looking
        // header in both themes.
        backgroundColor: Platform.select({ web: theme.colors.groupped.background, default: 'transparent' }),
    },
    empty: {
        paddingTop: 64,
        paddingHorizontal: 32,
        alignItems: 'center',
        gap: 8,
    },
    emptyTitle: {
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    emptyDescription: {
        fontSize: 14,
        lineHeight: 20,
        textAlign: 'center',
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));
