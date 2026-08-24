import * as React from 'react';
import { Animated, View, Text, Platform, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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
    resolveTitlePillInset,
} from './navigation/headerMetrics';
import {
    MobileHeaderScrim,
    MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY,
    MOBILE_STRONG_HEADER_SCRIM_UNDERLAP_OPACITY,
} from './navigation/MobileHeaderScrim';

interface ChatHeaderViewProps {
    title: string;
    /** Project folder name (last path segment) */
    folderName?: string;
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

// The title is a control like the two beside it: same capsule, same height,
// sized to its own text. The scrim stays underneath them all, feathering past
// the controls into content.
export const ChatHeaderView: React.FC<ChatHeaderViewProps> = ({
    title,
    folderName,
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
    const glassEnabled = !isTablet && Platform.OS === 'ios' && !isRunningOnMac();
    const contentHeight = glassEnabled ? Math.max(headerHeight, MOBILE_GLASS_HEADER_HEIGHT) : headerHeight;
    const showFolderSubtitle = !!folderName && folderName !== title;
    const folderNameColor = glassEnabled
        ? theme.dark ? 'rgba(255, 255, 255, 0.78)' : 'rgba(24, 23, 28, 0.72)'
        : theme.colors.textSecondary;
    // The right control's width follows whatever it is carrying, so it is
    // measured rather than assumed; the left one is a fixed-size button.
    const [rightSlotWidth, setRightSlotWidth] = React.useState(0);
    const titlePillInset = resolveTitlePillInset({
        leftControlWidth: showBackButton ? MOBILE_GLASS_CONTROL_SIZE : 0,
        rightControlWidth: rightSlot ? Math.max(rightSlotWidth, MOBILE_GLASS_CONTROL_SIZE) : 0,
    });
    // Drives the scrim's dim layer only. The backdrop container itself stays
    // fully opaque so the native blur keeps sampling live content.
    const backdropStrength = React.useRef(new Animated.Value(
        backdropVisible ? MOBILE_STRONG_HEADER_SCRIM_UNDERLAP_OPACITY : MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY,
    )).current;
    const [backdropMounted, setBackdropMounted] = React.useState(glassEnabled);

    React.useEffect(() => {
        if (!glassEnabled) {
            setBackdropMounted(false);
            return;
        }

        setBackdropMounted(true);
        Animated.timing(backdropStrength, {
            toValue: backdropVisible ? MOBILE_STRONG_HEADER_SCRIM_UNDERLAP_OPACITY : MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY,
            duration: 200,
            useNativeDriver: true,
        }).start();
    }, [backdropStrength, backdropVisible, glassEnabled]);

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
                        </Pressable>
                        {rightSlot ? <View style={styles.webRightSlot}>{rightSlot}</View> : null}
                    </View>
                </View>
            </View>
        );
    }

    const titleBody = (
        <>
            <Text
                numberOfLines={1}
                ellipsizeMode="tail"
                style={[
                    styles.title,
                    glassEnabled && styles.mobileTitleText,
                    { color: theme.colors.header.tint, ...Typography.default('semiBold') },
                ]}
            >
                {title || folderName}
            </Text>
            {(showFolderSubtitle || hasExtra) && (
                <View style={[styles.subtitleRow, glassEnabled && styles.mobileSubtitleRow]}>
                    {showFolderSubtitle && (
                        <Text
                            numberOfLines={1}
                            ellipsizeMode="tail"
                            style={[
                                styles.folderName,
                                glassEnabled && styles.mobileFolderName,
                                { color: folderNameColor, ...Typography.default() },
                            ]}
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
                            style={[
                                styles.extraPath,
                                glassEnabled && styles.mobileExtraPath,
                                { color: theme.colors.textSecondary, ...Typography.mono() },
                            ]}
                        >
                            {extraPathSegment}
                        </Text>
                    )}
                </View>
            )}
        </>
    );

    // Built the way the back button is: a wrapper that owns the size, and the
    // glass inside it owning the material. maxWidth is what makes the capsule
    // hug its text — it grows with the title and stops at the inset.
    const nativeTitle = glassEnabled ? (
        <BubblePressable
            style={styles.mobileTitlePill}
            onPress={onTitlePress}
            disabled={!onTitlePress}
            scaleFeedback={false}
        >
            <MobileGlassSurface
                nativeEffect
                material="static"
                intensity={76}
                style={styles.mobileTitlePillGlass}
            >
                {titleBody}
            </MobileGlassSurface>
        </BubblePressable>
    ) : (
        <BubblePressable
            style={styles.titleContainer}
            onPress={onTitlePress}
            disabled={!onTitlePress}
            bubbleScale={1.012}
        >
            {titleBody}
        </BubblePressable>
    );

    return (
        <View
            style={[
                styles.container,
                {
                    paddingTop: insets.top,
                    backgroundColor: glassEnabled
                        ? 'transparent'
                        : Platform.OS === 'android' && backdropVisible
                            ? theme.colors.surfaceHigh
                            : theme.colors.header.background,
                },
            ]}
        >
            {glassEnabled && backdropMounted && (
                <View pointerEvents="none" style={styles.headerBackdrop}>
                    <MobileHeaderScrim variant="strong" overlayOpacity={backdropStrength} />
                </View>
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
                                material="static"
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
                    {glassEnabled ? (
                        <>
                            <View pointerEvents="none" style={styles.mobileTitleSpacer} />
                            <View
                                pointerEvents="box-none"
                                style={[
                                    styles.mobileTitleOverlay,
                                    { left: titlePillInset, right: titlePillInset },
                                ]}
                            >
                                {nativeTitle}
                            </View>
                        </>
                    ) : (
                        <View style={styles.titlePillContainer}>
                            {nativeTitle}
                        </View>
                    )}
                    {rightSlot ? (
                        <MobileGlassSurface
                            enabled={glassEnabled}
                            nativeEffect
                            material="static"
                            intensity={76}
                            style={styles.rightControlGlass}
                            onLayout={(event) => setRightSlotWidth(event.nativeEvent.layout.width)}
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
    headerBackdrop: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: -8,
        left: 0,
    },
    contentWrapper: {
        width: '100%',
        alignItems: 'center',
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
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
    titlePillContainer: {
        flex: 1,
        alignSelf: 'stretch',
        minWidth: 0,
    },
    mobileTitleSpacer: {
        flex: 1,
        minWidth: 0,
    },
    // Left and right are set at render time from the measured controls.
    mobileTitleOverlay: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
    mobileTitlePill: {
        maxWidth: '100%',
        height: MOBILE_GLASS_CONTROL_SIZE,
        borderRadius: MOBILE_GLASS_CONTROL_RADIUS,
    },
    // Deliberately identical to backButtonGlass but for the horizontal padding:
    // same material, same rim, same shadow, same height. The capsule is
    // only wider because its content is.
    mobileTitlePillGlass: {
        width: '100%',
        height: '100%',
        borderRadius: MOBILE_GLASS_CONTROL_RADIUS,
        paddingHorizontal: 14,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        backgroundColor: Platform.select({
            web: 'transparent',
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: 'transparent',
        }),
        borderWidth: Platform.select({ ios: 1, default: 0 }),
        borderColor: theme.dark ? 'rgba(255, 255, 255, 0.18)' : '#FFFFFF',
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: Platform.select({ ios: theme.dark ? 0.24 : 0.06, default: 0 }),
        shadowRadius: 20,
        elevation: 0,
    },
    // No text shadow inside the capsule: the glass is the contrast now, and the
    // shadow only existed to hold text legible against bare content.
    mobileTitleText: {
        width: 'auto',
        maxWidth: '100%',
        textAlign: 'center',
    },
    mobileSubtitleRow: {
        width: 'auto',
        maxWidth: '100%',
        justifyContent: 'center',
    },
    // Two lines have to sit inside a 44pt capsule, so they are drawn a little
    // closer than they were when they floated free.
    mobileFolderName: {
        lineHeight: 14,
    },
    // The capsule is sized by its content, and a row whose width comes from its
    // content has no free space to hand a `flex: 1` child — it would measure at
    // zero and the path would vanish. It shrinks instead.
    mobileExtraPath: {
        flex: 0,
        lineHeight: 14,
    },
    webTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        width: '100%',
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
        minWidth: Platform.select({ web: 0, android: 48, default: MOBILE_GLASS_CONTROL_SIZE }),
        minHeight: Platform.select({ web: 0, android: 48, default: MOBILE_GLASS_CONTROL_SIZE }),
        borderRadius: MOBILE_GLASS_CONTROL_RADIUS,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        backgroundColor: Platform.select({
            web: 'transparent',
            ios: 'transparent',
            android: 'transparent',
            default: 'transparent',
        }),
        borderWidth: Platform.select({ ios: 1, default: 0 }),
        borderColor: theme.dark ? 'rgba(255, 255, 255, 0.18)' : '#FFFFFF',
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: Platform.select({ ios: theme.dark ? 0.24 : 0.06, default: 0 }),
        shadowRadius: 20,
        elevation: 0,
        zIndex: 1,
    },
    rightSlot: {
        minHeight: Platform.select({ web: 0, android: 48, default: MOBILE_GLASS_CONTROL_SIZE }),
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingHorizontal: Platform.select({ web: 0, default: 8 }),
        flexShrink: 0,
    },
    backButton: {
        width: Platform.select({ web: 36, android: 48, default: MOBILE_GLASS_CONTROL_SIZE }),
        height: Platform.select({ web: 36, android: 48, default: MOBILE_GLASS_CONTROL_SIZE }),
        borderRadius: MOBILE_GLASS_CONTROL_RADIUS,
        zIndex: 1,
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
            android: 'transparent',
            default: 'transparent',
        }),
        borderWidth: Platform.select({ ios: 1, default: 0 }),
        borderColor: theme.dark ? 'rgba(255, 255, 255, 0.18)' : '#FFFFFF',
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: Platform.select({ ios: theme.dark ? 0.24 : 0.06, default: 0 }),
        shadowRadius: 20,
        elevation: 0,
    },
    controlPressed: {
        opacity: 0.68,
        transform: [{ scale: 0.97 }],
    },
}));
