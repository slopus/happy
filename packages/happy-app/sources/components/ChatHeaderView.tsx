import * as React from 'react';
import { Animated, View, Text, Platform, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { isRunningOnMac } from '@/utils/platform';
import { useHeaderHeight, useIsTablet } from '@/utils/responsive';
import { layout } from '@/components/layout';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MobileGlassSurface } from './MobileGlass';
import { BubblePressable } from './BubblePressable';
import {
    MOBILE_GLASS_CONTROL_RADIUS,
    MOBILE_GLASS_CONTROL_SIZE,
    MOBILE_GLASS_HEADER_HEIGHT,
} from './navigation/headerMetrics';

interface ChatHeaderViewProps {
    title: string;
    /** Project folder name (last path segment) */
    folderName?: string;
    /** Optional client/provider/model identity shown below the session title. */
    identityLine?: string;
    /** Extra path segment appended to the title with a separator (used for the file-view overlay). */
    extraPathSegment?: string;
    /** Optional content rendered at the right edge of the header (used by file-view / diff overlays). */
    rightSlot?: React.ReactNode;
    onTitlePress?: () => void;
    onBackPress?: () => void;
    backgroundColor?: string;
    tintColor?: string;
    isConnected?: boolean;
    backdropVisible?: boolean;
}

export const ChatHeaderView: React.FC<ChatHeaderViewProps> = ({
    title,
    folderName,
    identityLine,
    extraPathSegment,
    rightSlot,
    onTitlePress,
    onBackPress,
    isConnected = true,
    backdropVisible = false,
}) => {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const isTablet = useIsTablet();
    const showBackButton = !isTablet && !!onBackPress;
    const hasExtra = !!extraPathSegment;
    const glassEnabled = !isTablet && Platform.OS !== 'web' && !isRunningOnMac();
    const contentHeight = glassEnabled ? Math.max(headerHeight, MOBILE_GLASS_HEADER_HEIGHT) : headerHeight;
    const showFolderSubtitle = !!folderName && folderName !== title;
    const backdropOpacity = React.useRef(new Animated.Value(backdropVisible ? 1 : 0)).current;
    const [backdropMounted, setBackdropMounted] = React.useState(backdropVisible);

    React.useEffect(() => {
        if (backdropVisible) {
            setBackdropMounted(true);
        }
        Animated.timing(backdropOpacity, {
            toValue: backdropVisible ? 1 : 0,
            duration: 160,
            useNativeDriver: true,
        }).start(({ finished }) => {
            if (finished && !backdropVisible) {
                setBackdropMounted(false);
            }
        });
    }, [backdropOpacity, backdropVisible]);

    if (Platform.OS === 'web') {
        return (
            <View style={[styles.container, { paddingTop: insets.top, backgroundColor: theme.colors.header.background }]}>
                <View style={styles.contentWrapper}>
                    <View style={[styles.webContent, { height: headerHeight }]}>
                        {showBackButton && (
                            <Pressable onPress={onBackPress} hitSlop={15} style={styles.webBackButton}>
                                <Ionicons
                                    name="arrow-back"
                                    size={24}
                                    color={theme.colors.header.tint}
                                />
                            </Pressable>
                        )}
                        <Pressable
                            style={styles.titleContainer}
                            onPress={onTitlePress}
                            disabled={!onTitlePress}
                        >
                            {folderName ? (
                                <View style={styles.webTitleRow}>
                                    <Text
                                        numberOfLines={1}
                                        style={[styles.webFolderName, { color: theme.colors.textSecondary, ...Typography.default() }]}
                                    >
                                        {folderName}
                                    </Text>
                                    {title && title !== folderName && (
                                        <>
                                            <Text style={[styles.webSeparator, { color: theme.colors.textSecondary, ...Typography.default() }]}>/</Text>
                                            <Text
                                                numberOfLines={1}
                                                ellipsizeMode="tail"
                                                style={[
                                                    styles.webTitle,
                                                    hasExtra && styles.webTitleWithExtra,
                                                    { color: theme.colors.header.tint, ...Typography.default() },
                                                ]}
                                            >
                                                {title}
                                            </Text>
                                        </>
                                    )}
                                    {hasExtra && (
                                        <>
                                            <Text style={[styles.webSeparator, { color: theme.colors.textSecondary, ...Typography.default() }]}>/</Text>
                                            <Text
                                                numberOfLines={1}
                                                ellipsizeMode="middle"
                                                style={[styles.webExtraPath, { color: theme.colors.header.tint, ...Typography.mono() }]}
                                            >
                                                {extraPathSegment}
                                            </Text>
                                        </>
                                    )}
                                </View>
                            ) : (
                                <Text
                                    numberOfLines={1}
                                    ellipsizeMode="tail"
                                    style={[styles.webTitle, { color: theme.colors.header.tint, ...Typography.default() }]}
                                >
                                    {title}
                                </Text>
                            )}
                            {identityLine ? (
                                <Text
                                    numberOfLines={1}
                                    ellipsizeMode="tail"
                                    style={[styles.identityLine, { color: theme.colors.textSecondary, ...Typography.default() }]}
                                >
                                    {identityLine}
                                </Text>
                            ) : null}
                        </Pressable>
                        {rightSlot ? <View style={styles.webRightSlot}>{rightSlot}</View> : null}
                    </View>
                </View>
            </View>
        );
    }

    return (
        <View
            style={[
                styles.container,
                {
                    paddingTop: insets.top,
                    backgroundColor: glassEnabled ? 'transparent' : theme.colors.header.background,
                },
            ]}
        >
            {glassEnabled && backdropMounted && (
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
                <View style={[styles.content, { height: contentHeight }]}>
                    {showBackButton && (
                        <Pressable
                            onPress={onBackPress}
                            hitSlop={10}
                            style={({ pressed }) => [styles.backButton, pressed && styles.controlPressed]}
                        >
                            <MobileGlassSurface
                                enabled={glassEnabled}
                                interactive
                                intensity={76}
                                style={styles.backButtonGlass}
                            >
                                <Ionicons
                                    name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                                    size={24}
                                    color={theme.colors.header.tint}
                                />
                            </MobileGlassSurface>
                        </Pressable>
                    )}
                    <BubblePressable
                        style={styles.titleContainer}
                        onPress={onTitlePress}
                        disabled={!onTitlePress}
                        bubbleScale={1.012}
                    >
                        <Text
                            numberOfLines={1}
                            ellipsizeMode="tail"
                            style={[styles.title, { color: theme.colors.header.tint, ...Typography.default('semiBold') }]}
                        >
                            {title || folderName}
                        </Text>
                        {(showFolderSubtitle || hasExtra) && (
                            <View style={styles.subtitleRow}>
                                {showFolderSubtitle && (
                                    <Text
                                        numberOfLines={1}
                                        ellipsizeMode="tail"
                                        style={[styles.folderName, { color: theme.colors.textSecondary, ...Typography.default() }]}
                                    >
                                        {folderName}
                                    </Text>
                                )}
                                {showFolderSubtitle && hasExtra && (
                                    <Text style={[styles.separator, { color: theme.colors.textSecondary, ...Typography.default() }]}>•</Text>
                                )}
                                {hasExtra && (
                                    <Text
                                        numberOfLines={1}
                                        ellipsizeMode="middle"
                                        style={[styles.extraPath, { color: theme.colors.textSecondary, ...Typography.mono() }]}
                                    >
                                        {extraPathSegment}
                                    </Text>
                                )}
                            </View>
                        )}
                        {identityLine ? (
                            <Text
                                numberOfLines={1}
                                ellipsizeMode="tail"
                                style={[styles.identityLine, { color: theme.colors.textSecondary, ...Typography.default() }]}
                            >
                                {identityLine}
                            </Text>
                        ) : null}
                    </BubblePressable>
                    {rightSlot ? (
                        <MobileGlassSurface
                            enabled={glassEnabled}
                            interactive
                            intensity={76}
                            style={styles.rightControlGlass}
                        >
                            <View style={styles.rightSlot}>
                                {rightSlot}
                            </View>
                        </MobileGlassSurface>
                    ) : null}
                </View>
            </View>
        </View>
    );
};

const styles = StyleSheet.create((theme) => ({
    container: {
        position: 'relative',
        zIndex: 100,
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
        gap: 8,
        paddingHorizontal: 12,
        width: '100%',
        maxWidth: layout.headerMaxWidth,
    },
    webContent: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        width: '100%',
        maxWidth: layout.headerMaxWidth,
    },
    titleContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'flex-start',
        minWidth: 0,
    },
    webTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        width: '100%',
    },
    identityLine: {
        fontSize: 11,
        lineHeight: 14,
        maxWidth: '100%',
    },
    webFolderName: {
        fontSize: 14,
        flexShrink: 0,
    },
    webSeparator: {
        fontSize: 14,
        flexShrink: 0,
    },
    webTitle: {
        fontSize: 14,
        fontWeight: '600',
        flexShrink: 1,
    },
    webTitleWithExtra: {
        flexShrink: 0.5,
    },
    webExtraPath: {
        flex: 1,
        minWidth: 0,
        fontSize: 13,
        flexShrink: 1,
    },
    webRightSlot: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginLeft: 12,
        flexShrink: 0,
    },
    webBackButton: {
        paddingHorizontal: 8,
        paddingVertical: 4,
    },
    subtitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        width: '100%',
    },
    folderName: {
        fontSize: 12,
        lineHeight: 16,
        flexShrink: 1,
    },
    separator: {
        fontSize: 12,
        lineHeight: 16,
        flexShrink: 0,
    },
    title: {
        fontSize: 16,
        lineHeight: 20,
        fontWeight: '600',
        width: '100%',
    },
    extraPath: {
        flex: 1,
        minWidth: 0,
        fontSize: 11,
        lineHeight: 16,
        flexShrink: 1,
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
    rightSlot: {
        minHeight: Platform.select({ web: 0, default: MOBILE_GLASS_CONTROL_SIZE }),
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingHorizontal: Platform.select({ web: 0, default: 8 }),
        flexShrink: 0,
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
