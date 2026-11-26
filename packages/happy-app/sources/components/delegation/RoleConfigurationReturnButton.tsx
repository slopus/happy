import * as React from 'react';
import { Pressable, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

/** The return action belongs to the existing workspace header, not the input. */
export function RoleConfigurationReturnButton({ onPress }: { onPress: () => void | Promise<void> }) {
    const { theme } = useUnistyles();
    return <Pressable testID="role-configuration-return" accessibilityRole="button" accessibilityLabel={t('delegation.returnToSettings')}
        onPress={() => { void onPress(); }} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
        <Ionicons name="arrow-back-outline" size={16} color={theme.colors.text} /><Text style={styles.label}>{t('delegation.returnToSettings')}</Text>
    </Pressable>;
}
const styles = StyleSheet.create(theme => ({
    button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: 10, minHeight: 40, borderRadius: 7, backgroundColor: theme.colors.surface },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    label: { color: theme.colors.text, fontSize: 13, lineHeight: 18 },
}));
