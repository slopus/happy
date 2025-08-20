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
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

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

const stylesheet = StyleSheet.create((theme, runtime) => ({
    wrapper: {
        alignItems: 'center',
    },
    container: {
        width: '100%',
        maxWidth: layout.maxWidth,
        paddingHorizontal: Platform.select({ ios: 0, default: 4 }),
    },
    header: {
        paddingTop: Platform.select({ ios: 35, default: 16 }),
        paddingBottom: Platform.select({ ios: 6, default: 8 }),
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
    },
    headerNoTitle: {
        paddingTop: Platform.select({ ios: 20, default: 16 }),
    },
    headerText: {
        ...Typography.default('regular'),
        color: theme.colors.headerText,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        textTransform: 'uppercase',
        fontWeight: Platform.select({ ios: 'normal', default: '500' }),
    },
    contentContainer: {
        backgroundColor: theme.colors.cardBackground,
        marginHorizontal: Platform.select({ ios: 16, default: 12 }),
        borderRadius: Platform.select({ ios: 10, default: 16 }),
        overflow: 'hidden',
        ...Platform.select({
            ios: {
                shadowColor: theme.colors.shadowColor,
                shadowOffset: { width: 0, height: 0.33 },
                shadowOpacity: 0.05,
                shadowRadius: 0,
            },
            default: {
                elevation: 1,
            },
        }),
    },
    footer: {
        paddingTop: Platform.select({ ios: 6, default: 8 }),
        paddingBottom: Platform.select({ ios: 8, default: 16 }),
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
    },
    footerText: {
        ...Typography.default('regular'),
        color: theme.colors.headerText,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0 }),
    },
}));

export const ItemGroup = React.memo<ItemGroupProps>((props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    
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
        <View style={[styles.wrapper, style]}>
            <View style={styles.container}>
                {/* Header */}
                {title ? (
                    <View style={[styles.header, headerStyle]}>
                        {typeof title === 'string' ? (
                            <Text style={[styles.headerText, titleStyle]}>
                                {title}
                            </Text>
                        ) : (
                            title
                        )}
                    </View>
                ) : (
                    // Add top margin when there's no title
                    <View style={styles.headerNoTitle} />
                )}

                {/* Content Container */}
                <View style={[styles.contentContainer, containerStyle]}>
                    {React.Children.map(children, (child, index) => {
                        if (React.isValidElement<ItemChildProps>(child)) {
                            // Don't add props to React.Fragment
                            if (child.type === React.Fragment) {
                                return child;
                            }
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
                    <View style={[styles.footer, footerStyle]}>
                        <Text style={[styles.footerText, footerTextStyle]}>
                            {footer}
                        </Text>
                    </View>
                )}
            </View>
        </View>
    );
});