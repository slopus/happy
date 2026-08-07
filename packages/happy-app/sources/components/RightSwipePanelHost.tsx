import * as React from 'react';
import { useIsFocused } from '@react-navigation/native';
import { BackHandler, Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { DrawerGestureContext } from 'react-native-drawer-layout';
import { useNavigation } from 'expo-router';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { useIsTablet } from '@/utils/responsive';
import { getResponsiveRightPanelMode, type ResponsiveRightPanelMode } from '@/utils/desktopNavigationLayout';
import { hapticsLight } from './haptics';
import { ExternalHorizontalGestureContext } from './ExternalHorizontalGestureContext';

type Props = {
    children: React.ReactNode;
    panelContent?: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    openAccessibilityLabel: string;
    closeAccessibilityLabel: string;
    panelAccessibilityLabel: string;
    enabled?: boolean;
    mode?: Exclude<ResponsiveRightPanelMode, 'persistent'>;
};

type PanelBackHandler = () => boolean;

type RightSwipePanelContextValue = {
    closePanel: (onClosed?: () => void) => void;
    focusPanel: () => void;
    isOpen: boolean;
    openPanel: () => void;
    registerBackHandler: (handler: PanelBackHandler) => () => void;
};

type ElementIsolationSnapshot = {
    ariaHidden: string | null;
    element: HTMLElement;
    inert: string | null;
};

const RightSwipePanelContext = React.createContext<RightSwipePanelContextValue | null>(null);

const DECIDE_OFFSET = 3;
const OPEN_PROGRESS_THRESHOLD = 0.28;
const CLOSE_PROGRESS_THRESHOLD = 0.72;
const SPRING_CONFIG = {
    damping: 28,
    stiffness: 320,
    mass: 0.9,
};

function restoreElementIsolation(snapshot: ElementIsolationSnapshot): void {
    for (const [attribute, value] of [
        ['aria-hidden', snapshot.ariaHidden],
        ['inert', snapshot.inert],
    ] as const) {
        if (value === null) {
            snapshot.element.removeAttribute(attribute);
        } else {
            snapshot.element.setAttribute(attribute, value);
        }
    }
}

function isolateElement(element: HTMLElement): ElementIsolationSnapshot {
    const snapshot = {
        ariaHidden: element.getAttribute('aria-hidden'),
        element,
        inert: element.getAttribute('inert'),
    };
    element.setAttribute('inert', '');
    element.setAttribute('aria-hidden', 'true');
    return snapshot;
}

function isolateOutsideHostBranch(host: HTMLElement): ElementIsolationSnapshot[] {
    const snapshots: ElementIsolationSnapshot[] = [];
    let branch: HTMLElement = host;

    while (branch.parentElement) {
        const parent = branch.parentElement;
        for (const sibling of Array.from(parent.children)) {
            if (sibling !== branch && sibling instanceof HTMLElement) {
                snapshots.push(isolateElement(sibling));
            }
        }
        if (parent === document.body) break;
        branch = parent;
    }

    return snapshots;
}

export const RightSwipePanelHost = React.memo(function RightSwipePanelHost({
    children,
    closeAccessibilityLabel,
    enabled: enabledOverride,
    mode,
    onOpenChange,
    open: controlledOpen,
    openAccessibilityLabel,
    panelAccessibilityLabel,
    panelContent,
}: Props) {
    const navigation = useNavigation();
    const isFocused = useIsFocused();
    const safeArea = useSafeAreaInsets();
    const { height: windowHeight, width: windowWidth } = useWindowDimensions();
    const isTablet = useIsTablet();
    const drawerPan = React.useContext(DrawerGestureContext);
    const enabled = (panelContent !== undefined && panelContent !== null)
        && (enabledOverride ?? (Platform.OS !== 'web' && !isTablet));
    const widthMode = getResponsiveRightPanelMode(windowWidth);
    const responsiveMode = mode ?? (widthMode === 'edge-handle' ? 'edge-handle' : 'drawer-toggle');
    const [hostWidth, setHostWidth] = React.useState(windowWidth);
    const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
    const open = controlledOpen ?? uncontrolledOpen;
    const preferredPanelWidth = Math.min(
        Math.max(Math.floor(hostWidth * 0.72), 260),
        340,
    );
    const minimumVisibleMainWidth = responsiveMode === 'drawer-toggle' ? 240 : 110;
    const panelWidth = Math.min(preferredPanelWidth, Math.max(0, hostWidth - minimumVisibleMainWidth));
    const mainWidth = Platform.OS === 'web' && open
        ? Math.max(0, hostWidth - panelWidth)
        : hostWidth;

    const progress = useSharedValue(0);
    const startProgress = useSharedValue(0);
    const startX = useSharedValue(0);
    const startY = useSharedValue(0);
    const decided = useSharedValue(false);
    const backHandlerRef = React.useRef<PanelBackHandler | null>(null);
    const mountedRef = React.useRef(true);
    const animationRequestRef = React.useRef(0);
    const pendingCloseRef = React.useRef<{ id: number; onClosed?: () => void } | null>(null);
    const hostRef = React.useRef<any>(null);
    const mainRef = React.useRef<any>(null);
    const panelRef = React.useRef<any>(null);
    const focusReturnRef = React.useRef<HTMLElement | null>(null);
    const mainIsolationRef = React.useRef<ElementIsolationSnapshot | null>(null);
    const outsideIsolationRef = React.useRef<ElementIsolationSnapshot[]>([]);
    const previousOpenRef = React.useRef(false);

    const setPanelOpen = React.useCallback((nextOpen: boolean) => {
        if (controlledOpen === undefined) {
            setUncontrolledOpen(nextOpen);
        }
        onOpenChange?.(nextOpen);
    }, [controlledOpen, onOpenChange]);

    const supersedePanelAnimation = React.useCallback(() => {
        animationRequestRef.current += 1;
        pendingCloseRef.current = null;
    }, []);

    const completePanelClose = React.useCallback((requestId: number, finished: boolean) => {
        if (!mountedRef.current) return;
        const pending = pendingCloseRef.current;
        if (!pending || pending.id !== requestId) return;
        pendingCloseRef.current = null;
        if (!finished) return;
        setPanelOpen(false);
        pending.onClosed?.();
    }, [setPanelOpen]);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            supersedePanelAnimation();
        };
    }, [supersedePanelAnimation]);

    const openPanel = React.useCallback(() => {
        supersedePanelAnimation();
        hapticsLight();
        setPanelOpen(true);
        progress.value = withSpring(1, SPRING_CONFIG);
    }, [progress, setPanelOpen, supersedePanelAnimation]);

    React.useEffect(() => {
        if (controlledOpen === undefined) return;
        supersedePanelAnimation();
        // On web the controlled accessibility state (role/inert/aria-hidden)
        // and the panel geometry must change atomically. Native keeps the
        // spring because its focus model cannot scroll the hidden filmstrip.
        progress.value = Platform.OS === 'web'
            ? (controlledOpen ? 1 : 0)
            : withSpring(controlledOpen ? 1 : 0, SPRING_CONFIG);
    }, [controlledOpen, progress, supersedePanelAnimation]);

    const closePanel = React.useCallback((onClosed?: () => void) => {
        const requestId = animationRequestRef.current + 1;
        animationRequestRef.current = requestId;
        pendingCloseRef.current = { id: requestId, onClosed };
        hapticsLight();
        progress.value = withSpring(0, SPRING_CONFIG, (finished) => {
            runOnJS(completePanelClose)(requestId, finished === true);
        });
    }, [completePanelClose, progress]);

    const focusPanel = React.useCallback(() => {
        const restoreFocus = () => {
            const panel = panelRef.current as HTMLElement | null;
            if (!panel || panel.getAttribute('aria-hidden') === 'true') return;
            panel.focus?.({ preventScroll: true });
        };

        if (Platform.OS === 'web' && typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(restoreFocus);
        } else if (Platform.OS === 'web') {
            setTimeout(restoreFocus, 0);
        } else {
            panelRef.current?.focus?.();
        }
    }, []);

    const restoreModalIsolation = React.useCallback(() => {
        const mainSnapshot = mainIsolationRef.current;
        mainIsolationRef.current = null;
        if (mainSnapshot) restoreElementIsolation(mainSnapshot);

        const outsideSnapshots = outsideIsolationRef.current;
        outsideIsolationRef.current = [];
        for (let index = outsideSnapshots.length - 1; index >= 0; index -= 1) {
            restoreElementIsolation(outsideSnapshots[index]);
        }
    }, []);

    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || typeof document === 'undefined') {
            previousOpenRef.current = open;
            return;
        }

        const host = hostRef.current as HTMLElement | null;
        const main = mainRef.current as HTMLElement | null;
        const panel = panelRef.current as HTMLElement | null;
        const wasOpen = previousOpenRef.current;
        previousOpenRef.current = open;
        if (open) {
            if (!wasOpen) {
                const activeElement = document.activeElement;
                if (activeElement instanceof HTMLElement && !panel?.contains(activeElement)) {
                    focusReturnRef.current = activeElement;
                }
            }

            // Expose and focus the dialog before hiding the currently focused
            // main tree. This ordering avoids the browser rejecting
            // aria-hidden on an ancestor that still owns activeElement.
            panel?.removeAttribute('aria-hidden');
            panel?.removeAttribute('inert');
            if (!wasOpen) {
                if (host) host.scrollLeft = 0;
                panel?.focus?.({ preventScroll: true });
                if (host) host.scrollLeft = 0;
                if (main) mainIsolationRef.current = isolateElement(main);
                if (host) outsideIsolationRef.current = isolateOutsideHostBranch(host);
            }
            return;
        }

        // Restore the main tree and its opener before hiding the dialog that
        // currently owns focus.
        restoreModalIsolation();
        if (wasOpen) {
            const focusTarget = focusReturnRef.current;
            focusReturnRef.current = null;
            focusTarget?.focus({ preventScroll: true });
        }
        panel?.setAttribute('aria-hidden', 'true');
        panel?.setAttribute('inert', '');
    }, [open, restoreModalIsolation]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return undefined;
        const panelElement = panelRef.current as HTMLElement | null;
        return () => {
            restoreModalIsolation();
            panelElement?.removeAttribute('inert');
            panelElement?.removeAttribute('aria-hidden');
        };
    }, [restoreModalIsolation]);

    const registerBackHandler = React.useCallback((handler: PanelBackHandler) => {
        backHandlerRef.current = handler;
        return () => {
            if (backHandlerRef.current === handler) {
                backHandlerRef.current = null;
            }
        };
    }, []);

    const handlePanelBack = React.useCallback(() => {
        if (!isFocused || !open) return false;
        if (backHandlerRef.current?.()) {
            focusPanel();
            return true;
        }
        closePanel();
        return true;
    }, [closePanel, focusPanel, isFocused, open]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !open || typeof document === 'undefined') return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                if (!handlePanelBack()) return;
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            if (event.key !== 'Tab') return;
            const panel = panelRef.current as HTMLElement | null;
            if (!panel) return;
            const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
                'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            )).filter((element) => element.getAttribute('aria-hidden') !== 'true');
            if (focusable.length === 0) {
                event.preventDefault();
                panel.focus();
                return;
            }
            const activeElement = document.activeElement;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!panel.contains(activeElement)) {
                event.preventDefault();
                first.focus();
            } else if (event.shiftKey && (activeElement === first || activeElement === panel)) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', handleKeyDown, true);
        return () => document.removeEventListener('keydown', handleKeyDown, true);
    }, [handlePanelBack, open]);

    React.useEffect(() => {
        if (!enabled || !isFocused) return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', handlePanelBack);
        return () => subscription.remove();
    }, [enabled, handlePanelBack, isFocused]);

    React.useEffect(() => {
        if (!enabled || !isFocused) return;
        return navigation.addListener('beforeRemove', (event) => {
            const actionType = event.data.action.type;
            if (actionType !== 'GO_BACK' && actionType !== 'POP') return;
            if (!handlePanelBack()) return;
            event.preventDefault();
        });
    }, [enabled, handlePanelBack, isFocused, navigation]);

    const contextValue = React.useMemo<RightSwipePanelContextValue>(() => ({
        closePanel,
        focusPanel,
        isOpen: open,
        openPanel,
        registerBackHandler,
    }), [closePanel, focusPanel, open, openPanel, registerBackHandler]);

    const horizontalGesture = React.useMemo(() => {
        const pan = Gesture.Pan()
            .enabled(enabled)
            .manualActivation(true)
            .onTouchesDown((e) => {
                'worklet';
                const t = e.allTouches[0];
                if (!t) return;
                startX.value = t.x;
                startY.value = t.y;
                decided.value = false;
            })
            .onTouchesMove((e, state) => {
                'worklet';
                if (decided.value) return;
                const t = e.allTouches[0];
                if (!t) return;
                const dx = t.x - startX.value;
                const dy = t.y - startY.value;
                const adx = Math.abs(dx);
                const ady = Math.abs(dy);
                if (adx < DECIDE_OFFSET && ady < DECIDE_OFFSET) return;

                decided.value = true;
                if (ady > adx) { state.fail(); return; }
                if (!open && dx > 0) { state.fail(); return; }
                state.activate();
            })
            .onStart(() => {
                'worklet';
                runOnJS(supersedePanelAnimation)();
                startProgress.value = progress.value;
            })
            .onUpdate((e) => {
                'worklet';
                progress.value = Math.max(0, Math.min(1, startProgress.value - (e.translationX / panelWidth)));
            })
            .onEnd((e) => {
                'worklet';
                const projected = progress.value + Math.max(-0.22, Math.min(0.22, -e.velocityX / 2600));
                if (projected >= (e.translationX < 0 ? OPEN_PROGRESS_THRESHOLD : CLOSE_PROGRESS_THRESHOLD)) {
                    runOnJS(hapticsLight)();
                    runOnJS(setPanelOpen)(true);
                    progress.value = withSpring(1, {
                        ...SPRING_CONFIG,
                        velocity: -e.velocityX / panelWidth,
                    });
                } else {
                    progress.value = withSpring(0, {
                        ...SPRING_CONFIG,
                        velocity: -e.velocityX / panelWidth,
                    }, (finished) => {
                        if (finished) {
                            runOnJS(setPanelOpen)(false);
                        }
                    });
                    runOnJS(hapticsLight)();
                }
            });
        if (drawerPan) {
            pan.blocksExternalGesture(drawerPan);
        }
        return pan;
    }, [decided, drawerPan, enabled, open, panelWidth, progress, setPanelOpen, startProgress, startX, startY, supersedePanelAnimation]);

    const externalHorizontalGestures = React.useMemo(() => [horizontalGesture], [horizontalGesture]);

    const scrimStyle = useAnimatedStyle(() => ({
        opacity: progress.value * 0.38,
    }));

    const filmstripStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: -progress.value * panelWidth }],
    }));

    if (!enabled) {
        return <>{children}</>;
    }

    return (
        <RightSwipePanelContext.Provider value={contextValue}>
            <ExternalHorizontalGestureContext.Provider value={externalHorizontalGestures}>
                <GestureDetector gesture={horizontalGesture}>
                    <View
                        collapsable={false}
                        ref={hostRef}
                        onLayout={(event) => {
                            const measuredWidth = Math.round(event.nativeEvent.layout.width);
                            if (measuredWidth > 0 && measuredWidth !== hostWidth) setHostWidth(measuredWidth);
                        }}
                        style={styles.host}
                        testID="right-swipe-panel-host"
                    >
                        <Animated.View
                            style={[
                                styles.filmstrip,
                                { width: Platform.OS === 'web' && open ? hostWidth : hostWidth + panelWidth },
                                Platform.OS !== 'web' && filmstripStyle,
                            ]}
                        >
                            <View
                                ref={mainRef}
                                style={{ width: mainWidth }}
                                testID="right-swipe-panel-main"
                            >
                                {children}
                                <Animated.View
                                    style={[styles.mainScrim, scrimStyle]}
                                />
                            </View>
                            <View
                                accessibilityLabel={panelAccessibilityLabel}
                                accessibilityElementsHidden={Platform.OS === 'web' ? undefined : !open}
                                importantForAccessibility={Platform.OS === 'web'
                                    ? undefined
                                    : open ? 'auto' : 'no-hide-descendants'}
                                ref={panelRef}
                                style={[
                                    styles.panel,
                                    {
                                        width: panelWidth,
                                        paddingTop: safeArea.top + 12,
                                        paddingBottom: safeArea.bottom + 12,
                                    },
                                ]}
                                {...(Platform.OS === 'web' ? ({
                                    'aria-modal': open ? true : undefined,
                                    role: open ? 'dialog' : undefined,
                                    tabIndex: open ? -1 : undefined,
                                } as any) : {})}
                                testID="right-swipe-panel-drawer"
                            >
                                <Pressable
                                    accessibilityLabel={closeAccessibilityLabel}
                                    accessibilityRole="button"
                                    hitSlop={8}
                                    onPress={() => closePanel()}
                                    style={styles.closeButton}
                                    testID="right-swipe-panel-close-button"
                                >
                                    <View
                                        style={styles.closeGrabber}
                                    />
                                </Pressable>
                                <View style={styles.panelContent}>
                                    {panelContent}
                                </View>
                            </View>
                        </Animated.View>
                        {open && (
                            <Pressable
                                accessibilityElementsHidden
                                accessible={false}
                                importantForAccessibility="no-hide-descendants"
                                onPress={() => closePanel()}
                                style={[styles.scrimPressable, { width: Math.max(0, hostWidth - panelWidth) }]}
                                testID="right-swipe-panel-scrim"
                            >
                                <View style={styles.scrimFill} />
                            </Pressable>
                        )}
                        {Platform.OS === 'web' && responsiveMode === 'edge-handle' && (
                            <Pressable
                                accessibilityLabel={open ? closeAccessibilityLabel : openAccessibilityLabel}
                                accessibilityRole="button"
                                accessibilityState={{ expanded: open }}
                                aria-expanded={open}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 0 }}
                                onPress={open ? () => closePanel() : openPanel}
                                style={[
                                    styles.edgeHandle,
                                    {
                                        // Once open, keep the handle attached to
                                        // the drawer's leading edge on the dimmed
                                        // main side so it cannot cover Hub cards.
                                        right: open ? panelWidth : 0,
                                        top: Math.max(safeArea.top + 88, Math.floor(windowHeight * 0.42)),
                                    },
                                ]}
                                testID="right-swipe-panel-edge-handle"
                            >
                                <View
                                    style={styles.edgeHandleBar}
                                />
                            </Pressable>
                        )}
                    </View>
                </GestureDetector>
            </ExternalHorizontalGestureContext.Provider>
        </RightSwipePanelContext.Provider>
    );
});

export function useRightSwipePanel() {
    return React.useContext(RightSwipePanelContext);
}

const styles = StyleSheet.create((theme) => ({
    host: {
        flex: 1,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface,
    },
    filmstrip: {
        flex: 1,
        flexDirection: 'row',
    },
    mainScrim: {
        pointerEvents: 'none',
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: '#000',
    },
    panel: {
        backgroundColor: theme.colors.surface,
    },
    closeButton: {
        alignSelf: 'center',
        width: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
    },
    closeGrabber: {
        width: 36,
        height: 4,
        borderRadius: 2,
        backgroundColor: theme.colors.divider,
        opacity: 0.9,
    },
    panelContent: {
        flex: 1,
        minHeight: 0,
    },
    scrimPressable: {
        position: 'absolute',
        top: 0,
        left: 0,
        bottom: 0,
    },
    scrimFill: {
        flex: 1,
    },
    edgeHandle: {
        position: 'absolute',
        minWidth: 40,
        minHeight: 40,
        width: 40,
        height: 56,
        alignItems: 'center',
        justifyContent: 'center',
        borderTopLeftRadius: 14,
        borderBottomLeftRadius: 14,
        borderWidth: 1,
        borderRightWidth: 0,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        zIndex: 1200,
    },
    edgeHandleBar: {
        width: 4,
        height: 24,
        borderRadius: 2,
        backgroundColor: theme.colors.divider,
    },
}));
