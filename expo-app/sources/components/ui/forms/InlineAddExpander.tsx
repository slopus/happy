import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { StyleProp, ViewStyle } from 'react-native';

import { Item } from '@/components/ui/lists/Item';
import { Typography } from '@/constants/Typography';

export interface InlineAddExpanderProps {
    isOpen: boolean;
    onOpenChange: (isOpen: boolean) => void;

    title: string;
    subtitle?: string;
    icon?: React.ReactNode;

    helpText?: string;
    children: React.ReactNode;

    onCancel: () => void;
    onSave: () => void;
    saveDisabled?: boolean;

    cancelLabel: string;
    saveLabel: string;

    autoFocusRef?: React.RefObject<TextInput | null>;
    expandedContainerStyle?: StyleProp<ViewStyle>;
}

export function InlineAddExpander({
    isOpen,
    onOpenChange,
    title,
    subtitle,
    icon,
    helpText,
    children,
    onCancel,
    onSave,
    saveDisabled = false,
    cancelLabel,
    saveLabel,
    autoFocusRef,
    expandedContainerStyle,
}: InlineAddExpanderProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    React.useEffect(() => {
        if (!isOpen) return;
        if (!autoFocusRef?.current) return;
        const id = setTimeout(() => autoFocusRef.current?.focus(), 30);
        return () => clearTimeout(id);
    }, [autoFocusRef, isOpen]);

    return (
        <>
            <Item
                title={title}
                subtitle={subtitle}
                icon={icon}
                onPress={() => onOpenChange(!isOpen)}
                showChevron={false}
                showDivider={Boolean(isOpen)}
            />

            {isOpen ? (
                <View style={[styles.expandedContainer, expandedContainerStyle]}>
                    {helpText ? (
                        <Text style={styles.helpText}>
                            {helpText}
                        </Text>
                    ) : null}

                    {children}

                    <View style={{ height: 16 }} />

                    <View style={styles.actionsRow}>
                        <View style={{ flex: 1 }}>
                            <Pressable
                                onPress={onCancel}
                                accessibilityRole="button"
                                accessibilityLabel={cancelLabel}
                                style={({ pressed }) => ({
                                    backgroundColor: theme.colors.surface,
                                    borderRadius: 10,
                                    paddingVertical: 12,
                                    alignItems: 'center',
                                    opacity: pressed ? 0.85 : 1,
                                })}
                            >
                                <Text style={{ color: theme.colors.text, ...Typography.default('semiBold') }}>
                                    {cancelLabel}
                                </Text>
                            </Pressable>
                        </View>

                        <View style={{ flex: 1 }}>
                            <Pressable
                                onPress={onSave}
                                disabled={saveDisabled}
                                accessibilityRole="button"
                                accessibilityLabel={saveLabel}
                                style={({ pressed }) => ({
                                    backgroundColor: theme.colors.button.primary.background,
                                    borderRadius: 10,
                                    paddingVertical: 12,
                                    alignItems: 'center',
                                    opacity: saveDisabled ? 0.5 : (pressed ? 0.85 : 1),
                                })}
                            >
                                <Text style={{ color: theme.colors.button.primary.tint, ...Typography.default('semiBold') }}>
                                    {saveLabel}
                                </Text>
                            </Pressable>
                        </View>
                    </View>
                </View>
            ) : null}
        </>
    );
}


const stylesheet = StyleSheet.create((theme) => ({
    expandedContainer: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 16,
    },
    helpText: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        lineHeight: 20,
        marginBottom: 12,
        ...Typography.default(),
    },
    actionsRow: {
        flexDirection: 'row',
        gap: 12,
    },
}));
