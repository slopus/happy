import React from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export interface OptionTile<T extends string> {
    id: T;
    title: string;
    subtitle?: string;
    icon?: React.ComponentProps<typeof Ionicons>['name'];
    disabled?: boolean;
}

export interface OptionTilesProps<T extends string> {
    options: Array<OptionTile<T>>;
    value: T | null;
    onChange: (next: T | null) => void;
}

export function OptionTiles<T extends string>(props: OptionTilesProps<T>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const [width, setWidth] = React.useState<number>(0);
    const columns = React.useMemo(() => {
        // Avoid the awkward 2+1 layout for 3 options.
        if (props.options.length === 3) {
            return width >= 560 ? 3 : 1;
        }
        if (width >= 640) return Math.min(3, props.options.length);
        if (width >= 420) return Math.min(2, props.options.length);
        return 1;
    }, [props.options.length, width]);

    const gap = 10;
    const tileWidth = React.useMemo(() => {
        if (width <= 0) return undefined;
        const totalGap = gap * (columns - 1);
        return Math.floor((width - totalGap) / columns);
    }, [columns, width]);

    return (
        <View
            onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
            style={[
                styles.grid,
                { flexDirection: 'row', flexWrap: 'wrap', gap },
            ]}
        >
            {props.options.map((opt) => {
                const selected = props.value === opt.id;
                const disabled = opt.disabled === true;
                return (
                    <Pressable
                        key={opt.id}
                        disabled={disabled}
                        onPress={() => {
                            if (disabled) return;
                            props.onChange(opt.id);
                        }}
                        style={({ pressed }) => [
                            styles.tile,
                            tileWidth ? { width: tileWidth } : null,
                            {
                                borderColor: selected ? theme.colors.button.primary.background : theme.colors.divider,
                                opacity: disabled ? 0.45 : (pressed ? 0.85 : 1),
                            },
                        ]}
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                            <View style={styles.iconSlot}>
                                <Ionicons
                                    name={opt.icon ?? (selected ? 'checkmark-circle-outline' : 'ellipse-outline')}
                                    size={29}
                                    color={theme.colors.textSecondary}
                                />
                            </View>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.title} numberOfLines={2}>{opt.title}</Text>
                                {opt.subtitle ? (
                                    <Text style={styles.subtitle} numberOfLines={3}>{opt.subtitle}</Text>
                                ) : null}
                            </View>
                        </View>
                    </Pressable>
                );
            })}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    grid: {
        // Intentionally transparent: this component is meant to sit directly on
        // the screen/group background (so gutters are visible between tiles).
    },
    tile: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        borderWidth: 2,
        padding: 12,
        paddingTop: 16,
        paddingBottom: 20
    },
    iconSlot: {
        width: 29,
        height: 29,
        alignItems: 'center',
        justifyContent: 'center',
    },
    title: {
        ...Typography.default('regular'),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
        color: theme.colors.text,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: Platform.select({ ios: 15, default: 14 }),
        lineHeight: 20,
        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
        color: theme.colors.textSecondary,
    },
}));
