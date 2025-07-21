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
        dividerInset = 16,
        pressableStyle
    } = props;

    const isInteractive = onPress || onLongPress;
    const showAccessory = isInteractive && showChevron && !rightElement;

    const content = (
        <>
            <View className="flex-row items-center px-4 py-3 min-h-[44px]" style={style}>
                {/* Left Section */}
                {(icon || leftElement) && (
                    <View className="mr-3">
                        {leftElement || icon}
                    </View>
                )}

                {/* Center Section */}
                <View className="flex-1 justify-center">
                    <Text 
                        className="text-base"
                        style={[
                            Typography.default('regular'),
                            {
                                color: destructive ? '#FF3B30' : (selected ? '#007AFF' : '#000'),
                                fontSize: 17,
                                lineHeight: 22
                            },
                            titleStyle
                        ]}
                        numberOfLines={1}
                    >
                        {title}
                    </Text>
                    {subtitle && (
                        <Text 
                            className="text-sm mt-0.5"
                            style={[
                                Typography.default('regular'),
                                {
                                    color: '#8E8E93',
                                    fontSize: 15,
                                    lineHeight: 20
                                },
                                subtitleStyle
                            ]}
                            numberOfLines={2}
                        >
                            {subtitle}
                        </Text>
                    )}
                </View>

                {/* Right Section */}
                <View className="flex-row items-center ml-2">
                    {detail && !rightElement && (
                        <Text 
                            className="mr-2"
                            style={[
                                Typography.default('regular'),
                                {
                                    color: '#8E8E93',
                                    fontSize: 17
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
                            style={{ marginRight: 8 }}
                        />
                    )}
                    {rightElement}
                    {showAccessory && (
                        <Ionicons 
                            name="chevron-forward" 
                            size={20} 
                            color="#C7C7CC"
                        />
                    )}
                </View>
            </View>

            {/* Divider */}
            {showDivider && (
                <View 
                    className="h-px bg-gray-200"
                    style={{ 
                        marginLeft: dividerInset + (icon || leftElement ? 52 : 0),
                        backgroundColor: '#C6C6C8',
                        opacity: 0.5
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