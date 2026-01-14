import React from 'react';
import { View, Pressable, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { ItemActionsMenuModal, type ItemAction } from '@/components/ItemActionsMenuModal';

export interface ItemRowActionsProps {
    title: string;
    actions: ItemAction[];
    compactThreshold?: number;
    compactActionIds?: string[];
    iconSize?: number;
    gap?: number;
    onActionPressIn?: () => void;
}

export function ItemRowActions(props: ItemRowActionsProps) {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const compact = width < (props.compactThreshold ?? 420);

    const compactIds = React.useMemo(() => new Set(props.compactActionIds ?? []), [props.compactActionIds]);
    const inlineActions = React.useMemo(() => {
        if (!compact) return props.actions;
        return props.actions.filter((a) => compactIds.has(a.id));
    }, [compact, compactIds, props.actions]);
    const overflowActions = React.useMemo(() => {
        if (!compact) return [];
        return props.actions.filter((a) => !compactIds.has(a.id));
    }, [compact, compactIds, props.actions]);

    const openMenu = React.useCallback(() => {
        if (overflowActions.length === 0) return;
        Modal.show({
            component: ItemActionsMenuModal,
            props: {
                title: props.title,
                actions: overflowActions,
            },
        } as any);
    }, [overflowActions, props.title]);

    const iconSize = props.iconSize ?? 20;
    const gap = props.gap ?? 16;

    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap }}>
            {inlineActions.map((action) => (
                <Pressable
                    key={action.id}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    onPressIn={() => props.onActionPressIn?.()}
                    onPress={(e: any) => {
                        e?.stopPropagation?.();
                        action.onPress();
                    }}
                >
                    <Ionicons
                        name={action.icon}
                        size={iconSize}
                        color={action.color ?? (action.destructive ? theme.colors.deleteAction : theme.colors.button.secondary.tint)}
                    />
                </Pressable>
            ))}

            {compact && overflowActions.length > 0 && (
                <Pressable
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    onPressIn={() => props.onActionPressIn?.()}
                    onPress={(e: any) => {
                        e?.stopPropagation?.();
                        openMenu();
                    }}
                >
                    <Ionicons
                        name="ellipsis-vertical"
                        size={iconSize + 2}
                        color={theme.colors.button.secondary.tint}
                    />
                </Pressable>
            )}
        </View>
    );
}
