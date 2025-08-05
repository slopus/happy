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
    title?: string | React.ReactNode;
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
    const isWeb = Platform.OS === 'web';
    const headerPaddingTop = (isIOS && !isWeb) ? 35 : 16;
    const headerPaddingBottom = (isIOS && !isWeb) ? 6 : 8;
    const footerPaddingTop = (isIOS && !isWeb) ? 6 : 8;
    const footerPaddingBottom = (isIOS && !isWeb) ? 8 : 16;
    const horizontalMargin = (isIOS && !isWeb) ? 16 : 12;
    const borderRadius = (isIOS && !isWeb) ? 10 : 16; // Material 3 Expressive rounded corners

    return (
        <View style={[{ alignItems: 'center' }, style]}>
            <View style={{ width: '100%', maxWidth: layout.maxWidth, paddingHorizontal: (isAndroid || isWeb) ? 4 : 0 }}>
                {/* Header */}
                {title ? (
                    <View 
                        style={[
                            {
                                paddingTop: headerPaddingTop,
                                paddingBottom: headerPaddingBottom,
                                paddingHorizontal: (isIOS && !isWeb) ? 32 : 24,
                            },
                            headerStyle
                        ]}
                    >
                        {typeof title === 'string' ? (
                            <Text 
                                style={[
                                    Typography.default('regular'),
                                    {
                                        color: Platform.select({
                                            ios: '#8E8E93',
                                            android: '#49454F', // Material 3 onSurfaceVariant
                                            default: '#8E8E93'
                                        }),
                                        fontSize: (isIOS && !isWeb) ? 13 : 14,
                                        lineHeight: (isIOS && !isWeb) ? 18 : 20,
                                        letterSpacing: (isIOS && !isWeb) ? -0.08 : 0.1,
                                        textTransform: 'uppercase',
                                        fontWeight: (isAndroid || isWeb) ? '500' : 'normal'
                                    },
                                    titleStyle
                                ]}
                            >
                                {title}
                            </Text>
                        ) : (
                            title
                        )}
                    </View>
                ) : (
                    // Add top margin when there's no title
                    <View style={{ paddingTop: (isIOS && !isWeb) ? 20 : 16 }} />
                )}

                {/* Content Container */}
                <View 
                    style={[
                        {
                            backgroundColor: '#FFFFFF',
                            marginHorizontal: horizontalMargin,
                            borderRadius: borderRadius,
                            overflow: 'hidden',
                            ...((isIOS && !isWeb) && {
                                shadowColor: '#000',
                                shadowOffset: { width: 0, height: 0.33 },
                                shadowOpacity: 0.05,
                                shadowRadius: 0
                            }),
                            ...((isAndroid || isWeb) && {
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
                                paddingHorizontal: (isIOS && !isWeb) ? 32 : 24,
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
                                    fontSize: (isIOS && !isWeb) ? 13 : 14,
                                    lineHeight: (isIOS && !isWeb) ? 18 : 20,
                                    letterSpacing: (isIOS && !isWeb) ? -0.08 : 0
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