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

    // iOS-specific measurements
    const isIOS = Platform.OS === 'ios';
    const headerPaddingTop = isIOS ? 35 : 24;
    const headerPaddingBottom = 6;
    const footerPaddingTop = 6;
    const footerPaddingBottom = isIOS ? 8 : 16;
    const horizontalMargin = isIOS ? 16 : 0;
    const borderRadius = isIOS ? 10 : 0;

    return (
        <View style={style}>
            {/* Header */}
            {title && (
                <View 
                    style={[
                        {
                            paddingTop: headerPaddingTop,
                            paddingBottom: headerPaddingBottom,
                            paddingHorizontal: isIOS ? 32 : 16,
                        },
                        headerStyle
                    ]}
                >
                    <Text 
                        style={[
                            Typography.default('regular'),
                            {
                                color: '#8E8E93',
                                fontSize: 13,
                                lineHeight: 18,
                                letterSpacing: -0.08,
                                textTransform: 'uppercase'
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
                            paddingHorizontal: isIOS ? 32 : 16,
                        },
                        footerStyle
                    ]}
                >
                    <Text 
                        style={[
                            Typography.default('regular'),
                            {
                                color: '#8E8E93',
                                fontSize: 13,
                                lineHeight: 18,
                                letterSpacing: -0.08
                            },
                            footerTextStyle
                        ]}
                    >
                        {footer}
                    </Text>
                </View>
            )}
        </View>
    );
});