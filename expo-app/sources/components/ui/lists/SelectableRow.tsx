import * as React from 'react';
import { Platform, Pressable, Text, View, type StyleProp, type ViewStyle, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export type SelectableRowVariant = 'slim' | 'default' | 'selectable';

export type SelectableRowProps = Readonly<{
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    left?: React.ReactNode;
    right?: React.ReactNode;

    selected?: boolean;
    disabled?: boolean;
    destructive?: boolean;

    variant?: SelectableRowVariant;
    onPress?: () => void;
    onHover?: () => void;

    containerStyle?: StyleProp<ViewStyle>;
    titleStyle?: StyleProp<TextStyle>;
    subtitleStyle?: StyleProp<TextStyle>;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 10,
        backgroundColor: 'transparent',
    },
    rowSlim: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 0,
    },
    rowDefault: {
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    rowSelectable: {
        // Match historical CommandPalette look
        paddingHorizontal: 24,
        paddingVertical: 12,
        marginHorizontal: 8,
        marginVertical: 2,
        borderRadius: 8,
        borderWidth: 2,
        borderColor: 'transparent',
    },
    rowPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    rowHovered: {
        backgroundColor: theme.colors.surfacePressed,
    },
    rowSelected: {
        backgroundColor: theme.colors.surfacePressedOverlay,
        borderColor: theme.colors.divider,
    },
    // Palette variant states (match old CommandPaletteItem styles exactly)
    rowSelectablePressed: {
        backgroundColor: '#F5F5F5',
    },
    rowSelectableHovered: {
        backgroundColor: '#F8F8F8',
    },
    rowSelectableSelected: {
        backgroundColor: '#F0F7FF',
        borderColor: '#007AFF20',
    },
    rowDisabled: {
        opacity: 0.5,
    },
    left: {
        marginRight: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    content: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        ...Typography.default(),
        color: theme.colors.text,
        fontSize: Platform.select({ ios: 16, default: 15 }),
        lineHeight: Platform.select({ ios: 20, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.2, default: 0 }),
    },
    titleSelectable: {
        color: '#000',
        fontSize: 15,
        letterSpacing: -0.2,
    },
    titleDestructive: {
        color: theme.colors.textDestructive,
    },
    subtitle: {
        ...Typography.default(),
        marginTop: 2,
        color: theme.colors.textSecondary,
        fontSize: Platform.select({ ios: 13, default: 13 }),
        lineHeight: 18,
    },
    subtitleSelectable: {
        color: '#666',
        letterSpacing: -0.1,
    },
    right: {
        marginLeft: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

export function SelectableRow(props: SelectableRowProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [isHovered, setIsHovered] = React.useState(false);

    const variant: SelectableRowVariant = props.variant ?? 'default';
    const selected = Boolean(props.selected);
    const disabled = Boolean(props.disabled);

    const canHover = Platform.OS === 'web' && !disabled;

    const pressableProps: any = {};
    if (Platform.OS === 'web') {
        pressableProps.onMouseEnter = () => {
            if (!canHover) return;
            setIsHovered(true);
            props.onHover?.();
        };
        pressableProps.onMouseLeave = () => {
            if (!canHover) return;
            setIsHovered(false);
        };
    }

    const rowVariantStyle =
        variant === 'slim'
            ? styles.rowSlim
            : variant === 'selectable'
                ? styles.rowSelectable
                : styles.rowDefault;

    const titleColorStyle = props.destructive ? styles.titleDestructive : null;
    const titleVariantStyle = variant === 'selectable' ? styles.titleSelectable : null;
    const subtitleVariantStyle = variant === 'selectable' ? styles.subtitleSelectable : null;

    return (
        <Pressable
            onPress={disabled ? undefined : props.onPress}
            disabled={disabled}
            accessibilityRole={props.onPress ? 'button' : undefined}
            style={({ pressed }) => ([
                styles.row,
                rowVariantStyle,
                pressed && !disabled
                    ? (variant === 'selectable' ? styles.rowSelectablePressed : styles.rowPressed)
                    : null,
                isHovered && !selected && !disabled
                    ? (variant === 'selectable' ? styles.rowSelectableHovered : styles.rowHovered)
                    : null,
                selected
                    ? (variant === 'selectable' ? styles.rowSelectableSelected : styles.rowSelected)
                    : null,
                disabled ? styles.rowDisabled : null,
                props.containerStyle,
            ])}
            {...pressableProps}
        >
            {props.left ? (
                <View style={styles.left}>
                    {props.left}
                </View>
            ) : null}

            <View style={styles.content}>
                <Text style={[styles.title, titleVariantStyle, titleColorStyle, props.titleStyle]} numberOfLines={1}>
                    {props.title}
                </Text>
                {props.subtitle ? (
                    <Text style={[styles.subtitle, subtitleVariantStyle, props.subtitleStyle]} numberOfLines={2}>
                        {props.subtitle}
                    </Text>
                ) : null}
            </View>

            {props.right ? (
                <View style={styles.right}>
                    {props.right}
                </View>
            ) : null}
        </Pressable>
    );
}

