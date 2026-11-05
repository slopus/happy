import * as React from 'react';
import { View, TextInput, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { setSessionSearchQuery, useSessionSearchStore } from './sessionSearchStore';

/**
 * The sessions search box, shown while the header icon has it open. Lives in
 * `HomeListHeader` so the flat list and the project list share it, and reads
 * the store itself so the list header never remounts (and drops focus) as the
 * results change.
 */
export const SessionSearchInput = React.memo(() => {
    const { theme } = useUnistyles();
    const open = useSessionSearchStore((state) => state.open);
    const query = useSessionSearchStore((state) => state.query);
    const loading = useSessionSearchStore((state) => state.loadingHistory);
    if (!open) return null;
    return (
        <View style={styles.container}>
            <TextInput
                style={styles.input}
                value={query}
                onChangeText={setSessionSearchQuery}
                placeholder={t('sessionsFilter.searchPlaceholder')}
                placeholderTextColor={theme.colors.textSecondary}
                accessibilityLabel={t('sessionsFilter.searchPlaceholder')}
                returnKeyType="search"
                autoCorrect={false}
            />
            {loading && (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} style={styles.spinner} />
            )}
        </View>
    );
});

/** Empty-list note while a search is filtering everything out. */
export const SessionSearchNoResults = React.memo(() => (
    <Text style={styles.noResults}>{t('sessionsFilter.noResultsPlaceholder')}</Text>
));

const styles = StyleSheet.create((theme) => ({
    container: {
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    input: {
        height: 36,
        borderRadius: 10,
        paddingLeft: 12,
        // Room for the spinner while history pages in.
        paddingRight: 36,
        backgroundColor: theme.colors.surface,
        color: theme.colors.text,
        fontSize: 14,
        ...Typography.default(),
    },
    spinner: {
        position: 'absolute',
        right: 28,
        top: 8,
    },
    noResults: {
        paddingTop: 24,
        paddingBottom: 16,
        textAlign: 'center',
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));
