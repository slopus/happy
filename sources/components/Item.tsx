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
        dividerInset = Platform.OS === 'ios' ? 15 : 16,
        pressableStyle
    } = props;

    const isInteractive = onPress || onLongPress;
    const showAccessory = isInteractive && showChevron && !rightElement;

    // iOS-specific measurements
    const horizontalPadding = Platform.OS === 'ios' ? 16 : 16;
    const iconSize = 29; // Standard iOS icon size in table cells
    const chevronSize = Platform.OS === 'ios' ? 17 : 20;
    const minHeight = 44; // iOS standard touch target

    const content = (
        <>
            <View 
                style={[
                    {
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: horizontalPadding,
                        minHeight: minHeight,
                        paddingVertical: subtitle ? 11 : 12, // Adjust for subtitle
                    },
                    style
                ]}
            >
                {/* Left Section */}
                {(icon || leftElement) && (
                    <View style={{ 
                        marginRight: Platform.OS === 'ios' ? 15 : 12,
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
                                color: destructive ? '#FF3B30' : (selected ? '#007AFF' : '#000000'),
                                fontSize: 17,
                                lineHeight: 22,
                                letterSpacing: -0.41
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
                                    color: '#8E8E93',
                                    fontSize: 15,
                                    lineHeight: 20,
                                    letterSpacing: -0.24,
                                    marginTop: 2
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
                                    color: '#8E8E93',
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
                            color="#8E8E93"
                            style={{ marginRight: showAccessory ? 6 : 0 }}
                        />
                    )}
                    {rightElement}
                    {showAccessory && (
                        <Ionicons 
                            name="chevron-forward" 
                            size={chevronSize} 
                            color="#C7C7CC"
                            style={{ marginLeft: 4 }}
                        />
                    )}
                </View>
            </View>

            {/* Divider */}
            {showDivider && (
                <View 
                    style={{ 
                        height: Platform.OS === 'ios' ? 0.33 : 0.5,
                        backgroundColor: '#C6C6C8',
                        marginLeft: dividerInset + (icon || leftElement ? (horizontalPadding + iconSize + 15) : horizontalPadding)
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
                        backgroundColor: pressed ? '#D1D1D6' : 'transparent',
                        opacity: disabled ? 0.5 : 1
                    },
                    pressableStyle
                ]}
            >
                {content}
            </Pressable>
        );
    }

    return <View style={[{ opacity: disabled ? 0.5 : 1 }, pressableStyle]}>{content}</View>;
});