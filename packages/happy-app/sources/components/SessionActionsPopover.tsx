import * as React from 'react';
import { Pressable, Modal as RNModal, Text, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { useSessionQuickActions, SessionActionItem } from '@/hooks/useSessionQuickActions';
import { useSession } from '@/sync/storage';

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
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    onSelectSession?: () => void;
    onClose: () => void;
    sessionId: string;
    visible: boolean;
    inline?: boolean;
}


const WEB_MENU_WIDTH = 232;
const WEB_MENU_ITEM_HEIGHT = 48;
const WEB_MENU_MARGIN = 12;

const stylesheet = StyleSheet.create((theme) => ({
    backdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.12)',
    },
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 18,
        shadowOffset: {
            width: 0,
            height: 8,
        },
        elevation: 10,
    },
    menuItem: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        gap: 12,
    },
    menuItemPressed: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    menuItemDivider: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    menuItemLabel: {
        flex: 1,
        fontSize: 15,
        lineHeight: 20,
        ...Typography.default(),
    },
    webContainer: {
        flex: 1,
    },
    webMenu: {
        position: 'absolute',
        width: WEB_MENU_WIDTH,
    },
    inlineMenu: {
        position: 'absolute',
        right: 0,
        top: 44,
        width: WEB_MENU_WIDTH,
        zIndex: 80,
    },
}));

export function SessionActionsPopover({
    anchor,
    onAfterArchive,
    onAfterDelete,
    onSelectSession,
    onClose,
    sessionId,
    visible,
    inline = false,
}: SessionActionsPopoverProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { height: windowHeight, width: windowWidth } = useWindowDimensions();
    const session = useSession(sessionId);
    const { actionItems: actions } = useSessionQuickActions(session!, {
        onAfterArchive,
        onAfterDelete,
        onSelectSession,
    });

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

    if (!visible || !anchor || !session) {
        return null;
    }

    const content = (
        <View style={[styles.card, { backgroundColor: theme.colors.header.background }]}>
            {actions.map((action, index) => {
                const isLast = index === actions.length - 1;
                const color = action.destructive ? theme.colors.status.error : theme.colors.text;

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
                    </Pressable>
                );
            })}
        </View>
    );

    if (!position) {
        return null;
    }

    if (inline) {
        return (
            <View style={styles.inlineMenu} testID="session-actions-inline-menu">
                {content}
            </View>
        );
    }

    // Anchored context menu — appears at the press point on all platforms
    // (web right-click, native long-press), instead of a centered alert or
    // bottom sheet. Matches the lightweight popover shown on web.
    return (
        <RNModal
            animationType="fade"
            onRequestClose={onClose}
            transparent
            visible={visible}
        >
            <View style={styles.webContainer}>
                <Pressable onPress={onClose} style={styles.backdrop} />
                <View
                    style={[
                        styles.webMenu,
                        {
                            left: position.left,
                            top: position.top,
                        },
                    ]}
                >
                    {content}
                </View>
            </View>
        </RNModal>
    );
}
