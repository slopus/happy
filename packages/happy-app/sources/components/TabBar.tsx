import * as React from 'react';
import { LayoutChangeEvent, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    type SharedValue,
    Easing,
    interpolateColor,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { useInboxHasContent } from '@/hooks/useInboxHasContent';
import { MobileGlassSurface } from './MobileGlass';
import { hapticsLight } from './haptics';

export type TabType = 'inbox' | 'sessions' | 'settings';

interface TabBarProps {
    activeTab: TabType;
    onTabPress: (tab: TabType) => void;
    inboxBadgeCount?: number;
}

type TabDefinition = {
    key: TabType;
    icon: number;
    iconName: React.ComponentProps<typeof Ionicons>['name'];
    activeIconName: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
};

const TAB_COUNT = 2;
const BAR_HEIGHT = 60;
const LENS_HEIGHT = 68;
const LENS_OVERLAP = 6;
const REST_INDICATOR_INSET = 5;
const HOLD_DURATION = 180;
export const MOBILE_TAB_BAR_CONTENT_INSET = 104;
function tabTransition(from: number, to: number) {
    'worklet';
    const distance = Math.abs(to - from);
    return {
        duration: Math.max(90, Math.round(130 * distance)),
        easing: Easing.out(Easing.cubic),
    };
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const styles = StyleSheet.create((theme) => ({
    webOuterContainer: {
        backgroundColor: theme.colors.surface,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
    },
    webInnerContainer: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'flex-start',
        maxWidth: layout.maxWidth,
        width: '100%',
        alignSelf: 'center',
    },
    webTab: {
        flex: 1,
        alignItems: 'center',
        paddingTop: 8,
        paddingBottom: 4,
    },
    webTabContent: {
        alignItems: 'center',
        position: 'relative',
    },
    webLabel: {
        fontSize: 10,
        marginTop: 3,
        ...Typography.default(),
    },
    webBadge: {
        position: 'absolute',
        top: -4,
        right: -8,
        backgroundColor: theme.colors.status.error,
        borderRadius: 8,
        minWidth: 16,
        height: 16,
        paddingHorizontal: 4,
        justifyContent: 'center',
        alignItems: 'center',
    },
    webIndicatorDot: {
        position: 'absolute',
        top: 0,
        right: -2,
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.text,
    },
    nativeSafeArea: {
        paddingHorizontal: 18,
        paddingTop: 8,
    },
    nativeShadow: {
        maxWidth: 320,
        width: '68%',
        alignSelf: 'center',
        borderRadius: BAR_HEIGHT / 2,
        shadowColor: theme.colors.glass.shadow,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 1,
        shadowRadius: 16,
        elevation: 7,
    },
    nativeShell: {
        height: BAR_HEIGHT,
        borderRadius: BAR_HEIGHT / 2,
        overflow: 'visible',
        position: 'relative',
    },
    nativeBaseSurface: {
        ...StyleSheet.absoluteFillObject,
        borderRadius: BAR_HEIGHT / 2,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        overflow: 'hidden',
        backgroundColor: Platform.select({
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.glass.backgroundStrong,
        }),
    },
    nativeBaseShade: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: theme.dark ? 'rgba(0, 0, 0, 0.16)' : 'rgba(255, 255, 255, 0.08)',
    },
    gestureLayer: {
        position: 'relative',
        zIndex: 3,
    },
    innerContainer: {
        flexDirection: 'row',
        alignItems: 'stretch',
        maxWidth: layout.maxWidth,
        width: '100%',
        alignSelf: 'center',
        height: BAR_HEIGHT,
    },
    tab: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 5,
        paddingBottom: 5,
    },
    tabContent: {
        width: 42,
        height: 25,
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
    },
    iconLayer: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
    },
    label: {
        fontSize: 10,
        lineHeight: 13,
        marginTop: 2,
        ...Typography.default('semiBold'),
    },
    labelActive: {
        color: theme.dark ? '#FFFFFF' : theme.colors.text,
        ...Typography.default('semiBold'),
    },
    labelInactive: {
        color: theme.dark ? 'rgba(255,255,255,0.58)' : theme.colors.textSecondary,
    },
    lensPosition: {
        position: 'absolute',
        top: (BAR_HEIGHT - LENS_HEIGHT) / 2,
        left: 0,
        height: LENS_HEIGHT,
        zIndex: 2,
    },
    restIndicatorPosition: {
        position: 'absolute',
        top: REST_INDICATOR_INSET,
        left: 0,
        height: BAR_HEIGHT - (REST_INDICATOR_INSET * 2),
        zIndex: 1,
        borderRadius: (BAR_HEIGHT - (REST_INDICATOR_INSET * 2)) / 2,
        backgroundColor: theme.dark ? 'rgba(255,255,255,0.105)' : theme.colors.glass.backgroundSubtle,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.dark ? 'rgba(255,255,255,0.10)' : theme.colors.glass.border,
    },
    lensShadow: {
        flex: 1,
        borderRadius: LENS_HEIGHT / 2,
        shadowColor: theme.colors.glass.shadow,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 1,
        shadowRadius: 14,
        elevation: 10,
    },
    lensSurface: {
        flex: 1,
        borderRadius: LENS_HEIGHT / 2,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.dark ? 'rgba(255,255,255,0.32)' : theme.colors.glass.border,
        overflow: 'hidden',
        backgroundColor: Platform.select({
            ios: 'transparent',
            android: theme.dark ? 'rgba(31,31,35,0.58)' : theme.colors.glass.backgroundStrong,
            default: theme.colors.glass.backgroundStrong,
        }),
    },
    badge: {
        position: 'absolute',
        top: -4,
        right: -2,
        zIndex: 2,
        backgroundColor: theme.colors.status.error,
        borderRadius: 8,
        minWidth: 16,
        height: 16,
        paddingHorizontal: 4,
        justifyContent: 'center',
        alignItems: 'center',
    },
    badgeText: {
        color: '#FFFFFF',
        fontSize: 10,
        ...Typography.default('semiBold'),
    },
    indicatorDot: {
        position: 'absolute',
        top: 0,
        right: 3,
        zIndex: 2,
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.dark ? '#FFFFFF' : theme.colors.text,
    },
}));

const NativeTabItem = React.memo(function NativeTabItem({
    tab,
    index,
    visualPosition,
    accessibilitySelected,
    onPress,
}: {
    tab: TabDefinition;
    index: number;
    visualPosition: SharedValue<number>;
    accessibilitySelected: boolean;
    onPress: (index: number) => void;
}) {
    const { theme } = useUnistyles();
    const touchScale = useSharedValue(1);
    const itemAnimatedStyle = useAnimatedStyle(() => {
        const activation = Math.max(0, 1 - Math.abs(visualPosition.value - index));
        return {
            opacity: 0.78 + (activation * 0.22),
            transform: [{ scale: (1 + (activation * 0.035)) * touchScale.value }],
        };
    }, [index]);
    const handlePressIn = React.useCallback(() => {
        touchScale.value = withTiming(1.04, {
            duration: 65,
            easing: Easing.out(Easing.quad),
        });
    }, [touchScale]);
    const handlePressOut = React.useCallback(() => {
        touchScale.value = withSpring(1, {
            damping: 14,
            stiffness: 520,
            mass: 0.4,
            overshootClamping: false,
        });
    }, [touchScale]);
    const handlePress = React.useCallback(() => {
        onPress(index);
    }, [index, onPress]);

    const activeTint = theme.dark ? '#FFFFFF' : theme.colors.text;
    const inactiveTint = theme.dark ? 'rgba(255,255,255,0.62)' : theme.colors.textSecondary;
    const inactiveIconAnimatedStyle = useAnimatedStyle(() => {
        const activation = Math.max(0, 1 - Math.abs(visualPosition.value - index));
        return { opacity: 1 - activation };
    }, [index]);
    const activeIconAnimatedStyle = useAnimatedStyle(() => {
        const activation = Math.max(0, 1 - Math.abs(visualPosition.value - index));
        return { opacity: activation };
    }, [index]);
    const labelAnimatedStyle = useAnimatedStyle(() => {
        const activation = Math.max(0, 1 - Math.abs(visualPosition.value - index));
        return {
            color: interpolateColor(
                activation,
                [0, 1],
                [inactiveTint, activeTint],
            ),
        };
    }, [activeTint, inactiveTint, index]);

    return (
        <AnimatedPressable
            style={[styles.tab, itemAnimatedStyle]}
            accessible
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: accessibilitySelected }}
            onPress={handlePress}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            hitSlop={4}
        >
            <View style={styles.tabContent}>
                <Animated.View style={[styles.iconLayer, inactiveIconAnimatedStyle]}>
                    <Ionicons name={tab.iconName} size={21} color={inactiveTint} />
                </Animated.View>
                <Animated.View style={[styles.iconLayer, activeIconAnimatedStyle]}>
                    <Ionicons name={tab.activeIconName} size={21} color={activeTint} />
                </Animated.View>
            </View>
            <Animated.Text style={[styles.label, labelAnimatedStyle]}>
                {tab.label}
            </Animated.Text>
        </AnimatedPressable>
    );
});

export const TabBar = React.memo(({ activeTab, onTabPress, inboxBadgeCount = 0 }: TabBarProps) => {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const inboxHasContent = useInboxHasContent();

    const nativeTabs: TabDefinition[] = React.useMemo(() => [
        { key: 'sessions', icon: require('@/assets/images/brutalist/Brutalism-15.png'), iconName: 'code-slash-outline', activeIconName: 'code-slash', label: t('tabs.sessions') },
        { key: 'settings', icon: require('@/assets/images/brutalist/Brutalism-9.png'), iconName: 'settings-outline', activeIconName: 'settings', label: t('tabs.settings') },
    ], []);
    const webTabs: TabDefinition[] = React.useMemo(() => [
        { key: 'inbox', icon: require('@/assets/images/brutalist/Brutalism-27.png'), iconName: 'mail-outline', activeIconName: 'mail', label: t('tabs.inbox') },
        { key: 'sessions', icon: require('@/assets/images/brutalist/Brutalism-15.png'), iconName: 'code-slash-outline', activeIconName: 'code-slash', label: t('tabs.sessions') },
        { key: 'settings', icon: require('@/assets/images/brutalist/Brutalism-9.png'), iconName: 'settings-outline', activeIconName: 'settings', label: t('tabs.settings') },
    ], []);
    const tabs = Platform.OS === 'web' ? webTabs : nativeTabs;

    const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.key === activeTab));
    const barWidth = useSharedValue(0);
    const visualPosition = useSharedValue(activeIndex);
    const visualTargetIndex = useSharedValue(activeIndex);
    const hoveredIndex = useSharedValue(activeIndex);
    const gestureOriginIndex = useSharedValue(activeIndex);
    const gestureProgress = useSharedValue(0);
    const gestureActive = useSharedValue(false);

    const hapticPreview = React.useCallback(() => {
        hapticsLight();
    }, []);

    const commitTab = React.useCallback((index: number) => {
        const tab = tabs[index];
        if (tab) {
            onTabPress(tab.key);
        }
    }, [onTabPress, tabs]);

    const handleNativePress = React.useCallback((index: number) => {
        const targetChanged = visualTargetIndex.value !== index;
        hoveredIndex.value = index;
        visualTargetIndex.value = index;
        visualPosition.value = withTiming(index, tabTransition(visualPosition.value, index));
        if (targetChanged) {
            hapticPreview();
        }
        commitTab(index);
    }, [commitTab, hapticPreview, hoveredIndex, visualPosition, visualTargetIndex]);

    React.useEffect(() => {
        if (gestureActive.value || visualTargetIndex.value === activeIndex) {
            return;
        }
        visualTargetIndex.value = activeIndex;
        hoveredIndex.value = activeIndex;
        visualPosition.value = withTiming(
            activeIndex,
            tabTransition(visualPosition.value, activeIndex),
        );
    }, [activeIndex, gestureActive, hoveredIndex, visualPosition, visualTargetIndex]);

    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        const width = event.nativeEvent.layout.width;
        if (width <= 0) {
            return;
        }
        if (Math.abs(barWidth.value - width) < 0.5) {
            return;
        }
        barWidth.value = width;
    }, [barWidth]);

    const longDragGesture = React.useMemo(() => Gesture.Pan()
        .activateAfterLongPress(HOLD_DURATION)
        .cancelsTouchesInView(true)
        .onStart((event) => {
            const width = barWidth.value;
            if (width <= 0) {
                return;
            }
            gestureActive.value = true;
            gestureOriginIndex.value = visualTargetIndex.value;
            gestureProgress.value = withTiming(1, { duration: 90, easing: Easing.out(Easing.quad) });
            const slotWidth = width / TAB_COUNT;
            const nextIndex = Math.max(0, Math.min(TAB_COUNT - 1, Math.floor(event.x / slotWidth)));
            hoveredIndex.value = nextIndex;
            visualPosition.value = Math.max(
                0,
                Math.min(TAB_COUNT - 1, (event.x / slotWidth) - 0.5),
            );
            runOnJS(hapticPreview)();
        })
        .onUpdate((event) => {
            const width = barWidth.value;
            if (width <= 0) {
                return;
            }
            const slotWidth = width / TAB_COUNT;
            visualPosition.value = Math.max(
                0,
                Math.min(TAB_COUNT - 1, (event.x / slotWidth) - 0.5),
            );
            const nextIndex = Math.max(0, Math.min(TAB_COUNT - 1, Math.floor(event.x / slotWidth)));
            if (nextIndex !== hoveredIndex.value) {
                hoveredIndex.value = nextIndex;
                runOnJS(hapticPreview)();
            }
        })
        .onEnd(() => {
            const nextIndex = hoveredIndex.value;
            gestureActive.value = false;
            visualTargetIndex.value = nextIndex;
            gestureProgress.value = withTiming(0, { duration: 110, easing: Easing.out(Easing.quad) });
            visualPosition.value = withTiming(
                nextIndex,
                tabTransition(visualPosition.value, nextIndex),
            );
            runOnJS(commitTab)(nextIndex);
        })
        .onFinalize((_event, success) => {
            // The long-press Pan also finalizes unsuccessfully after an ordinary
            // tap. Restore only if it had actually activated.
            if (success || !gestureActive.value) {
                return;
            }
            const originIndex = gestureOriginIndex.value;
            gestureActive.value = false;
            gestureProgress.value = withTiming(0, { duration: 100 });
            hoveredIndex.value = originIndex;
            visualTargetIndex.value = originIndex;
            visualPosition.value = withTiming(
                originIndex,
                tabTransition(visualPosition.value, originIndex),
            );
        }), [
        barWidth,
        commitTab,
        gestureActive,
        gestureOriginIndex,
        gestureProgress,
        hapticPreview,
        hoveredIndex,
        visualPosition,
        visualTargetIndex,
    ]);

    const lensAnimatedStyle = useAnimatedStyle(() => {
        const width = barWidth.value;
        const lensWidth = width > 0 ? (width / TAB_COUNT) + LENS_OVERLAP : 0;
        const progress = Math.max(0, Math.min(1, gestureProgress.value));
        return {
            width: lensWidth,
            opacity: width > 0 ? progress : 0,
            transform: [
                { translateX: (visualPosition.value * (width / TAB_COUNT)) - (LENS_OVERLAP / 2) },
                { translateY: -progress },
                { scaleX: 1 + (progress * 0.02) },
                { scaleY: 1 + (progress * 0.045) },
            ],
        };
    });

    const restIndicatorAnimatedStyle = useAnimatedStyle(() => {
        const width = barWidth.value;
        const progress = Math.max(0, Math.min(1, gestureProgress.value));
        return {
            width: width > 0 ? Math.max(0, (width / TAB_COUNT) - (REST_INDICATOR_INSET * 2)) : 0,
            opacity: width > 0 ? 1 - progress : 0,
            transform: [{
                translateX: (visualPosition.value * (width / TAB_COUNT)) + REST_INDICATOR_INSET,
            }],
        };
    });

    if (Platform.OS === 'web') {
        return (
            <View style={[styles.webOuterContainer, { paddingBottom: insets.bottom }]}>
                <View style={styles.webInnerContainer}>
                    {tabs.map((tab) => {
                        const isActive = activeTab === tab.key;
                        return (
                            <Pressable
                                key={tab.key}
                                style={styles.webTab}
                                onPress={() => onTabPress(tab.key)}
                                hitSlop={8}
                            >
                                <View style={styles.webTabContent}>
                                    <Image
                                        source={tab.icon}
                                        contentFit="contain"
                                        style={{ width: 24, height: 24 }}
                                        tintColor={isActive ? theme.colors.text : theme.colors.textSecondary}
                                    />
                                    {tab.key === 'inbox' && inboxBadgeCount > 0 && (
                                        <View style={styles.webBadge}>
                                            <Text style={styles.badgeText}>
                                                {inboxBadgeCount > 99 ? '99+' : inboxBadgeCount}
                                            </Text>
                                        </View>
                                    )}
                                    {tab.key === 'inbox' && inboxHasContent && inboxBadgeCount === 0 && (
                                        <View style={styles.webIndicatorDot} />
                                    )}
                                </View>
                                <Text style={[styles.webLabel, isActive ? styles.labelActive : styles.labelInactive]}>
                                    {tab.label}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
            </View>
        );
    }

    return (
        <View pointerEvents="box-none" style={[styles.nativeSafeArea, { paddingBottom: Math.max(insets.bottom, 9) }]}>
            <View pointerEvents="box-none" style={styles.nativeShadow}>
                <View style={styles.nativeShell} onLayout={handleLayout}>
                    <MobileGlassSurface
                        nativeEffect
                        intensity={84}
                        glassEffectStyle="clear"
                        tintColor={theme.colors.glass.tint}
                        style={styles.nativeBaseSurface}
                    >
                        <View pointerEvents="none" style={styles.nativeBaseShade} />
                    </MobileGlassSurface>

                    <Animated.View
                        pointerEvents="none"
                        style={[styles.restIndicatorPosition, restIndicatorAnimatedStyle]}
                    />

                    <Animated.View pointerEvents="none" style={[styles.lensPosition, lensAnimatedStyle]}>
                        <View style={styles.lensShadow}>
                            <MobileGlassSurface
                                nativeEffect
                                intensity={94}
                                glassEffectStyle="regular"
                                tintColor={theme.colors.glass.overlayTint}
                                style={styles.lensSurface}
                            >
                            </MobileGlassSurface>
                        </View>
                    </Animated.View>

                    <GestureDetector gesture={longDragGesture}>
                        <View style={styles.gestureLayer}>
                            <View style={styles.innerContainer}>
                                {tabs.map((tab, index) => (
                                    <NativeTabItem
                                        key={tab.key}
                                        tab={tab}
                                        index={index}
                                        visualPosition={visualPosition}
                                        accessibilitySelected={activeIndex === index}
                                        onPress={handleNativePress}
                                    />
                                ))}
                            </View>
                        </View>
                    </GestureDetector>
                </View>
            </View>
        </View>
    );
});
