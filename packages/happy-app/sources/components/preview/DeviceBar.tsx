import * as React from 'react';
import { View, ScrollView, Pressable, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { VIEWPORT_PRESETS, type ViewportPreset } from '@slopus/happy-wire';

interface DeviceBarProps {
    activePreset: string;
    rotated: boolean;
    onSelectPreset: (presetId: string) => void;
    onToggleRotate: () => void;
}

export const DeviceBar = React.memo(({
    activePreset,
    rotated,
    onSelectPreset,
    onToggleRotate,
}: DeviceBarProps) => {
    const { theme } = useUnistyles();
    const isAuto = activePreset === 'auto';
    const activeItem = VIEWPORT_PRESETS.find((p) => p.id === activePreset);
    const showRotate = !isAuto && activeItem && activeItem.width !== null;

    return (
        <View style={styles.container}>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.scrollContent}
            >
                {VIEWPORT_PRESETS.map((preset) => {
                    const isActive = preset.id === activePreset;
                    return (
                        <Pressable
                            key={preset.id}
                            onPress={() => onSelectPreset(preset.id)}
                            style={[
                                styles.chip,
                                {
                                    backgroundColor: isActive
                                        ? 'rgba(99, 132, 255, 0.2)'
                                        : theme.colors.groupped.background,
                                    borderWidth: 1,
                                    borderColor: isActive
                                        ? 'rgba(99, 132, 255, 0.6)'
                                        : 'transparent',
                                },
                            ]}
                        >
                            <Ionicons
                                name={preset.icon}
                                size={12}
                                color={isActive ? '#6384FF' : theme.colors.textSecondary}
                            />
                            <Text
                                style={[
                                    styles.chipText,
                                    {
                                        color: isActive
                                            ? '#6384FF'
                                            : theme.colors.text,
                                    },
                                ]}
                                numberOfLines={1}
                            >
                                {preset.label}
                            </Text>
                            {preset.width && (
                                <Text
                                    style={[
                                        styles.chipSize,
                                        {
                                            color: isActive
                                                ? 'rgba(99, 132, 255, 0.8)'
                                                : theme.colors.textSecondary,
                                        },
                                    ]}
                                    numberOfLines={1}
                                >
                                    {rotated ? `${preset.height}\u00D7${preset.width}` : `${preset.width}\u00D7${preset.height}`}
                                </Text>
                            )}
                        </Pressable>
                    );
                })}
            </ScrollView>
            {showRotate && (
                <Pressable onPress={onToggleRotate} hitSlop={6} style={styles.rotateButton}>
                    <Ionicons
                        name={rotated ? 'phone-landscape-outline' : 'phone-portrait-outline'}
                        size={16}
                        color={theme.colors.textSecondary}
                    />
                </Pressable>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        height: 36,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
        paddingRight: 8,
    },
    scrollContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 8,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
    },
    chipText: {
        ...Typography.default('semiBold'),
        fontSize: 11,
    },
    chipSize: {
        ...Typography.mono(),
        fontSize: 9,
    },
    rotateButton: {
        paddingLeft: 4,
    },
}));
