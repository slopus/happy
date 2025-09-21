import * as React from 'react';
import { View, Text, Platform, StatusBar, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { layout } from '../layout';
import { useHeaderHeight, useIsTablet } from '@/utils/responsive';
import { Typography } from '@/constants/Typography';
import { StyleSheet } from 'react-native-unistyles';

interface HeaderProps {
    title?: React.ReactNode;
    subtitle?: string;
    headerLeft?: (() => React.ReactNode) | null;
    headerRight?: (() => React.ReactNode) | null;
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
    const styles = stylesheet;

    const {
        title,
        subtitle,
        headerLeft,
        headerRight,
        headerStyle,
        headerTitleStyle,
        headerSubtitleStyle,
        headerTintColor, // Accept but ignore - using theme instead
        headerBackgroundColor, // Accept but ignore - using theme instead
        headerShadowVisible = true,
        headerTransparent = false,
        safeAreaEnabled = true,
    } = props;

    const insets = useSafeAreaInsets();
    const paddingTop = safeAreaEnabled ? insets.top : 0;
    const headerHeight = useHeaderHeight();

    const containerStyle = [
        styles.container,
        headerTransparent && styles.containerTransparent,
        !headerTransparent && styles.containerNormal,
        {
            paddingTop,
        },
        headerShadowVisible && styles.shadow,
        headerStyle,
    ];

    const subtitleStyle = [
        styles.subtitle,
        headerSubtitleStyle,
    ];

    return (
        <View style={[containerStyle]}>
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
    const isTablet = useIsTablet();

    // Check if we should hide back button on tablet
    const shouldHideBackButton = React.useMemo(() => {
        if (!isTablet) return false;

        // Get navigation state to check stack depth
        const state = navigation.getState();
        const currentIndex = state?.index ?? 0;

        // Hide back button if we're at the first or second screen in the stack
        // In tablet mode, index 0 is the empty screen, index 1 is the first real screen
        return currentIndex <= 1;
    }, [isTablet, navigation]);

    // Extract title - handle both string and function types
    let title: React.ReactNode | null = null;
    if (options.headerTitle) {
        if (typeof options.headerTitle === 'string') {
            title = (
                <Text style={[
                    { fontSize: 17, fontWeight: '600', textAlign: Platform.OS === 'ios' ? 'center' : 'left', color: options.headerTintColor || '#000' },
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
                { fontSize: 17, fontWeight: '600', textAlign: Platform.OS === 'ios' ? 'center' : 'left', color: options.headerTintColor || '#000' },
                Typography.default('semiBold'),
                options.headerTitleStyle
            ]}>
                {options.title}
            </Text>
        );
    }

    // Determine header left content
    let headerLeftContent: (() => React.ReactNode) | undefined | null = null;
    if (options.headerLeft) {
        // Use custom headerLeft if provided
        headerLeftContent = () => options.headerLeft!({ canGoBack: !!back, tintColor: options.headerTintColor });
    } else if (back && options.headerBackVisible !== false && !shouldHideBackButton) {
        // Show default back button if can go back and not explicitly hidden
        // Also hide on tablet when at first or second screen
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

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        position: 'relative',
        zIndex: 100,
    },
    containerTransparent: {
        backgroundColor: 'transparent',
    },
    containerNormal: {
        backgroundColor: theme.colors.header.background,
    },
    contentWrapper: {
        width: '100%',
        alignItems: 'center',
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: Platform.select({ ios: 8, default: 16 }),
        width: '100%',
        maxWidth: layout.headerMaxWidth,
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
        justifyContent: Platform.OS === 'ios' ? 'center' : 'flex-start',
        paddingHorizontal: 12,
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
        color: theme.colors.header.tint,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        fontSize: 13,
        fontWeight: '400',
        textAlign: Platform.OS === 'ios' ? 'center' : 'left',
        marginTop: 2,
        color: theme.colors.header.tint,
        ...Typography.default('regular'),
    },
    shadow: {
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 3,
        elevation: 4,
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.15)',
    },
    backButton: {
        color: theme.colors.header.tint,
    },
}));