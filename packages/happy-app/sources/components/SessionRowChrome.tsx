import * as React from 'react';
import { Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { SessionActionsAnchor, SessionActionsPopover } from '@/components/SessionActionsPopover';
import { SessionRowData, useMachine, useSession } from '@/sync/storage';
import { t } from '@/text';
import { formatLastSeen } from '@/utils/sessionUtils';
import {
    buildSessionRowPresentation,
    isSessionTitleOverflowing,
    reduceSessionRowInteraction,
    shouldShowSessionRowDisclosure,
    shouldUseSessionRowMoreAction,
    stopSessionRowActionPropagation,
    type SessionRowPresentation,
} from '@/utils/sessionRowPresentation';
import { isSessionArchived } from '@/utils/sessionLifecycle';

const INITIAL_INTERACTION = { focused: false, hovered: false };

function useWebHoverCapability(): boolean {
    const [canHover, setCanHover] = React.useState(() => (
        Platform.OS !== 'web'
        || typeof window === 'undefined'
        || window.matchMedia('(hover: hover) and (pointer: fine)').matches
    ));

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        const query = window.matchMedia('(hover: hover) and (pointer: fine)');
        const update = () => setCanHover(query.matches);
        update();
        query.addEventListener?.('change', update);
        return () => query.removeEventListener?.('change', update);
    }, []);

    return canHover;
}

function anchorFromEvent(event: any): SessionActionsAnchor {
    const target = event?.currentTarget ?? event?.nativeEvent?.target;
    const rect = target?.getBoundingClientRect?.();
    if (rect) {
        return { type: 'rect', x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    }
    return {
        type: 'point',
        x: event?.nativeEvent?.clientX ?? event?.nativeEvent?.pageX ?? 0,
        y: event?.nativeEvent?.clientY ?? event?.nativeEvent?.pageY ?? 0,
    };
}

export function useSessionRowDisclosure(title: string) {
    const [interaction, dispatch] = React.useReducer(reduceSessionRowInteraction, INITIAL_INTERACTION);
    const [titleOverflowing, setTitleOverflowing] = React.useState(false);
    const wrapperRef = React.useRef<any>(null);
    const { width: viewportWidth } = useWindowDimensions();
    const visible = shouldShowSessionRowDisclosure(Platform.OS, viewportWidth, interaction);

    const refreshTitleOverflow = React.useCallback((root?: any) => {
        const node = (root ?? wrapperRef.current)?.querySelector?.('[data-testid="session-row-title"]');
        const overflowing = isSessionTitleOverflowing(node ? {
            clientWidth: node.clientWidth ?? 0,
            scrollWidth: node.scrollWidth ?? 0,
        } : null);
        if (node?.setAttribute && node?.removeAttribute) {
            if (overflowing) node.setAttribute('title', title);
            else node.removeAttribute('title');
        }
        setTitleOverflowing(overflowing);
    }, [title]);

    const interactionProps = React.useMemo(() => Platform.OS === 'web' ? ({
        onMouseEnter: (event: any) => {
            refreshTitleOverflow(event.currentTarget);
            dispatch('mouse-enter');
        },
        onMouseLeave: () => dispatch('mouse-leave'),
        onFocus: (event: any) => {
            refreshTitleOverflow(event.currentTarget);
            dispatch('focus');
        },
        onBlur: (event: any) => {
            if (!event.currentTarget?.contains?.(event.relatedTarget)) {
                dispatch('blur');
            }
        },
        onKeyDown: (event: any) => {
            if (event.key === 'Escape') {
                stopSessionRowActionPropagation(event);
                dispatch('escape');
            }
        },
    }) : {}, [refreshTitleOverflow]);

    return {
        interactionProps,
        titleOverflowing,
        visible,
        wrapperRef,
    };
}

export function useSessionRowPresentation(session: SessionRowData): SessionRowPresentation {
    const machine = useMachine(session.machineId ?? '');
    const machineName = machine?.metadata?.displayName || machine?.metadata?.host || null;

    return React.useMemo(() => buildSessionRowPresentation(session, machineName, {
        remoteLocation: (name) => t('sessionInfo.sessionRowRemoteLocation', { name }),
        unknownLocation: t('sessionInfo.sessionRowUnknownLocation'),
        unknownAgent: t('sessionInfo.sessionRowUnknownAgent'),
        status: {
            idle: t('status.idle'),
            running: t('status.running'),
            permission_required: t('status.permissionRequired'),
            failed: t('status.failed'),
            completed: t('status.completed'),
        },
        relativeTime: (timestamp) => formatLastSeen(timestamp, false),
    }), [machineName, session]);
}

export const SessionRowLocation = React.memo(function SessionRowLocation({
    presentation,
}: {
    presentation: SessionRowPresentation;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const webTitle = Platform.OS === 'web' ? { title: presentation.location.tooltip } as any : {};

    return (
        <View
            accessibilityLabel={presentation.location.tooltip}
            style={styles.locationRow}
            {...webTitle}
        >
            <Ionicons
                color={theme.colors.textSecondary}
                name={presentation.location.icon}
                size={12}
            />
            <Text numberOfLines={1} style={styles.locationText}>
                {presentation.location.text}
            </Text>
        </View>
    );
});

export const SessionRowDetails = React.memo(function SessionRowDetails({
    presentation,
    visible,
}: {
    presentation: SessionRowPresentation;
    visible: boolean;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    if (!visible) return null;

    const details = [
        { icon: 'folder-outline', label: t('sessionInfo.sessionRowProjectPath'), value: presentation.path || presentation.project },
        { icon: 'desktop-outline', label: t('sessionInfo.sessionRowMachineAgent'), value: `${presentation.machine} · ${presentation.agent}` },
        { icon: 'time-outline', label: t('sessionInfo.sessionRowRelativeTime'), value: presentation.relativeTime || t('status.unknown') },
        { icon: 'pulse-outline', label: t('sessionInfo.sessionRowRunningStatus'), value: presentation.status },
    ] as const;

    return (
        <View
            accessibilityLiveRegion="polite"
            style={styles.detailsCard}
            testID="session-row-details"
        >
            <Text numberOfLines={2} style={styles.detailsTitle}>{presentation.title}</Text>
            {details.map((detail) => (
                <View key={detail.label} style={styles.detailRow}>
                    <Ionicons color={theme.colors.textSecondary} name={detail.icon} size={14} />
                    <Text style={styles.detailLabel}>{detail.label}</Text>
                    <Text numberOfLines={1} style={styles.detailValue}>{detail.value}</Text>
                </View>
            ))}
        </View>
    );
});

export const SessionRowActions = React.memo(function SessionRowActions({
    contextAnchor,
    onContextAnchorChange,
    onStartSelection,
    sessionId,
    visible,
}: {
    contextAnchor: SessionActionsAnchor | null;
    onContextAnchorChange: (anchor: SessionActionsAnchor | null) => void;
    onStartSelection?: () => void;
    sessionId: string;
    visible: boolean;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { width: viewportWidth } = useWindowDimensions();
    const canHover = useWebHoverCapability();
    const session = useSession(sessionId);
    const quickActions = useSessionQuickActions(session!);
    const sessionArchived = session ? isSessionArchived(session) : false;
    const useMoreAction = shouldUseSessionRowMoreAction(Platform.OS, viewportWidth, canHover);
    const showInline = !useMoreAction && visible;
    const actionClusterRef = React.useRef<any>(null);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !useMoreAction || !contextAnchor || typeof document === 'undefined') {
            return;
        }

        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (!actionClusterRef.current?.contains?.(event.target)) {
                onContextAnchorChange(null);
            }
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onContextAnchorChange(null);
            }
        };
        document.addEventListener('pointerdown', closeOnOutsidePointer, true);
        document.addEventListener('keydown', closeOnEscape, true);
        return () => {
            document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
            document.removeEventListener('keydown', closeOnEscape, true);
        };
    }, [contextAnchor, onContextAnchorChange, useMoreAction]);

    if (!session) return null;

    const handleAction = (callback: () => void) => (event: any) => {
        stopSessionRowActionPropagation(event);
        callback();
    };
    const openMenu = (event: any) => {
        stopSessionRowActionPropagation(event);
        onContextAnchorChange(contextAnchor ? null : anchorFromEvent(event));
    };

    return (
        <View ref={actionClusterRef} style={styles.actionCluster}>
            <View style={styles.actions} testID={`session-row-actions-${sessionId}`}>
                {showInline ? (
                    <>
                        <Pressable
                            accessibilityLabel={quickActions.sessionPinned ? t('sessionInfo.unpinSession') : t('sessionInfo.pinSession')}
                            accessibilityRole="button"
                            onPress={handleAction(quickActions.togglePinSession)}
                            style={styles.actionButton}
                            testID="session-row-pin-action"
                        >
                            <Ionicons
                                color={theme.colors.textSecondary}
                                name={quickActions.sessionPinned ? 'pin' : 'pin-outline'}
                                size={18}
                            />
                        </Pressable>
                        <Pressable
                            accessibilityLabel={sessionArchived ? t('sessionInfo.restoreSession') : t('sessionInfo.archiveSession')}
                            accessibilityRole="button"
                            disabled={quickActions.archivingSession || quickActions.restoringSession}
                            onPress={handleAction(sessionArchived ? quickActions.restoreSession : quickActions.archiveSession)}
                            style={styles.actionButton}
                            testID={sessionArchived ? 'session-row-restore-action' : 'session-row-archive-action'}
                        >
                            <Ionicons
                                color={theme.colors.textSecondary}
                                name={sessionArchived ? 'arrow-undo-outline' : 'archive-outline'}
                                size={18}
                            />
                        </Pressable>
                    </>
                ) : null}
                {useMoreAction ? (
                    <Pressable
                        accessibilityLabel={t('sessionInfo.sessionRowMoreActions')}
                        accessibilityRole="button"
                        onPress={openMenu}
                        style={styles.actionButton}
                        testID="session-row-more-action"
                    >
                        <Ionicons color={theme.colors.textSecondary} name="ellipsis-horizontal" size={20} />
                    </Pressable>
                ) : null}
            </View>
            <SessionActionsPopover
                anchor={contextAnchor}
                inline={Platform.OS === 'web' && useMoreAction}
                onClose={() => onContextAnchorChange(null)}
                onSelectSession={onStartSelection}
                sessionId={sessionId}
                visible={!!contextAnchor}
            />
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    locationRow: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 4,
        minWidth: 0,
    },
    locationText: {
        color: theme.colors.textSecondary,
        flexShrink: 1,
        fontSize: 11,
        lineHeight: 15,
        ...Typography.default(),
    },
    detailsCard: {
        backgroundColor: theme.colors.header.background,
        borderColor: theme.colors.divider,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        elevation: 12,
        left: 12,
        padding: 12,
        position: 'absolute',
        right: 12,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 16,
        top: '100%',
        zIndex: 50,
    },
    detailsTitle: {
        color: theme.colors.text,
        fontSize: 13,
        lineHeight: 18,
        marginBottom: 8,
        ...Typography.default('semiBold'),
    },
    detailRow: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 6,
        minHeight: 22,
    },
    detailLabel: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        width: 72,
        ...Typography.default(),
    },
    detailValue: {
        color: theme.colors.text,
        flex: 1,
        fontSize: 11,
        ...Typography.default(),
    },
    actions: {
        alignItems: 'center',
        flexDirection: 'row',
        marginLeft: 4,
    },
    actionCluster: {
        position: 'relative',
        zIndex: 60,
    },
    actionButton: {
        alignItems: 'center',
        height: 40,
        justifyContent: 'center',
        width: 40,
    },
}));
