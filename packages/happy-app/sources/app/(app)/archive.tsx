import * as React from 'react';
import { Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/StyledText';
import { StyleSheet } from 'react-native-unistyles';
import { ChatHeaderView } from '@/components/ChatHeaderView';
import { SessionsList } from '@/components/SessionsList';
import { useArchivedSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { useHeaderHeight } from '@/utils/responsive';
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
    const router = useRouter();
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    // The overlay header occupies the status bar inset PLUS the header row —
    // useHeaderHeight alone left the list starting under the status bar.
    const headerInset = safeArea.top + headerHeight;

    const empty = React.useMemo(() => (
        <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{t('archive.empty')}</Text>
            <Text style={styles.emptyDescription}>{t('archive.emptyDescription')}</Text>
        </View>
    ), []);

    return (
        <View style={styles.container}>
            <SessionsList
                items={items}
                emptyComponent={empty}
                topContentInset={headerInset}
                bottomContentInset={32}
            />
            {/* The same overlay header the chat screen uses (glass scrim +
                round back control) instead of the native stack header, so
                this screen reads like the main list and the chat. */}
            <View style={styles.headerOverlay}>
                <ChatHeaderView title={t('archive.title')} onBackPress={() => router.back()} />
            </View>
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
    headerOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1000,
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
