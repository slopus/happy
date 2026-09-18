import * as React from 'react';
import { Pressable, Modal as RNModal, Platform, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { useSessionQuickActions, MISSING_SESSION, SessionActionItem } from '@/hooks/useSessionQuickActions';
import { useSession } from '@/sync/storage';
import {
    formatShortcutChord,
    getPreferredShortcutModifier,
    matchesShortcutChord,
    SESSION_ACTION_SHORTCUTS,
} from '@/keyboard/shortcuts';
import { MobileGlassSurface } from './MobileGlass';
import { AnimatedPopup, LocalBlurHalo } from './AnimatedOverlay';

export type SessionActionsAnchor =
    | {
        type: 'point';
        x: number;
        y: number;
    }
    | {
        type: 'rect';
        x: number;
        y: number;
        width: number;
        height: number;
    };

interface SessionActionsPopoverProps {
    anchor: SessionActionsAnchor | null;
    /** Runs on the press, before the archive is attempted. See `useSessionQuickActions`. */
    onBeforeArchive?: () => void;
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    onClose: () => void;
    sessionId: string;
    visible: boolean;
}


const WEB_MENU_WIDTH = 288;
const WEB_MENU_ITEM_HEIGHT = 48;
const WEB_MENU_MARGIN = 12;

/** Shared by the card, the halo around it and the sheet that carries it. */
const CARD_RADIUS = 22;
/** How far the floating sheet stays clear of the screen edges. */
const SHEET_INSET = 12;

const stylesheet = StyleSheet.create((theme) => ({
    backdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        overflow: 'hidden',
    },
    backdropScrim: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0, 0, 0, 0.10)',
    },
    webBackdrop: {
        backgroundColor: 'rgba(0, 0, 0, 0.12)',
    },
    card: {
        borderRadius: CARD_RADIUS,
        overflow: 'hidden',
        // Transparent on iOS on purpose, the way the composer's surfaces are:
        // a fill painted over the glass hides the very refraction that makes it
        // glass. `theme.colors.glass.overlay` is 72% black in the dark theme,
        // which flattened this card into a plain panel.
        backgroundColor: Platform.select({
            web: theme.colors.surface,
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.surface,
        }),
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.glass.border,
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 18,
        shadowOffset: {
            width: 0,
            height: 8,
        },
        elevation: 10,
    },
    handle: {
        width: 40,
        height: 4,
        borderRadius: 999,
        marginTop: 10,
        marginBottom: 8,
        alignSelf: 'center',
    },
    menuItem: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        gap: 12,
    },
    // Translucent, so a press tints the glass instead of punching an opaque
    // patch through it.
    menuItemPressed: {
        backgroundColor: theme.dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.06)',
    },
    menuItemDivider: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.glass.divider,
    },
    menuItemLabel: {
        flex: 1,
        fontSize: 15,
        lineHeight: 20,
        ...Typography.default(),
    },
    menuItemShortcut: {
        flexShrink: 0,
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 18,
        ...Typography.default('semiBold'),
    },
    nativeContainer: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    // Floats clear of the edges rather than sitting flush against the bottom,
    // so the glass has content on every side to refract.
    nativeSheet: {
        marginHorizontal: SHEET_INSET,
        borderRadius: CARD_RADIUS,
    },
    webContainer: {
        flex: 1,
    },
    webMenu: {
        position: 'absolute',
        width: WEB_MENU_WIDTH,
    },
}));

export function SessionActionsPopover({
    anchor,
    onAfterArchive,
    onAfterDelete,
    onBeforeArchive,
    onClose,
    sessionId,
    visible,
}: SessionActionsPopoverProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const { height: windowHeight, width: windowWidth } = useWindowDimensions();
    const session = useSession(sessionId);
    const { actionItems: actions } = useSessionQuickActions(session ?? MISSING_SESSION, {
        onAfterArchive,
        onAfterDelete,
        onBeforeArchive,
    });
    const preferredModifier = React.useMemo(() => getPreferredShortcutModifier(
        typeof navigator === 'undefined' ? undefined : navigator
    ), []);

    const position = React.useMemo(() => {
        if (!anchor) {
            return null;
        }

        const estimatedHeight = actions.length * WEB_MENU_ITEM_HEIGHT;
        const leftBase = anchor.type === 'point'
            ? anchor.x
            : anchor.x + anchor.width - WEB_MENU_WIDTH;

        let topBase = anchor.type === 'point'
            ? anchor.y
            : anchor.y + anchor.height + 8;

        if (anchor.type === 'rect' && topBase + estimatedHeight > windowHeight - WEB_MENU_MARGIN) {
            topBase = anchor.y - estimatedHeight - 8;
        }

        return {
            left: Math.max(WEB_MENU_MARGIN, Math.min(windowWidth - WEB_MENU_WIDTH - WEB_MENU_MARGIN, leftBase)),
            top: Math.max(WEB_MENU_MARGIN, Math.min(windowHeight - estimatedHeight - WEB_MENU_MARGIN, topBase)),
        };
    }, [actions.length, anchor, windowHeight, windowWidth]);

    const handleActionPress = React.useCallback((action: SessionActionItem) => {
        onClose();
        action.onPress();
    }, [onClose]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined' || !visible || !anchor || !session) {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            const action = actions.find((candidate) => matchesShortcutChord(
                event,
                preferredModifier,
                SESSION_ACTION_SHORTCUTS[candidate.id],
            ));
            if (!action) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            handleActionPress(action);
        };

        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [actions, anchor, handleActionPress, preferredModifier, session, visible]);

    if (!visible || !anchor || !session) {
        return null;
    }

    const actionItems = actions.map((action, index) => {
        const isLast = index === actions.length - 1;
        const color = action.destructive ? theme.colors.status.error : theme.colors.text;
        const shortcutLabel = formatShortcutChord(
            preferredModifier,
            SESSION_ACTION_SHORTCUTS[action.id],
        );

        return (
            <Pressable
                key={action.id}
                accessibilityRole="button"
                onPress={() => handleActionPress(action)}
                style={({ pressed }) => [
                    styles.menuItem,
                    !isLast && styles.menuItemDivider,
                    pressed && styles.menuItemPressed,
                ]}
            >
                <Ionicons
                    color={color}
                    name={action.icon as keyof typeof Ionicons.glyphMap}
                    size={18}
                />
                <Text numberOfLines={1} style={[styles.menuItemLabel, { color }]}>
                    {action.label}
                </Text>
                {Platform.OS === 'web' && (
                    <Text style={styles.menuItemShortcut}>{shortcutLabel}</Text>
                )}
            </Pressable>
        );
    });

    const nativeContent = (
        <>
            <LocalBlurHalo borderRadius={CARD_RADIUS} expansion={14} />
            {/* Liquid Glass, the material the composer's surfaces use. The tint
                is left to the theme's light `glass.tint`: the old
                `glass.overlayTint` was 56% black and, over the fill this card
                used to carry, left nothing of the material visible. */}
            <MobileGlassSurface
                enabled
                nativeEffect
                glassEffectStyle="regular"
                intensity={92}
                style={styles.card}
            >
                {Platform.OS !== 'web' && (
                    <View style={[styles.handle, { backgroundColor: theme.colors.textSecondary }]} />
                )}
                {actionItems}
            </MobileGlassSurface>
        </>
    );

    if (Platform.OS === 'web' && position) {
        return (
            <RNModal
                animationType="none"
                onRequestClose={onClose}
                transparent
                visible={visible}
            >
                <View style={styles.webContainer}>
                    <Pressable onPress={onClose} style={[styles.backdrop, styles.webBackdrop]} />
                    <View
                        style={[
                            styles.webMenu,
                            {
                                left: position.left,
                                top: position.top,
                            },
                        ]}
                    >
                        <View style={[styles.card, { backgroundColor: theme.colors.header.background }]}>
                            {actionItems}
                        </View>
                    </View>
                </View>
            </RNModal>
        );
    }

    return (
        <RNModal
            animationType="fade"
            onRequestClose={onClose}
            transparent
            visible={visible}
        >
            <View style={styles.nativeContainer}>
                <Pressable onPress={onClose} style={styles.backdrop}>
                    <View pointerEvents="none" style={styles.backdropScrim} />
                </Pressable>
                <AnimatedPopup
                    style={[
                        styles.nativeSheet,
                        {
                            marginBottom: Math.max(SHEET_INSET, safeArea.bottom),
                        },
                    ]}
                >
                    {nativeContent}
                </AnimatedPopup>
            </View>
        </RNModal>
    );
}
