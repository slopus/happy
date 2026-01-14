import React from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';

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

export function ItemActionsMenuModal(props: ItemActionsMenuModalProps) {
    const { theme } = useUnistyles();

    const closeThen = React.useCallback((fn: () => void) => {
        props.onClose();
        setTimeout(() => fn(), 0);
    }, [props]);

    return (
        <View style={{
            width: '92%',
            maxWidth: 420,
            backgroundColor: theme.colors.groupped.background,
            borderRadius: 16,
            overflow: 'hidden',
            borderWidth: 1,
            borderColor: theme.colors.divider,
        }}>
            <View style={{
                paddingHorizontal: 16,
                paddingVertical: 12,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.divider,
            }}>
                <Text style={{
                    fontSize: 17,
                    color: theme.colors.text,
                    ...Typography.default('semiBold'),
                }}>
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

            <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingBottom: 12 }}>
                <ItemGroup title="Actions">
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
