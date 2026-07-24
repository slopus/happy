import * as React from 'react';
import { Animated, View, Text, Platform, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { layout } from '../layout';
import { isRunningOnMac } from '@/utils/platform';
import { useHeaderHeight, useIsTablet } from '@/utils/responsive';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MobileGlassSurface } from '../MobileGlass';
import {
    MOBILE_GLASS_CONTROL_RADIUS,
    MOBILE_GLASS_CONTROL_SIZE,
    MOBILE_GLASS_HEADER_HEIGHT,
} from './headerMetrics';

interface HeaderProps {
    title?: React.ReactNode;
    subtitle?: string;
    headerLeft?: (() => React.ReactNode) | null;
    headerLeftGlass?: boolean;
    headerRight?: (() => React.ReactNode) | null;
    headerRightGlass?: boolean;
    headerStyle?: any;
    headerTitleStyle?: any;
    headerSubtitleStyle?: any;
    headerTintColor?: string;
    headerBackgroundColor?: string;
    headerShadowVisible?: boolean;
    headerTransparent?: boolean;
    headerBackdropVisible?: boolean;
    safeAreaEnabled?: boolean;
}

export const Header = React.memo((props: HeaderProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    const {
        title,
        subtitle,
        headerLeft,
        headerLeftGlass = false,
        headerRight,
        headerRightGlass = true,
        headerStyle,
        headerTitleStyle,
        headerSubtitleStyle,
        headerTintColor, // Accept but ignore - using theme instead
        headerBackgroundColor, // Accept but ignore - using theme instead
        headerShadowVisible = true,
        headerTransparent = false,
        headerBackdropVisible = false,
        safeAreaEnabled = true,
    } = props;

    const insets = useSafeAreaInsets();
    const paddingTop = safeAreaEnabled ? insets.top : 0;
    const headerHeight = useHeaderHeight();
    const isTablet = useIsTablet();
    const isDesktop = Platform.OS === 'web' || isRunningOnMac();
    const floatingControlsEnabled = !isDesktop && !isTablet;
    const headerLeftUsesGlass = headerLeftGlass && !isDesktop;
    const headerRightUsesGlass = headerRightGlass && !isDesktop;
    const contentHeight = floatingControlsEnabled ? Math.max(headerHeight, MOBILE_GLASS_HEADER_HEIGHT) : headerHeight;
    const backdropOpacity = React.useRef(new Animated.Value(headerBackdropVisible ? 1 : 0)).current;
    const [backdropMounted, setBackdropMounted] = React.useState(headerBackdropVisible);

    React.useEffect(() => {
        if (headerBackdropVisible) {
            setBackdropMounted(true);
        }
        Animated.timing(backdropOpacity, {
            toValue: headerBackdropVisible ? 1 : 0,
            duration: 160,
            useNativeDriver: true,
        }).start(({ finished }) => {
            if (finished && !headerBackdropVisible) {
                setBackdropMounted(false);
            }
        });
    }, [backdropOpacity, headerBackdropVisible]);

    const containerStyle = [
        styles.container,
        headerTransparent && styles.containerTransparent,
        !headerTransparent && styles.containerNormal,
        {
            paddingTop,
        },
        headerShadowVisible && styles.shadow,
        headerStyle,
        !isDesktop && styles.containerTransparent,
    ];

    const subtitleStyle = [
        styles.subtitle,
        isDesktop && styles.desktopSubtitle,
        headerSubtitleStyle,
    ];

    return (
        <View style={containerStyle}>
            {floatingControlsEnabled && backdropMounted && (
                <Animated.View
                    pointerEvents="none"
                    style={[styles.headerBlur, { opacity: backdropOpacity }]}
                >
                    <BlurView
                        blurMethod={Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : undefined}
                        blurReductionFactor={2}
                        intensity={34}
                        tint={theme.dark ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'}
                        style={styles.headerBlurFill}
                    />
                </Animated.View>
            )}
            <View style={styles.contentWrapper}>
                <View style={[styles.content, isDesktop && styles.desktopContent, { height: contentHeight }]}>
                    <View style={styles.leftContainer}>
                        {headerLeft && headerLeftUsesGlass && (
                            <MobileGlassSurface
                                enabled={floatingControlsEnabled}
                                interactive
                                intensity={76}
                                style={styles.leftControlGlass}
                            >
                                <View style={styles.leftControlContent}>
                                    {headerLeft()}
                                </View>
                            </MobileGlassSurface>
                        )}
                        {headerLeft && !headerLeftUsesGlass && headerLeft()}
                    </View>

                    <View style={[styles.centerContainer, isDesktop && styles.desktopCenterContainer]}>
                        {title}
                        {subtitle && <Text style={subtitleStyle} numberOfLines={1}>{subtitle}</Text>}
                    </View>

                    <View style={styles.rightContainer}>
                        {headerRight && headerRightUsesGlass && (
                            <MobileGlassSurface
                                enabled={floatingControlsEnabled}
                                interactive
                                intensity={76}
                                style={styles.rightControlGlass}
                            >
                                <View style={styles.rightControlContent}>
                                    {headerRight()}
                                </View>
                            </MobileGlassSurface>
                        )}
                        {headerRight && !headerRightUsesGlass && headerRight()}
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
    const styles = stylesheet;
    if (Platform.OS === 'web' || isRunningOnMac()) {
        return (
            <Pressable onPress={onPress} hitSlop={15}>
                <Ionicons name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'} size={24} color={tintColor} />
            </Pressable>
        );
    }

    return (
        <Pressable
            onPress={onPress}
            hitSlop={10}
            style={({ pressed }) => [styles.backButton, pressed && styles.controlPressed]}
        >
            <MobileGlassSurface
                interactive
                intensity={76}
                style={styles.backButtonGlass}
            >
                <Ionicons
                    name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                    size={24}
                    color={tintColor}
                />
            </MobileGlassSurface>
        </Pressable>
    );
};

// Component wrapper for navigation header
const NavigationHeaderComponent: React.FC<NativeStackHeaderProps> = React.memo((props) => {
    const { options, route, back, navigation } = props;
    const extendedOptions = options as ExtendedNavigationOptions;
    const isTablet = useIsTablet();
    const isDesktop = Platform.OS === 'web' || isRunningOnMac();

    // Hide back button on tablet — navigation is handled via sidebar and persistent header
    const shouldHideBackButton = isTablet;

    // Extract title - handle both string and function types
    let title: React.ReactNode | null = null;
    if (options.headerTitle) {
        if (typeof options.headerTitle === 'string') {
            title = (
                <Text style={[
                    {
                        fontSize: isDesktop ? 17 : 16,
                        fontWeight: '600',
                        textAlign: isDesktop && Platform.OS === 'ios' ? 'center' : 'left',
                        color: options.headerTintColor || '#000',
                    },
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
    headerBlur: {
        ...StyleSheet.absoluteFillObject,
    },
    headerBlurFill: {
        ...StyleSheet.absoluteFillObject,
    },
    contentWrapper: {
        width: '100%',
        alignItems: 'center',
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: Platform.OS === 'web' ? 0 : 8,
        paddingHorizontal: Platform.OS === 'web' ? 16 : 12,
        width: '100%',
        maxWidth: layout.headerMaxWidth,
    },
    desktopContent: {
        gap: 0,
        paddingHorizontal: Platform.select({ ios: 8, default: 16 }),
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
        flexDirection: Platform.OS === 'web' ? 'row' : 'column',
        alignItems: Platform.OS === 'web' ? 'center' : 'flex-start',
        justifyContent: Platform.OS === 'web' ? 'flex-start' : 'center',
        paddingHorizontal: Platform.OS === 'web' ? 12 : 0,
        minWidth: Platform.OS === 'web' ? undefined : 0,
    },
    desktopCenterContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: Platform.OS === 'ios' ? 'center' : 'flex-start',
        paddingHorizontal: 12,
        minWidth: undefined,
    },
    rightContainer: {
        flexGrow: 0,
        flexShrink: 0,
        alignItems: 'flex-end',
    },
    rightControlGlass: {
        minWidth: Platform.select({ web: 0, default: MOBILE_GLASS_CONTROL_SIZE }),
        minHeight: Platform.select({ web: 0, default: MOBILE_GLASS_CONTROL_SIZE }),
        borderRadius: MOBILE_GLASS_CONTROL_RADIUS,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        backgroundColor: Platform.select({
            web: 'transparent',
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: 'transparent',
        }),
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.glass.border,
        shadowColor: theme.colors.glass.shadow,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: Platform.select({ web: 0, default: 1 }),
        shadowRadius: 18,
        elevation: Platform.select({ android: 8, default: 0 }),
    },
    leftControlGlass: {
        width: Platform.select({ web: 36, default: MOBILE_GLASS_CONTROL_SIZE }),
        height: Platform.select({ web: 36, default: MOBILE_GLASS_CONTROL_SIZE }),
        borderRadius: MOBILE_GLASS_CONTROL_RADIUS,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        backgroundColor: Platform.select({
            web: 'transparent',
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: 'transparent',
        }),
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.glass.border,
        shadowColor: theme.colors.glass.shadow,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: Platform.select({ web: 0, default: 1 }),
        shadowRadius: 18,
        elevation: Platform.select({ android: 8, default: 0 }),
    },
    leftControlContent: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    rightControlContent: {
        minHeight: Platform.select({ web: 0, default: MOBILE_GLASS_CONTROL_SIZE }),
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: Platform.select({ web: 0, default: 6 }),
    },
    title: {
        fontSize: Platform.OS === 'web' ? 17 : 16,
        fontWeight: '600',
        textAlign: 'center',
        color: theme.colors.header.tint,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        fontSize: Platform.OS === 'web' ? 13 : 12,
        fontWeight: '400',
        textAlign: 'left',
        marginTop: Platform.OS === 'web' ? 2 : 1,
        color: theme.colors.header.tint,
        ...Typography.default('regular'),
    },
    desktopSubtitle: {
        fontSize: 13,
        textAlign: Platform.OS === 'ios' ? 'center' : 'left',
        marginTop: 2,
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
        width: Platform.select({ web: 36, default: MOBILE_GLASS_CONTROL_SIZE }),
        height: Platform.select({ web: 36, default: MOBILE_GLASS_CONTROL_SIZE }),
        borderRadius: MOBILE_GLASS_CONTROL_RADIUS,
    },
    backButtonGlass: {
        width: '100%',
        height: '100%',
        borderRadius: MOBILE_GLASS_CONTROL_RADIUS,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        backgroundColor: Platform.select({
            web: 'transparent',
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: 'transparent',
        }),
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.glass.border,
        shadowColor: theme.colors.glass.shadow,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: Platform.select({ web: 0, default: 1 }),
        shadowRadius: 18,
        elevation: Platform.select({ android: 8, default: 0 }),
    },
    controlPressed: {
        opacity: 0.68,
        transform: [{ scale: 0.97 }],
    },
}));
