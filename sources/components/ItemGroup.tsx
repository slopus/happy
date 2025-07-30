import * as React from 'react';
import { 
    View, 
    Text, 
    StyleProp, 
    ViewStyle, 
    TextStyle,
    Platform
} from 'react-native';
import { Typography } from '@/constants/Typography';
import { layout } from './layout';

interface ItemChildProps {
    showDivider?: boolean;
    [key: string]: any;
}

export interface ItemGroupProps {
    title?: string;
    footer?: string;
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    headerStyle?: StyleProp<ViewStyle>;
    footerStyle?: StyleProp<ViewStyle>;
    titleStyle?: StyleProp<TextStyle>;
    footerTextStyle?: StyleProp<TextStyle>;
    containerStyle?: StyleProp<ViewStyle>;
}

export const ItemGroup = React.memo<ItemGroupProps>((props) => {
    const {
        title,
        footer,
        children,
        style,
        headerStyle,
        footerStyle,
        titleStyle,
        footerTextStyle,
        containerStyle
    } = props;

    // Platform-specific measurements
    const isIOS = Platform.OS === 'ios';
    const isAndroid = Platform.OS === 'android';
    const headerPaddingTop = isIOS ? 35 : 16;
    const headerPaddingBottom = isIOS ? 6 : 8;
    const footerPaddingTop = isIOS ? 6 : 8;
    const footerPaddingBottom = isIOS ? 8 : 16;
    const horizontalMargin = isIOS ? 16 : 12;
    const borderRadius = isIOS ? 10 : 16; // Material 3 Expressive rounded corners

    return (
        <View style={[{ alignItems: 'center' }, style]}>
            <View style={{ width: '100%', maxWidth: layout.maxWidth, paddingHorizontal: isAndroid ? 4 : 0 }}>
                {/* Header */}
                {title && (
                    <View 
                        style={[
                            {
                                paddingTop: headerPaddingTop,
                                paddingBottom: headerPaddingBottom,
                                paddingHorizontal: isIOS ? 32 : 24,
                            },
                            headerStyle
                        ]}
                    >
                        <Text 
                            style={[
                                Typography.default('regular'),
                                {
                                    color: Platform.select({
                                        ios: '#8E8E93',
                                        android: '#49454F', // Material 3 onSurfaceVariant
                                        default: '#8E8E93'
                                    }),
                                    fontSize: isIOS ? 13 : 14,
                                    lineHeight: isIOS ? 18 : 20,
                                    letterSpacing: isIOS ? -0.08 : 0.1,
                                    textTransform: 'uppercase',
                                    fontWeight: isAndroid ? '500' : 'normal'
                                },
                                titleStyle
                            ]}
                        >
                            {title}
                        </Text>
                    </View>
                )}

                {/* Content Container */}
                <View 
                    style={[
                        {
                            backgroundColor: '#FFFFFF',
                            marginHorizontal: horizontalMargin,
                            borderRadius: borderRadius,
                            overflow: 'hidden',
                            ...(isIOS && {
                                shadowColor: '#000',
                                shadowOffset: { width: 0, height: 0.33 },
                                shadowOpacity: 0.05,
                                shadowRadius: 0
                            }),
                            ...(isAndroid && {
                                elevation: 1, // Subtle elevation for Android
                            })
                        },
                        containerStyle
                    ]}
                >
                    {React.Children.map(children, (child, index) => {
                        if (React.isValidElement<ItemChildProps>(child)) {
                            const isLast = index === React.Children.count(children) - 1;
                            const childProps = child.props as ItemChildProps;
                            return React.cloneElement(child, {
                                ...childProps,
                                showDivider: !isLast && childProps.showDivider !== false
                            });
                        }
                        return child;
                    })}
                </View>

                {/* Footer */}
                {footer && (
                    <View 
                        style={[
                            {
                                paddingTop: footerPaddingTop,
                                paddingBottom: footerPaddingBottom,
                                paddingHorizontal: isIOS ? 32 : 24,
                            },
                            footerStyle
                        ]}
                    >
                        <Text 
                            style={[
                                Typography.default('regular'),
                                {
                                    color: Platform.select({
                                        ios: '#8E8E93',
                                        android: '#49454F', // Material 3 onSurfaceVariant
                                        default: '#8E8E93'
                                    }),
                                    fontSize: isIOS ? 13 : 14,
                                    lineHeight: isIOS ? 18 : 20,
                                    letterSpacing: isIOS ? -0.08 : 0
                                },
                                footerTextStyle
                            ]}
                        >
                            {footer}
                        </Text>
                    </View>
                )}
            </View>
        </View>
    );
});