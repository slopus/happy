import React from 'react';
import { ActivityIndicator, View, Text, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';

export const AccountTransitionScreen = React.memo(function AccountTransitionScreen({ onRetry, onCancel, error = false }: { onRetry: () => void; onCancel?: () => void; error?: boolean }) {
    const { theme } = useUnistyles();
    return <View style={styles.container}>
        <View style={styles.content}>
            {!error && <ActivityIndicator color={theme.colors.textSecondary} />}
            <Text style={styles.title}>{t(error ? 'accounts.restartRequired' : 'accounts.switching')}</Text>
            <Text style={styles.body}>{t('accounts.restartHint')}</Text>
            <Pressable accessibilityRole="button" onPress={onRetry} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
                <Text style={styles.title}>{t('accounts.retry')}</Text>
            </Pressable>
            {error && onCancel && <Pressable accessibilityRole="button" onPress={onCancel} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
                <Text style={styles.title}>{t('accounts.title')}</Text>
            </Pressable>}
        </View>
    </View>;
});

const styles = StyleSheet.create(theme => ({
    container: { flex: 1, backgroundColor: theme.colors.groupped.background, justifyContent: 'center', alignItems: 'center', padding: 24 },
    content: { width: '100%', maxWidth: layout.maxWidth, alignItems: 'center', gap: 20 },
    title: { color: theme.colors.text, fontSize: 18, textAlign: 'center' },
    body: { color: theme.colors.textSecondary, fontSize: 15, textAlign: 'center' },
    button: { paddingHorizontal: 24, paddingVertical: 12, backgroundColor: theme.colors.surface, borderRadius: 12 },
    pressed: { backgroundColor: theme.colors.surfacePressed },
}));
