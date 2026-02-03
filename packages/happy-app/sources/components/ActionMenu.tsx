/**
 * ActionMenu Component
 *
 * A simple vertical action menu that can be shown via Modal.show()
 * Used as an alternative to ActionSheetIOS for Android and Web platforms.
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export interface ActionMenuItem {
    label: string;
    onPress: () => void;
    destructive?: boolean;
}

interface ActionMenuProps {
    items: ActionMenuItem[];
    onClose: () => void;
}

const styles = StyleSheet.create((theme) => ({
    wrapper: {
        width: '100%',
        maxWidth: 400,
        paddingHorizontal: 8,
    },
    container: {
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        overflow: 'hidden',
    },
    item: {
        paddingVertical: 16,
        paddingHorizontal: 20,
        alignItems: 'center',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    itemLast: {
        borderBottomWidth: 0,
    },
    itemText: {
        fontSize: 17,
        color: theme.colors.textLink,
        ...Typography.default(),
    },
    itemTextDestructive: {
        color: theme.colors.textDestructive,
    },
    cancelContainer: {
        marginTop: 8,
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        overflow: 'hidden',
    },
    cancelItem: {
        paddingVertical: 16,
        paddingHorizontal: 20,
        alignItems: 'center',
    },
    cancelText: {
        fontSize: 17,
        color: theme.colors.textLink,
        ...Typography.default('semiBold'),
    },
}));

export function ActionMenu({ items, onClose }: ActionMenuProps) {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();

    const handleItemPress = (item: ActionMenuItem) => {
        onClose();
        // Delay the action to allow the modal to close first
        setTimeout(() => {
            item.onPress();
        }, 100);
    };

    return (
        <View style={[styles.wrapper, { paddingBottom: safeArea.bottom + 8 }]}>
            <View style={styles.container}>
                {items.map((item, index) => (
                    <Pressable
                        key={index}
                        style={({ pressed }) => [
                            styles.item,
                            index === items.length - 1 && styles.itemLast,
                            pressed && { backgroundColor: theme.colors.surfacePressed },
                        ]}
                        onPress={() => handleItemPress(item)}
                    >
                        <Text
                            style={[
                                styles.itemText,
                                item.destructive && styles.itemTextDestructive,
                            ]}
                        >
                            {item.label}
                        </Text>
                    </Pressable>
                ))}
            </View>
            <View style={styles.cancelContainer}>
                <Pressable
                    style={({ pressed }) => [
                        styles.cancelItem,
                        pressed && { backgroundColor: theme.colors.surfacePressed },
                    ]}
                    onPress={onClose}
                >
                    <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                </Pressable>
            </View>
        </View>
    );
}
