import * as React from 'react';
import { View, TextInput, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
    searchInputContainer: {
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    searchInput: {
        height: 36,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingRight: 36,
        backgroundColor: theme.colors.surface,
        color: theme.colors.text,
        fontSize: 14,
        ...Typography.default(),
    },
    // Sits inside the box's right padding while history pages in.
    spinner: {
        position: 'absolute',
        right: 28,
        top: 10,
    },
}));

/**
 * The sessions search box. Rendered by the wrapper above every list state —
 * populated, empty, no-results — so the entry point is always present.
 */
export const SessionSearchInput = React.memo(({
    value,
    onChangeText,
    topInset = 0,
    loading = false,
}: {
    value: string;
    onChangeText: (text: string) => void;
    topInset?: number;
    /** Older sessions are still being fetched; results may grow. */
    loading?: boolean;
}) => {
    const { theme } = useUnistyles();
    return (
        <View style={[styles.searchInputContainer, { paddingTop: topInset }]}>
            <TextInput
                style={styles.searchInput}
                value={value}
                onChangeText={onChangeText}
                placeholder={t('sessionsFilter.searchPlaceholder')}
                placeholderTextColor={theme.colors.textSecondary}
                accessibilityLabel={t('sessionsFilter.searchPlaceholder')}
                returnKeyType="search"
                autoCorrect={false}
            />
            {loading && (
                <ActivityIndicator
                    size="small"
                    color={theme.colors.textSecondary}
                    style={[styles.spinner, { top: 10 + topInset }]}
                />
            )}
        </View>
    );
});
