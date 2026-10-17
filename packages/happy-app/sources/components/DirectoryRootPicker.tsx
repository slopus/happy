/** Shared home / mounted-volume shortcuts for remote directory browsers. */
import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { BrowseDirectoryRoot } from '@/sync/ops';
import { t } from '@/text';

export function DirectoryRootPicker({ roots, currentPath, disabled, onSelect }: {
    roots: BrowseDirectoryRoot[];
    currentPath?: string | null;
    disabled?: boolean;
    onSelect: (path: string) => void;
}) {
    const { theme } = useUnistyles();
    if (roots.length === 0) return null; // Older daemons do not advertise roots.
    return (
        <View style={styles.container}>
            <Text style={styles.label}>{t('directoryPicker.locations')}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.locations} keyboardShouldPersistTaps="handled">
                {roots.map((root) => {
                    const selected = currentPath === root.path || currentPath?.startsWith(`${root.path}/`) || currentPath?.startsWith(`${root.path}\\`);
                    const label = root.kind === 'home' ? t('directoryPicker.home') : root.name;
                    return (
                        <Pressable
                            key={root.path}
                            testID={`directory-root-${root.path}`}
                            accessibilityRole="button"
                            accessibilityLabel={label}
                            accessibilityState={{ selected: !!selected, disabled: !!disabled }}
                            disabled={disabled}
                            onPress={() => onSelect(root.path)}
                            style={({ pressed }) => [styles.location, selected && styles.selected, pressed && styles.pressed, disabled && styles.disabled]}
                        >
                            <Ionicons name={root.kind === 'home' ? 'home-outline' : 'hardware-chip-outline'} size={16} color={theme.colors.textSecondary} />
                            <Text style={styles.name} numberOfLines={1}>{label}</Text>
                        </Pressable>
                    );
                })}
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: { gap: 6, paddingVertical: 6 },
    label: { color: theme.colors.textSecondary, fontSize: 12 },
    locations: { gap: 8, paddingVertical: 2 },
    location: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40, paddingHorizontal: 10, borderRadius: 8, backgroundColor: theme.colors.surface },
    selected: { backgroundColor: theme.colors.surfaceSelected },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    disabled: { opacity: 0.55 },
    name: { color: theme.colors.text, fontSize: 13, maxWidth: 220 },
}));
