import React from 'react';
import { View, Text, ScrollView, Pressable, InteractionManager } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { t } from '@/text';

export type ItemAction = {
    id: string;
    title: string;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    onPress: () => void;
    destructive?: boolean;
    color?: string;
};

export interface ItemActionsMenuModalProps {
    title: string;
    actions: ItemAction[];
    onClose: () => void;
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '92%',
        maxWidth: 420,
        backgroundColor: theme.colors.groupped.background,
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    header: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    headerTitle: {
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    scroll: {
        flexGrow: 0,
    },
    scrollContent: {
        paddingBottom: 12,
    },
}));

export function ItemActionsMenuModal(props: ItemActionsMenuModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const closeThen = React.useCallback((fn: () => void) => {
        props.onClose();
        // On iOS, navigation actions fired immediately after closing an overlay modal
        // can be dropped or feel flaky. Run after interactions/animations settle.
        InteractionManager.runAfterInteractions(() => {
            fn();
        });
    }, [props.onClose]);

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerTitle}>
                    {props.title}
                </Text>

                <Pressable
                    onPress={props.onClose}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                >
                    <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
                <ItemGroup title={t('common.actions')}>
                    {props.actions.map((action, idx) => (
                        <Item
                            key={action.id}
                            title={action.title}
                            destructive={action.destructive}
                            leftElement={
                                <Ionicons
                                    name={action.icon}
                                    size={18}
                                    color={action.color ?? (action.destructive ? theme.colors.textDestructive : theme.colors.textSecondary)}
                                />
                            }
                            onPress={() => closeThen(action.onPress)}
                            showChevron={false}
                            showDivider={idx < props.actions.length - 1}
                        />
                    ))}
                </ItemGroup>
            </ScrollView>
        </View>
    );
}
