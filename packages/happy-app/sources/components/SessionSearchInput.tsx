import * as React from 'react';
import { View, TextInput } from 'react-native';
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
        backgroundColor: theme.colors.surface,
        color: theme.colors.text,
        fontSize: 14,
        ...Typography.default(),
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
}: {
    value: string;
    onChangeText: (text: string) => void;
    topInset?: number;
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
        </View>
    );
});
