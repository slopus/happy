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

export interface ItemProps {
    title: string;
    subtitle?: string;
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
}

export const Item = React.memo<ItemProps>((props) => {
    // Platform-specific measurements
    const isIOS = Platform.OS === 'ios';
    const isAndroid = Platform.OS === 'android';
    const isWeb = Platform.OS === 'web';
    
    const {
        title,
        subtitle,
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
        pressableStyle
    } = props;

    const isInteractive = onPress || onLongPress;
    const showAccessory = isInteractive && showChevron && !rightElement;
    const horizontalPadding = 16; // Same for both platforms per Material Design
    const iconSize = (isIOS && !isWeb) ? 29 : 32; // iOS standard vs Material 3 icon container
    const chevronSize = (isIOS && !isWeb) ? 17 : 24;
    const minHeight = (isIOS && !isWeb) ? 44 : 56; // Material 3 list item height

    const content = (
        <>
            <View 
                style={[
                    {
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: horizontalPadding,
                        minHeight: minHeight,
                        paddingVertical: (isIOS && !isWeb) ? (subtitle ? 11 : 12) : 16, // Material 3 consistent padding
                    },
                    style
                ]}
            >
                {/* Left Section */}
                {(icon || leftElement) && (
                    <View style={{ 
                        marginRight: 12,
                        width: iconSize,
                        height: iconSize,
                        alignItems: 'center',
                        justifyContent: 'center'
                    }}>
                        {leftElement || icon}
                    </View>
                )}

                {/* Center Section */}
                <View style={{ flex: 1, justifyContent: 'center' }}>
                    <Text 
                        style={[
                            Typography.default('regular'),
                            {
                                color: destructive ? ((isIOS && !isWeb) ? '#FF3B30' : '#F44336') : (selected ? ((isIOS && !isWeb) ? '#007AFF' : '#1976D2') : '#000000'),
                                fontSize: (isIOS && !isWeb) ? 17 : 16,
                                lineHeight: (isIOS && !isWeb) ? 22 : 24,
                                letterSpacing: (isIOS && !isWeb) ? -0.41 : 0.15
                            },
                            titleStyle
                        ]}
                        numberOfLines={subtitle ? 1 : 2}
                    >
                        {title}
                    </Text>
                    {subtitle && (
                        <Text 
                            style={[
                                Typography.default('regular'),
                                {
                                    color: Platform.select({
                                        ios: '#8E8E93',
                                        android: '#49454F', // Material 3 onSurfaceVariant
                                        default: '#8E8E93'
                                    }),
                                    fontSize: (isIOS && !isWeb) ? 15 : 14,
                                    lineHeight: 20,
                                    letterSpacing: (isIOS && !isWeb) ? -0.24 : 0.1,
                                    marginTop: (isIOS && !isWeb) ? 2 : 0
                                },
                                subtitleStyle
                            ]}
                            numberOfLines={1}
                        >
                            {subtitle}
                        </Text>
                    )}
                </View>

                {/* Right Section */}
                <View style={{ 
                    flexDirection: 'row', 
                    alignItems: 'center',
                    marginLeft: 8
                }}>
                    {detail && !rightElement && (
                        <Text 
                            style={[
                                Typography.default('regular'),
                                {
                                    color: Platform.select({
                                        ios: '#8E8E93',
                                        android: '#49454F', // Material 3 onSurfaceVariant
                                        default: '#8E8E93'
                                    }),
                                    fontSize: 17,
                                    letterSpacing: -0.41,
                                    marginRight: showAccessory ? 6 : 0
                                },
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
                            color={Platform.select({
                                ios: "#8E8E93",
                                android: "#49454F", // Material 3 onSurfaceVariant
                                default: "#8E8E93"
                            })}
                            style={{ marginRight: showAccessory ? 6 : 0 }}
                        />
                    )}
                    {rightElement}
                    {showAccessory && (
                        <Ionicons 
                            name="chevron-forward" 
                            size={chevronSize} 
                            color={Platform.select({
                                ios: "#C7C7CC",
                                android: "#49454F", // Material 3 onSurfaceVariant
                                default: "#C7C7CC"
                            })}
                            style={{ marginLeft: 4 }}
                        />
                    )}
                </View>
            </View>

            {/* Divider */}
            {showDivider && (
                <View 
                    style={{ 
                        height: (isIOS && !isWeb) ? 0.33 : 0,
                        backgroundColor: Platform.select({
                            ios: '#C6C6C8',
                            android: '#CAC4D0', // Material 3 outlineVariant
                            default: '#C6C6C8'
                        }),
                        marginLeft: (isAndroid || isWeb) ? 0 : (dividerInset + (icon || leftElement ? (horizontalPadding + iconSize + 15) : horizontalPadding))
                    }}
                />
            )}
        </>
    );

    if (isInteractive) {
        return (
            <Pressable
                onPress={onPress}
                onLongPress={onLongPress}
                disabled={disabled || loading}
                style={({ pressed }) => [
                    {
                        backgroundColor: pressed && isIOS && !isWeb ? '#D1D1D6' : 'transparent',
                        opacity: disabled ? 0.5 : 1
                    },
                    pressableStyle
                ]}
                android_ripple={(isAndroid || isWeb) ? {
                    color: 'rgba(0, 0, 0, 0.08)',
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