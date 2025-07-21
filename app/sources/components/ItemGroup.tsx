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

    return (
        <View style={style}>
            {/* Header */}
            {title && (
                <View 
                    className="px-4 pb-2"
                    style={[
                        {
                            paddingTop: Platform.OS === 'ios' ? 22 : 16,
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
                className="bg-white"
                style={[
                    Platform.OS === 'ios' ? {
                        borderRadius: 10,
                        marginHorizontal: 16,
                        overflow: 'hidden'
                    } : {},
                    containerStyle
                ]}
            >
                {React.Children.map(children, (child, index) => {
                    if (React.isValidElement(child)) {
                        const isLast = index === React.Children.count(children) - 1;
                        return React.cloneElement(child as React.ReactElement<any>, {
                            showDivider: !isLast && child.props.showDivider !== false,
                            ...child.props
                        });
                    }
                    return child;
                })}
            </View>

            {/* Footer */}
            {footer && (
                <View 
                    className="px-8 pt-2"
                    style={[
                        {
                            paddingBottom: 16,
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
                                letterSpacing: -0.08,
                                lineHeight: 18
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