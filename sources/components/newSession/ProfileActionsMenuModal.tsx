import React from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';

export interface ProfileActionsMenuModalProps {
    profileName: string;
    isFavorite: boolean;
    hasEnvVars: boolean;
    canDelete: boolean;
    onToggleFavorite: () => void;
    onViewEnvVars?: () => void;
    onEdit: () => void;
    onCopy: () => void;
    onDelete?: () => void;
    onClose: () => void;
}

export function ProfileActionsMenuModal(props: ProfileActionsMenuModalProps) {
    const { theme } = useUnistyles();

    const closeThen = React.useCallback((fn?: () => void) => {
        props.onClose();
        if (!fn) return;
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
                    {props.profileName}
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
                    {props.hasEnvVars && props.onViewEnvVars && (
                        <Item
                            title="View environment variables"
                            leftElement={<Ionicons name="list-outline" size={18} color={theme.colors.textSecondary} />}
                            onPress={() => closeThen(props.onViewEnvVars)}
                            showChevron={false}
                        />
                    )}
                    <Item
                        title={props.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                        leftElement={
                            <Ionicons
                                name={props.isFavorite ? 'star' : 'star-outline'}
                                size={18}
                                color={props.isFavorite ? theme.colors.button.primary.background : theme.colors.textSecondary}
                            />
                        }
                        onPress={() => closeThen(props.onToggleFavorite)}
                        showChevron={false}
                    />
                    <Item
                        title="Edit profile"
                        leftElement={<Ionicons name="create-outline" size={18} color={theme.colors.textSecondary} />}
                        onPress={() => closeThen(props.onEdit)}
                        showChevron={false}
                    />
                    <Item
                        title="Duplicate profile"
                        leftElement={<Ionicons name="copy-outline" size={18} color={theme.colors.textSecondary} />}
                        onPress={() => closeThen(props.onCopy)}
                        showChevron={false}
                    />
                    {props.canDelete && props.onDelete && (
                        <Item
                            title="Delete profile"
                            destructive
                            leftElement={<Ionicons name="trash-outline" size={18} color={theme.colors.textDestructive} />}
                            onPress={() => closeThen(props.onDelete)}
                            showChevron={false}
                        />
                    )}
                </ItemGroup>
            </ScrollView>
        </View>
    );
}

