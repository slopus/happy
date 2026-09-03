import * as React from 'react';
import { Platform, Pressable, View, useWindowDimensions, type PressableProps } from 'react-native';
import { createPortal } from 'react-dom';
import { Feather, Octicons } from '@expo/vector-icons';
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
import { DesktopShortcutTooltip } from '@/components/DesktopShortcutTooltip';

const INITIAL_INTERACTION = { focused: false, hovered: false };
const DETAILS_CARD_GAP = 16;

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
    const [detailsAnchor, setDetailsAnchor] = React.useState<Extract<SessionActionsAnchor, { type: 'rect' }> | null>(null);
    const [titleOverflowing, setTitleOverflowing] = React.useState(false);
    const wrapperRef = React.useRef<any>(null);
    const { width: viewportWidth } = useWindowDimensions();
    const visible = shouldShowSessionRowDisclosure(Platform.OS, viewportWidth, interaction);

    const refreshTitleOverflow = React.useCallback((root?: any) => {
        const node = (root ?? wrapperRef.current)?.querySelector?.('[data-testid="session-row-title"]');
        const content = node?.querySelector?.('[data-testid="session-row-title-text"]');
        const overflowing = isSessionTitleOverflowing(node ? {
            clientWidth: node.clientWidth ?? 0,
            scrollWidth: Math.max(node.scrollWidth ?? 0, content?.scrollWidth ?? 0),
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
            const rect = event.currentTarget?.getBoundingClientRect?.();
            if (rect) {
                setDetailsAnchor({ type: 'rect', x: rect.left, y: rect.top, width: rect.width, height: rect.height });
            }
            dispatch('mouse-enter');
        },
        onMouseLeave: () => {
            setDetailsAnchor(null);
            dispatch('mouse-leave');
        },
        onFocus: (event: any) => {
            refreshTitleOverflow(event.currentTarget);
            const rect = event.currentTarget?.getBoundingClientRect?.();
            if (rect) {
                setDetailsAnchor({ type: 'rect', x: rect.left, y: rect.top, width: rect.width, height: rect.height });
            }
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
                setDetailsAnchor(null);
                dispatch('escape');
            }
        },
    }) : {}, [refreshTitleOverflow]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !visible || typeof document === 'undefined') return;
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            setDetailsAnchor(null);
            dispatch('escape');
        };
        document.addEventListener('keydown', closeOnEscape, true);
        return () => document.removeEventListener('keydown', closeOnEscape, true);
    }, [visible]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !visible || typeof requestAnimationFrame === 'undefined') return;
        const frame = requestAnimationFrame(() => refreshTitleOverflow());
        return () => cancelAnimationFrame(frame);
    }, [refreshTitleOverflow, visible]);

    return {
        detailsAnchor,
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
        disconnected: t('status.disconnected'),
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
            <Feather
                color={theme.colors.textSecondary}
                name={presentation.location.icon}
                size={14}
            />
            <Text numberOfLines={1} style={styles.locationText}>
                {presentation.location.text}
            </Text>
        </View>
    );
});

export const SessionRowDetails = React.memo(function SessionRowDetails({
    anchor,
    presentation,
    visible,
}: {
    anchor: Extract<SessionActionsAnchor, { type: 'rect' }> | null;
    presentation: SessionRowPresentation;
    visible: boolean;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { height: viewportHeight, width: viewportWidth } = useWindowDimensions();
    if (!visible || !anchor) return null;

    const projectName = (presentation.path || presentation.project)
        .split(/[/\\]/)
        .filter(Boolean)
        .pop() || presentation.project;
    const details = [
        { icon: 'folder', value: projectName, strong: true },
        { icon: 'git-branch', value: presentation.project || presentation.path, strong: false },
        { icon: 'check-square', value: presentation.status, strong: false },
        { icon: 'monitor', value: `${presentation.machine} · ${presentation.agent}`, strong: false },
    ] as const;

    const cardWidth = 340;
    const estimatedHeight = 150;
    const left = Math.min(viewportWidth - cardWidth - 12, anchor.x + anchor.width + DETAILS_CARD_GAP);
    const top = Math.max(12, Math.min(viewportHeight - estimatedHeight - 12, anchor.y - 4));

    const card = (
        <View
            accessibilityLiveRegion="polite"
            pointerEvents="none"
            style={[styles.detailsCard, { left, top, position: 'fixed' as any }]}
            testID="session-row-details"
        >
            <View style={styles.detailsHeader}>
                <Text numberOfLines={1} style={styles.detailsTitle}>{presentation.title}</Text>
                <Text numberOfLines={1} style={styles.detailsTime}>
                    {presentation.relativeTime || t('status.unknown')}
                </Text>
            </View>
            {details.map((detail) => (
                <View key={`${detail.icon}-${detail.value}`} style={styles.detailRow}>
                    <View style={styles.detailIconSlot}>
                        <Feather color={theme.colors.textSecondary} name={detail.icon} size={15} />
                    </View>
                    <Text
                        numberOfLines={1}
                        style={[styles.detailValue, detail.strong && styles.detailValueStrong]}
                    >
                        {detail.value}
                    </Text>
                </View>
            ))}
        </View>
    );

    return Platform.OS === 'web' && typeof document !== 'undefined'
        ? createPortal(card, document.body)
        : null;
});

export const SessionRowActions = React.memo(function SessionRowActions({
    contextAnchor,
    forceMoreAction = false,
    onContextAnchorChange,
    onOrganize,
    onStartSelection,
    sessionId,
    statusLabel,
    visible,
}: {
    contextAnchor: SessionActionsAnchor | null;
    forceMoreAction?: boolean;
    onContextAnchorChange: (anchor: SessionActionsAnchor | null) => void;
    onOrganize?: () => void;
    onStartSelection?: () => void;
    sessionId: string;
    statusLabel: string;
    visible: boolean;
}) {
    const styles = stylesheet;
    const { width: viewportWidth } = useWindowDimensions();
    const canHover = useWebHoverCapability();
    const session = useSession(sessionId);
    const quickActions = useSessionQuickActions(session!);
    const sessionArchived = session ? isSessionArchived(session) : false;
    const useMoreAction = forceMoreAction || shouldUseSessionRowMoreAction(Platform.OS, viewportWidth, canHover);
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
                {onOrganize ? (
                    <SessionRowActionButton
                        icon="tag"
                        label={t('sidebarLists.organizeSession')}
                        onPress={handleAction(onOrganize)}
                        testID={`organize-session-${sessionId}`}
                    />
                ) : null}
                {showInline ? (
                    <>
                        <Text numberOfLines={1} style={styles.actionStatus} testID="session-row-hover-status">
                            {statusLabel}
                        </Text>
                        <SessionRowActionButton
                            active={quickActions.sessionPinned}
                            icon="pin"
                            label={quickActions.sessionPinned ? t('sessionInfo.unpinSession') : t('sessionInfo.pinSession')}
                            onPress={handleAction(quickActions.togglePinSession)}
                            testID="session-row-pin-action"
                        />
                        <SessionRowActionButton
                            disabled={quickActions.deletingSession}
                            icon="trash"
                            label={t('sessionInfo.deleteSession')}
                            onPress={handleAction(quickActions.deleteSession)}
                            testID="session-row-delete-action"
                        />
                        <SessionRowActionButton
                            disabled={quickActions.archivingSession || quickActions.restoringSession}
                            icon={sessionArchived ? 'undo' : 'archive'}
                            label={sessionArchived ? t('sessionInfo.restoreSession') : t('sessionInfo.archiveSession')}
                            onPress={handleAction(sessionArchived ? quickActions.restoreSession : quickActions.archiveSession)}
                            testID={sessionArchived ? 'session-row-restore-action' : 'session-row-archive-action'}
                        />
                    </>
                ) : null}
                {useMoreAction ? (
                    <SessionRowActionButton
                        icon="kebab-horizontal"
                        label={t('sessionInfo.sessionRowMoreActions')}
                        onPress={openMenu}
                        testID="session-row-more-action"
                    />
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

const SessionRowActionButton = React.memo(function SessionRowActionButton({
    active = false,
    disabled = false,
    icon,
    label,
    onPress,
    testID,
}: {
    active?: boolean;
    disabled?: boolean;
    icon: React.ComponentProps<typeof Octicons>['name'];
    label: string;
    onPress: NonNullable<PressableProps['onPress']>;
    testID: string;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [tooltipVisible, setTooltipVisible] = React.useState(false);

    return (
        <View style={styles.actionButtonWrapper}>
            <Pressable
                accessibilityLabel={label}
                accessibilityRole="button"
                accessibilityState={{ disabled, selected: active }}
                disabled={disabled}
                onBlur={() => setTooltipVisible(false)}
                onFocus={() => setTooltipVisible(true)}
                onHoverIn={() => setTooltipVisible(true)}
                onHoverOut={() => setTooltipVisible(false)}
                onPress={onPress}
                style={({ pressed }) => [
                    styles.actionButton,
                    (active || tooltipVisible) && styles.actionButtonHighlighted,
                    pressed && styles.actionButtonPressed,
                    disabled && styles.actionButtonDisabled,
                ]}
                testID={testID}
            >
                <Octicons
                    color={active ? theme.colors.accent : theme.colors.textSecondary}
                    dataSet={{ iconName: icon }}
                    name={icon}
                    size={17}
                    testID={`${testID}-icon`}
                />
            </Pressable>
            <DesktopShortcutTooltip
                align="right"
                compact
                label={label}
                placement="above"
                testID={`${testID}-tooltip`}
                visible={Platform.OS === 'web' && tooltipVisible}
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
        fontSize: 12,
        lineHeight: 16,
        ...Typography.default(),
    },
    detailsCard: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 16,
        elevation: 18,
        paddingHorizontal: 16,
        paddingVertical: 14,
        position: 'absolute',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 12 },
        shadowOpacity: Platform.OS === 'web' ? 0.34 : theme.colors.shadow.opacity,
        shadowRadius: 28,
        width: 340,
        zIndex: 80,
    },
    detailsHeader: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 12,
        marginBottom: 10,
    },
    detailsTitle: {
        color: theme.colors.text,
        flex: 1,
        fontSize: 14,
        lineHeight: 20,
        ...Typography.default('semiBold'),
    },
    detailsTime: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 18,
        ...Typography.default(),
    },
    detailRow: {
        alignItems: 'center',
        flexDirection: 'row',
        minHeight: 24,
    },
    detailIconSlot: {
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 8,
        width: 18,
    },
    detailValue: {
        color: theme.colors.text,
        flex: 1,
        fontSize: 13,
        lineHeight: 20,
        ...Typography.default(),
    },
    detailValueStrong: {
        ...Typography.default('semiBold'),
    },
    actions: {
        alignItems: 'center',
        flexDirection: 'row',
        flexShrink: 0,
        gap: 2,
        marginLeft: 4,
    },
    actionStatus: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 18,
        marginHorizontal: 4,
        maxWidth: 70,
        ...Typography.default(),
    },
    actionCluster: {
        flexShrink: 0,
        position: 'relative',
        zIndex: 60,
    },
    actionButtonWrapper: {
        position: 'relative',
    },
    actionButton: {
        alignItems: 'center',
        borderRadius: 8,
        height: 30,
        justifyContent: 'center',
        width: 30,
    },
    actionButtonHighlighted: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    actionButtonPressed: {
        opacity: 0.72,
    },
    actionButtonDisabled: {
        opacity: 0.45,
    },
}));
