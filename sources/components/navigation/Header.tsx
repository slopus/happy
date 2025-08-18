import * as React from 'react';
import { View, Text, StyleSheet, Platform, StatusBar, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { layout } from '../layout';
import { useIsLandscape, getDeviceType, getHeaderHeight, useHeaderHeight } from '@/utils/responsive';
import { Typography } from '@/constants/Typography';

interface HeaderProps {
    title?: React.ReactNode;
    subtitle?: string;
    headerLeft?: () => React.ReactNode;
    headerRight?: () => React.ReactNode;
    headerStyle?: any;
    headerTitleStyle?: any;
    headerSubtitleStyle?: any;
    headerTintColor?: string;
    headerBackgroundColor?: string;
    headerShadowVisible?: boolean;
    headerTransparent?: boolean;
    safeAreaEnabled?: boolean;
}

export const Header = React.memo((props: HeaderProps) => {
    const {
        title,
        subtitle,
        headerLeft,
        headerRight,
        headerStyle,
        headerTitleStyle,
        headerSubtitleStyle,
        headerTintColor = '#000',
        headerBackgroundColor = '#fff',
        headerShadowVisible = true,
        headerTransparent = false,
        safeAreaEnabled = true,
    } = props;

    const insets = useSafeAreaInsets();
    const paddingTop = safeAreaEnabled ? insets.top : 0;
    const headerHeight = useHeaderHeight();

    const containerStyle = [
        styles.container,
        {
            paddingTop,
            backgroundColor: headerTransparent ? 'transparent' : headerBackgroundColor,
        },
        headerShadowVisible && styles.shadow,
        headerStyle,
    ];

    const titleStyle = [
        styles.title,
        { color: headerTintColor },
        headerTitleStyle,
    ];

    const subtitleStyle = [
        styles.subtitle,
        { color: headerTintColor },
        headerSubtitleStyle,
    ];

    return (
        <View style={containerStyle}>
            <StatusBar
                barStyle={headerTintColor === '#fff' || headerTintColor === 'white' ? 'light-content' : 'dark-content'}
                backgroundColor={headerTransparent ? 'transparent' : headerBackgroundColor}
            />
            <View style={styles.contentWrapper}>
                <View style={[styles.content, { height: headerHeight }]}>
                    <View style={styles.leftContainer}>
                        {headerLeft && headerLeft()}
                    </View>

                    <View style={styles.centerContainer}>
                        {title}
                        {subtitle && <Text style={subtitleStyle} numberOfLines={1}>{subtitle}</Text>}
                    </View>

                    <View style={styles.rightContainer}>
                        {headerRight && headerRight()}
                    </View>
                </View>
            </View>
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        position: 'relative',
        zIndex: 100,
    },
    contentWrapper: {
        width: '100%',
        alignItems: 'center',
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: Platform.OS === 'ios' ? 8 : 16,
        width: '100%',
        maxWidth: layout.headerMaxWidth, // Standard max width for content
    },
    leftContainer: {
        flexGrow: 0,
        flexShrink: 0,
        alignItems: 'flex-start',
    },
    centerContainer: {
        flexGrow: 1,
        flexBasis: 0,
        alignSelf: 'stretch',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
    },
    rightContainer: {
        flexGrow: 0,
        flexShrink: 0,
        alignItems: 'flex-end',
    },
    title: {
        fontSize: 17,
        fontWeight: '600',
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    subtitle: {
        fontSize: 13,
        fontWeight: '400',
        textAlign: 'center',
        marginTop: 2,
        ...Typography.default('regular'),
    },
    shadow: {
        ...Platform.select({
            ios: {
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: 0.15,
                shadowRadius: 3,
            },
            android: {
                elevation: 4,
            },
            web: {
                boxShadow: '0 1px 3px rgba(0, 0, 0, 0.15)',
            },
        }),
    },
});

// Extended navigation options to support subtitle
interface ExtendedNavigationOptions extends Partial<NativeStackHeaderProps['options']> {
    headerSubtitle?: string;
    headerSubtitleStyle?: any;
}

// Default back button component
const DefaultBackButton: React.FC<{ tintColor?: string; onPress: () => void }> = ({ tintColor = '#000', onPress }) => {
    return (
        <Pressable onPress={onPress} hitSlop={15}>
            <Ionicons
                name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                size={24}
                color={tintColor}
            />
        </Pressable>
    );
};

// Component wrapper for navigation header
const NavigationHeaderComponent: React.FC<NativeStackHeaderProps> = React.memo((props) => {
    const { options, route, back, navigation } = props;
    const extendedOptions = options as ExtendedNavigationOptions;

    // Extract title - handle both string and function types
    let title: React.ReactNode | null = null;
    if (options.headerTitle) {
        if (typeof options.headerTitle === 'string') {
            title = (
                <Text style={[
                    { fontSize: 17, fontWeight: '600', textAlign: 'center', color: options.headerTintColor || '#000' },
                    Typography.default('semiBold'),
                    options.headerTitleStyle
                ]}>
                    {options.headerTitle}
                </Text>
            );
        } else if (typeof options.headerTitle === 'function') {
            // Handle function type headerTitle
            title = options.headerTitle({ children: route.name, tintColor: options.headerTintColor });
        }
    } else if (typeof options.title === 'string') {
        title = (
            <Text style={[
                { fontSize: 17, fontWeight: '600', textAlign: 'center', color: options.headerTintColor || '#000' },
                Typography.default('semiBold'),
                options.headerTitleStyle
            ]}>
                {options.title}
            </Text>
        );
    }

    // Determine header left content
    let headerLeftContent: (() => React.ReactNode) | undefined;

    if (options.headerLeft) {
        // Use custom headerLeft if provided
        headerLeftContent = () => options.headerLeft!({ canGoBack: !!back, tintColor: options.headerTintColor });
    } else if (back && options.headerBackVisible !== false) {
        // Show default back button if can go back and not explicitly hidden
        headerLeftContent = () => (
            <DefaultBackButton
                tintColor={options.headerTintColor}
                onPress={() => navigation.goBack()}
            />
        );
    }

    return (
        <Header
            title={title}
            subtitle={extendedOptions.headerSubtitle}
            headerLeft={headerLeftContent}
            headerRight={options.headerRight ?
                () => options.headerRight!({ canGoBack: !!back, tintColor: options.headerTintColor }) :
                undefined
            }
            headerStyle={options.headerStyle}
            headerTitleStyle={options.headerTitleStyle}
            headerSubtitleStyle={extendedOptions.headerSubtitleStyle}
            headerTintColor={options.headerTintColor}
            headerBackgroundColor={
                options.headerStyle && typeof options.headerStyle === 'object' && 'backgroundColor' in options.headerStyle
                    ? options.headerStyle.backgroundColor as string
                    : undefined
            }
            headerShadowVisible={options.headerShadowVisible}
            headerTransparent={options.headerTransparent}
        />
    );
});

// Export a render function for React Navigation
export const createHeader = (props: NativeStackHeaderProps) => {
    if (props.options.headerShown === false) {
        return null;
    }
    return <NavigationHeaderComponent {...props} />;
};