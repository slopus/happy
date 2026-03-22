import * as React from 'react';
import { Pressable, Modal as RNModal, Platform, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { Session } from '@/sync/storageTypes';
import { t } from '@/text';

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
    onClose: () => void;
    session: Session;
    visible: boolean;
}

interface SessionActionItem {
    destructive?: boolean;
    icon: keyof typeof Ionicons.glyphMap;
    id: string;
    label: string;
    onPress: () => void;
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
    nativeContainer: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    nativeSheet: {
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        overflow: 'hidden',
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
    onClose,
    session,
    visible,
}: SessionActionsPopoverProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const { height: windowHeight, width: windowWidth } = useWindowDimensions();
    const {
        archiveSession,
        canArchive,
        canCopySessionMetadata,
        canShowResume,
        copySessionMetadata,
        openDetails,
        resumeSession,
    } = useSessionQuickActions(session, {
        onAfterArchive,
        onAfterDelete,
    });

    const actions = React.useMemo<SessionActionItem[]>(() => {
        const items: SessionActionItem[] = [
            {
                id: 'details',
                icon: 'information-circle-outline',
                label: t('profile.details'),
                onPress: openDetails,
            },
        ];

        if (canArchive) {
            items.push({
                id: 'archive',
                icon: 'archive-outline',
                label: 'Archive',
                onPress: archiveSession,
            });
        }

        if (canShowResume) {
            items.push({
                id: 'resume',
                icon: 'play-circle-outline',
                label: t('sessionInfo.resumeSession'),
                onPress: resumeSession,
            });
        }

        if (canCopySessionMetadata) {
            items.push({
                id: 'copy-session-metadata',
                icon: 'bug-outline',
                label: t('sessionInfo.copyMetadata'),
                onPress: copySessionMetadata,
            });
        }

        return items;
    }, [
        archiveSession,
        canArchive,
        canCopySessionMetadata,
        canShowResume,
        copySessionMetadata,
        openDetails,
        resumeSession,
    ]);

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

    if (!visible || !anchor) {
        return null;
    }

    const content = (
        <View style={[styles.card, { backgroundColor: theme.colors.header.background }]}>
            {Platform.OS !== 'web' && (
                <View style={[styles.handle, { backgroundColor: theme.colors.textSecondary }]} />
            )}
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
                            name={action.icon}
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

    if (Platform.OS === 'web' && position) {
        return (
            <RNModal
                animationType="none"
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

    return (
        <RNModal
            animationType="fade"
            onRequestClose={onClose}
            transparent
            visible={visible}
        >
            <View style={styles.nativeContainer}>
                <Pressable onPress={onClose} style={styles.backdrop} />
                <View
                    style={[
                        styles.nativeSheet,
                        {
                            backgroundColor: theme.colors.header.background,
                            paddingBottom: Math.max(16, safeArea.bottom),
                        },
                    ]}
                >
                    {content}
                </View>
            </View>
        </RNModal>
    );
}
