import * as React from 'react';
import { 
    View, 
    Text, 
    Pressable, 
    StyleProp, 
    ViewStyle, 
    TextStyle,
    Platform,
    ActivityIndicator
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ItemGroupSelectionContext } from '@/components/ui/lists/ItemGroup';
import { useItemGroupRowPosition } from '@/components/ui/lists/ItemGroupRowPosition';
import { getItemGroupRowCornerRadii } from '@/components/ui/lists/itemGroupRowCorners';

export interface ItemProps {
    title: string;
    subtitle?: React.ReactNode;
    subtitleLines?: number; // set 0 or undefined for auto/multiline
    detail?: string;
    icon?: React.ReactNode;
    leftElement?: React.ReactNode;
    rightElement?: React.ReactNode;
    onPress?: () => void;
    onLongPress?: () => void;
    disabled?: boolean;
    loading?: boolean;
    selected?: boolean;
    destructive?: boolean;
    style?: StyleProp<ViewStyle>;
    titleStyle?: StyleProp<TextStyle>;
    subtitleStyle?: StyleProp<TextStyle>;
    detailStyle?: StyleProp<TextStyle>;
    showChevron?: boolean;
    showDivider?: boolean;
    dividerInset?: number;
    pressableStyle?: StyleProp<ViewStyle>;
    copy?: boolean | string;
}

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        minHeight: Platform.select({ ios: 44, default: 56 }),
    },
    containerWithSubtitle: {
        paddingVertical: Platform.select({ ios: 11, default: 16 }),
    },
    containerWithoutSubtitle: {
        paddingVertical: Platform.select({ ios: 12, default: 16 }),
    },
    iconContainer: {
        marginRight: 12,
        width: Platform.select({ ios: 29, default: 32 }),
        height: Platform.select({ ios: 29, default: 32 }),
        alignItems: 'center',
        justifyContent: 'center',
    },
    centerContent: {
        flex: 1,
        justifyContent: 'center',
    },
    title: {
        ...Typography.default('regular'),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
    },
    titleNormal: {
        color: theme.colors.text,
    },
    titleSelected: {
        color: theme.colors.text,
    },
    titleDestructive: {
        color: theme.colors.textDestructive,
    },
    subtitle: {
        ...Typography.default('regular'),
        color: theme.colors.textSecondary,
        fontSize: Platform.select({ ios: 15, default: 14 }),
        lineHeight: 20,
        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
        marginTop: Platform.select({ ios: 2, default: 0 }),
    },
    rightSection: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: 8,
    },
    detail: {
        ...Typography.default('regular'),
        color: theme.colors.textSecondary,
        fontSize: 17,
        letterSpacing: -0.41,
    },
    divider: {
        height: Platform.select({ ios: 0.33, default: 0 }),
        backgroundColor: theme.colors.divider,
    },
    pressablePressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
}));

export const Item = React.memo<ItemProps>((props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const selectionContext = React.useContext(ItemGroupSelectionContext);
    const rowPosition = useItemGroupRowPosition();

    // Platform-specific measurements
    const isIOS = Platform.OS === 'ios';
    const isAndroid = Platform.OS === 'android';
    const isWeb = Platform.OS === 'web';
    const hoverBackgroundColor = isWeb
        ? (theme.dark ? theme.colors.surfaceHighest : theme.colors.surfaceHigh)
        : theme.colors.surfacePressedOverlay;
    
    // Timer ref for long press copy functionality
    const longPressTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    
    const {
        title,
        subtitle,
        subtitleLines,
        detail,
        icon,
        leftElement,
        rightElement,
        onPress,
        onLongPress,
        disabled,
        loading,
        selected,
        destructive,
        style,
        titleStyle,
        subtitleStyle,
        detailStyle,
        showChevron = true,
        showDivider = true,
        dividerInset = isIOS ? 15 : 16,
        pressableStyle,
        copy
    } = props;

    // Handle copy functionality
    const handleCopy = React.useCallback(async () => {
        if (!copy || isWeb) return;
        
        let textToCopy: string;
        const subtitleText = typeof subtitle === 'string' ? subtitle : null;
        
        if (typeof copy === 'string') {
            // If copy is a string, use it directly
            textToCopy = copy;
        } else {
            // If copy is true, try to figure out what to copy
            // Priority: detail > subtitle > title
            textToCopy = detail || subtitleText || title;
        }
        
        try {
            await Clipboard.setStringAsync(textToCopy);
            Modal.alert(t('common.copied'), t('items.copiedToClipboard', { label: title }));
        } catch (error) {
            console.error('Failed to copy:', error);
        }
    }, [copy, isWeb, title, subtitle, detail]);
    
    // Handle long press for copy functionality
    const handlePressIn = React.useCallback(() => {
        if (copy && !isWeb && !onPress) {
            longPressTimer.current = setTimeout(() => {
                handleCopy();
            }, 500); // 500ms delay for long press
        }
    }, [copy, isWeb, onPress, handleCopy]);
    
    const handlePressOut = React.useCallback(() => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    }, []);
    
    // Clean up timer on unmount
    React.useEffect(() => {
        return () => {
            if (longPressTimer.current) {
                clearTimeout(longPressTimer.current);
            }
        };
    }, []);
    
    // If copy is enabled and no onPress is provided, don't set a regular press handler
    // The copy will be handled by long press instead
    const handlePress = onPress;

    const isInteractive = handlePress || onLongPress || (copy && !isWeb);
    const showAccessory = isInteractive && showChevron && !rightElement;
    const chevronSize = (isIOS && !isWeb) ? 17 : 24;
    const showSelectedBackground = !!selected && ((selectionContext?.selectableItemCount ?? 2) > 1);
    const groupCornerRadius = Platform.select({ ios: 10, default: 16 });

    const titleColor = destructive ? styles.titleDestructive : (selected ? styles.titleSelected : styles.titleNormal);
    const containerPadding = subtitle ? styles.containerWithSubtitle : styles.containerWithoutSubtitle;

    const isSelectableRow = React.useMemo(() => {
        // Only show hover for "selection lists" (where rows participate in a selected-state group).
        // This avoids making all navigation rows hoverable.
        // NOTE: we intentionally do NOT gate on `selectableItemCount > 1` because single-item
        // selection lists should still have hover affordances.
        return typeof selected === 'boolean' && Boolean(selectionContext);
    }, [selected, selectionContext]);

    const [isHovered, setIsHovered] = React.useState(false);
    React.useEffect(() => {
        // Keep hover state coherent with disabled/loading changes.
        if (disabled || loading) setIsHovered(false);
    }, [disabled, loading]);
    
    const content = (
        <>
            <View style={[styles.container, containerPadding, style]}>
                {/* Left Section */}
                {(icon || leftElement) && (
                    <View style={styles.iconContainer}>
                        {leftElement || icon}
                    </View>
                )}

                {/* Center Section */}
                <View style={styles.centerContent}>
                    <Text 
                        style={[styles.title, titleColor, titleStyle]}
                        numberOfLines={subtitle ? 1 : 2}
                    >
                        {title}
                    </Text>
                    {subtitle && (() => {
                        // If subtitle is a ReactNode (not string), render as-is.
                        // This enables richer subtitle layouts (e.g. inline glyphs).
                        if (typeof subtitle !== 'string') {
                            return (
                                <View style={{ marginTop: Platform.select({ ios: 2, default: 0 }) }}>
                                    {subtitle}
                                </View>
                            );
                        }

                        // Allow multiline when requested or when content contains line breaks
                        const effectiveLines = subtitleLines !== undefined
                            ? (subtitleLines <= 0 ? undefined : subtitleLines)
                            : (subtitle.indexOf('\n') !== -1 ? undefined : 1);

                        return (
                            <Text
                                style={[styles.subtitle, subtitleStyle]}
                                numberOfLines={effectiveLines}
                            >
                                {subtitle}
                            </Text>
                        );
                    })()}
                </View>

                {/* Right Section */}
                <View style={styles.rightSection}>
                    {detail && !rightElement && (
                        <Text 
                            style={[
                                styles.detail, 
                                { marginRight: showAccessory ? 6 : 0 },
                                detailStyle
                            ]}
                            numberOfLines={1}
                        >
                            {detail}
                        </Text>
                    )}
                    {loading && (
                        <ActivityIndicator 
                            size="small" 
                            color={theme.colors.textSecondary}
                            style={{ marginRight: showAccessory ? 6 : 0 }}
                        />
                    )}
                    {rightElement}
                    {showAccessory && (
                        <Ionicons 
                            name="chevron-forward" 
                            size={chevronSize} 
                            color={theme.colors.groupped.chevron}
                            style={{ marginLeft: 4 }}
                        />
                    )}
                </View>
            </View>

            {/* Divider */}
            {showDivider && (
                <View 
                    style={[
                        styles.divider,
                        { 
                            marginLeft: (isAndroid || isWeb) ? 0 : (dividerInset + (icon || leftElement ? (16 + ((isIOS && !isWeb) ? 29 : 32) + 15) : 16))
                        }
                    ]}
                />
            )}
        </>
    );

    if (isInteractive) {
        return (
            <Pressable
                onPress={handlePress}
                onLongPress={onLongPress}
                onPressIn={handlePressIn}
                onPressOut={handlePressOut}
                onHoverIn={isWeb && isSelectableRow && !disabled && !loading ? () => setIsHovered(true) : undefined}
                onHoverOut={isWeb ? () => setIsHovered(false) : undefined}
                disabled={disabled || loading}
                style={({ pressed }) => {
                    const backgroundColor = (() => {
                        if (pressed && isIOS && !isWeb) return theme.colors.surfacePressedOverlay;
                        if (showSelectedBackground) return theme.colors.surfaceSelected;
                        // Web-only hover affordance for selectable rows (no hover when disabled).
                        if (isWeb && isSelectableRow && isHovered && !disabled && !loading) return hoverBackgroundColor;
                        return 'transparent';
                    })();

                    const roundedCornersStyle = getItemGroupRowCornerRadii({
                        hasBackground: backgroundColor !== 'transparent',
                        position: rowPosition,
                        radius: groupCornerRadius,
                    });

                    return [
                        { backgroundColor, opacity: disabled ? 0.5 : 1 },
                        roundedCornersStyle,
                        pressableStyle,
                    ];
                }}
                android_ripple={(isAndroid || isWeb) ? {
                    color: theme.colors.surfaceRipple,
                    borderless: false,
                    foreground: true
                } : undefined}
            >
                {content}
            </Pressable>
        );
    }

    return <View style={[{ opacity: disabled ? 0.5 : 1 }, pressableStyle]}>{content}</View>;
});
