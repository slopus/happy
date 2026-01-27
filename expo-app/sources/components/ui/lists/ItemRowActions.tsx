import React from 'react';
import { View, Pressable, useWindowDimensions, type GestureResponderEvent, InteractionManager, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Color from 'color';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { type ItemAction } from '@/components/ui/lists/itemActions';
import { Popover } from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/FloatingOverlay';
import { ActionListSection, type ActionListItem } from '@/components/ui/lists/ActionListSection';

export interface ItemRowActionsProps {
    title: string;
    actions: ItemAction[];
    compactThreshold?: number;
    compactActionIds?: string[];
    /**
     * Action IDs that should remain visible on compact layouts and be rendered
     * at the far right of the row.
     */
    pinnedActionIds?: string[];
    /**
     * Where to render the overflow (ellipsis) trigger on compact layouts.
     * - 'end': after all inline actions (default)
     * - 'beforePinned': between inline actions and pinned actions
     */
    overflowPosition?: 'end' | 'beforePinned';
    iconSize?: number;
    gap?: number;
    onActionPressIn?: () => void;
    /**
     * Optional explicit boundary ref for the popover. Useful when the row is rendered
     * inside a scroll container that should bound the popover sizing/placement.
     * If omitted, the PopoverBoundaryProvider context (e.g. ItemGroup) is used.
     */
    popoverBoundaryRef?: React.RefObject<any> | null;
}

export function ItemRowActions(props: ItemRowActionsProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { width } = useWindowDimensions();
    const compact = width < (props.compactThreshold ?? 450);
    const [showOverflow, setShowOverflow] = React.useState(false);
    const overflowAnchorRef = React.useRef<View>(null);

    const blurTintOnWeb = React.useMemo(() => {
        try {
            const alpha = theme.dark ? 0.20 : 0.25;
            return Color(theme.colors.surface).alpha(alpha).rgb().string();
        } catch {
            return theme.dark ? 'rgba(0, 0, 0, 0.20)' : 'rgba(255, 255, 255, 0.25)';
        }
    }, [theme.colors.surface, theme.dark]);

    const compactIds = React.useMemo(() => new Set(props.compactActionIds ?? []), [props.compactActionIds]);
    const pinnedIds = React.useMemo(() => new Set(props.pinnedActionIds ?? []), [props.pinnedActionIds]);
    const overflowPosition = props.overflowPosition ?? 'end';

    const inlineActions = React.useMemo(() => {
        if (!compact) return props.actions;
        return props.actions.filter((a) => compactIds.has(a.id));
    }, [compact, compactIds, props.actions]);

    const pinnedActions = React.useMemo(() => {
        if (!compact) return [] as ItemAction[];
        return inlineActions.filter((a) => pinnedIds.has(a.id));
    }, [compact, inlineActions, pinnedIds]);

    const nonPinnedInlineActions = React.useMemo(() => {
        if (!compact) return inlineActions;
        return inlineActions.filter((a) => !pinnedIds.has(a.id));
    }, [compact, inlineActions, pinnedIds]);
    const overflowActions = React.useMemo(() => {
        if (!compact) return [];
        return props.actions.filter((a) => !compactIds.has(a.id));
    }, [compact, compactIds, props.actions]);

    const closeThen = React.useCallback((fn: () => void) => {
        setShowOverflow(false);
        let didRun = false;
        const runOnce = () => {
            if (didRun) return;
            didRun = true;
            fn();
        };

        // InteractionManager can be delayed by long/continuous interactions (scroll, gestures).
        // Use a fast timeout fallback so the action still runs promptly.
        const fallback = setTimeout(runOnce, 0);
        try {
            InteractionManager.runAfterInteractions(() => {
                clearTimeout(fallback);
                runOnce();
            });
        } catch {
            // If InteractionManager isn't available, rely on the fallback.
        }
    }, []);

    const overflowActionItems = React.useMemo((): ActionListItem[] => {
        return overflowActions.map((action) => {
            const color = action.color ?? (action.destructive ? theme.colors.deleteAction : theme.colors.button.secondary.tint);
            return {
                id: action.id,
                label: action.title,
                icon: <Ionicons name={action.icon} size={18} color={color} />,
                onPress: () => closeThen(action.onPress),
            };
        });
    }, [closeThen, overflowActions, theme.colors.button.secondary.tint, theme.colors.deleteAction]);

    const iconSize = props.iconSize ?? 20;
    const gap = props.gap ?? 16;

    const renderInlineAction = React.useCallback((action: ItemAction) => {
        return (
            <Pressable
                key={action.id}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                onPressIn={() => props.onActionPressIn?.()}
                onPress={(e: GestureResponderEvent) => {
                    e?.stopPropagation?.();
                    action.onPress();
                }}
                accessibilityRole="button"
                accessibilityLabel={action.title}
            >
                <Ionicons
                    name={action.icon}
                    size={iconSize}
                    color={action.color ?? (action.destructive ? theme.colors.deleteAction : theme.colors.button.secondary.tint)}
                />
            </Pressable>
        );
    }, [iconSize, props, theme.colors.button.secondary.tint, theme.colors.deleteAction]);

    const renderOverflow = React.useCallback(() => {
        return (
            <View key="overflow" style={{ position: 'relative' }}>
                <View ref={overflowAnchorRef}>
                    <Pressable
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        style={showOverflow ? { opacity: 0 } : undefined}
                        onPressIn={() => props.onActionPressIn?.()}
                        onPress={(e: GestureResponderEvent) => {
                            e?.stopPropagation?.();
                            setShowOverflow((v) => !v);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="More actions"
                        accessibilityHint="Opens a menu with more actions"
                    >
                        <Ionicons
                            name="ellipsis-vertical"
                            size={iconSize + 2}
                            color={theme.colors.button.secondary.tint}
                        />
                    </Pressable>
                </View>

                {showOverflow ? (
                    <Popover
                        open={showOverflow}
                        anchorRef={overflowAnchorRef}
                        placement="left"
                        gap={10}
                        maxHeightCap={280}
                        maxWidthCap={260}
                        edgePadding={{ vertical: 8, horizontal: 8 }}
                        portal={{
                            web: true,
                            native: true,
                            // Menus are typically content-sized; allow the overlay to be wider than the trigger.
                            matchAnchorWidth: false,
                            anchorAlignVertical: 'center',
                        }}
                        boundaryRef={props.popoverBoundaryRef}
                        onRequestClose={() => setShowOverflow(false)}
                        backdrop={{
                            effect: 'blur',
                            blurOnWeb: Platform.OS === 'web' ? { px: 3, tintColor: blurTintOnWeb } : undefined,
                            anchorOverlay: () => (
                                <Ionicons
                                    name="ellipsis-vertical"
                                    size={iconSize + 2}
                                    color={theme.colors.button.secondary.tint}
                                />
                            ),
                            closeOnPan: true,
                        }}
                    >
                        {({ maxHeight, placement }) => (
                            <FloatingOverlay
                                maxHeight={maxHeight}
                                arrow={{ placement }}
                                keyboardShouldPersistTaps="always"
                                edgeFades={{ top: true, bottom: true, size: 24 }}
                                edgeIndicators={true}
                            >
                                <ActionListSection
                                    title={props.title}
                                    actions={overflowActionItems}
                                />
                            </FloatingOverlay>
                        )}
                    </Popover>
                ) : null}
            </View>
        );
    }, [iconSize, overflowActionItems, props, showOverflow, theme.colors.button.secondary.tint]);

    return (
        <View style={[styles.container, { gap }]}>
            {(compact ? nonPinnedInlineActions : inlineActions).map(renderInlineAction)}

            {compact && overflowActions.length > 0 && overflowPosition === 'beforePinned' ? (
                <>
                    {renderOverflow()}
                    {pinnedActions.map(renderInlineAction)}
                </>
            ) : null}

            {compact && overflowActions.length > 0 && overflowPosition === 'end' ? (
                <>
                    {pinnedActions.map(renderInlineAction)}
                    {renderOverflow()}
                </>
            ) : null}

            {compact && overflowActions.length === 0 && pinnedActions.length > 0 ? (
                <>
                    {pinnedActions.map(renderInlineAction)}
                </>
            ) : null}
        </View>
    );
}

const stylesheet = StyleSheet.create(() => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
    },
}));
