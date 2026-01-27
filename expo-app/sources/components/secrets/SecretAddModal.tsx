import React from 'react';
import { View, Text, TextInput, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { ItemListStatic } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';

export interface SecretAddModalResult {
    name: string;
    value: string;
}

export interface SecretAddModalProps {
    onClose: () => void;
    onSubmit: (result: SecretAddModalResult) => void;
    title?: string;
}

export function SecretAddModal(props: SecretAddModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const [name, setName] = React.useState('');
    const [value, setValue] = React.useState('');

    const submit = React.useCallback(() => {
        const trimmedName = name.trim();
        const trimmedValue = value.trim();
        if (!trimmedName) return;
        if (!trimmedValue) return;
        props.onSubmit({ name: trimmedName, value: trimmedValue });
        props.onClose();
    }, [name, props, value]);

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerTitle}>{props.title ?? t('secrets.addTitle')}</Text>
                <Pressable
                    onPress={props.onClose}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                >
                    <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            <View style={styles.body}>
                <Text style={styles.helpText}>
                    {t('settings.secretsSubtitle')}
                </Text>

                <ItemListStatic style={{ backgroundColor: 'transparent' }}>
                    <ItemGroup title={t('secrets.addTitle')} containerStyle={{ marginHorizontal: 0 }}>
                        <View style={styles.inputContainer}>
                            <Text style={styles.fieldLabel}>{t('secrets.fields.name')}</Text>
                            <TextInput
                                style={styles.textInput}
                                placeholder={t('secrets.placeholders.nameExample')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                value={name}
                                onChangeText={setName}
                                autoCapitalize="none"
                                autoCorrect={false}
                            />

                            <View style={{ height: 12 }} />

                            <Text style={styles.fieldLabel}>{t('secrets.fields.value')}</Text>
                            <TextInput
                                style={styles.textInput}
                                placeholder="sk-..."
                                placeholderTextColor={theme.colors.input.placeholder}
                                value={value}
                                onChangeText={setValue}
                                autoCapitalize="none"
                                autoCorrect={false}
                                secureTextEntry
                                textContentType={Platform.OS === 'ios' ? 'password' : undefined}
                            />
                        </View>
                    </ItemGroup>
                </ItemListStatic>

                <View style={{ height: 16 }} />

                <View style={{ flexDirection: 'row', gap: 12 }}>
                    <View style={{ flex: 1 }}>
                        <Pressable
                            onPress={props.onClose}
                            style={({ pressed }) => ({
                                backgroundColor: theme.colors.surface,
                                borderRadius: 10,
                                paddingVertical: 12,
                                alignItems: 'center',
                                opacity: pressed ? 0.85 : 1,
                            })}
                        >
                            <Text style={{ color: theme.colors.text, ...Typography.default('semiBold') }}>
                                {t('common.cancel')}
                            </Text>
                        </Pressable>
                    </View>
                    <View style={{ flex: 1 }}>
                        <Pressable
                            onPress={submit}
                            disabled={!name.trim() || !value.trim()}
                            style={({ pressed }) => ({
                                backgroundColor: theme.colors.button.primary.background,
                                borderRadius: 10,
                                paddingVertical: 12,
                                alignItems: 'center',
                                opacity: (!name.trim() || !value.trim()) ? 0.5 : (pressed ? 0.85 : 1),
                            })}
                        >
                            <Text style={{ color: theme.colors.button.primary.tint, ...Typography.default('semiBold') }}>
                                {t('common.save')}
                            </Text>
                        </Pressable>
                    </View>
                </View>
            </View>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '92%',
        maxWidth: 560,
        backgroundColor: theme.colors.groupped.background,
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        flexShrink: 1,
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
    body: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    inputContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    helpText: {
        color: theme.colors.textSecondary,
        fontSize: Platform.select({ ios: 15, default: 14 }),
        lineHeight: 20,
        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
        marginBottom: 12,
        ...Typography.default(),
    },
    fieldLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.groupped.sectionTitle,
        marginBottom: 8,
    },
    textInput: {
        ...Typography.default('regular'),
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ ios: 10, default: 12 }),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
        color: theme.colors.input.text,
        ...(Platform.select({
            web: {
                outline: 'none',
                outlineStyle: 'none',
                outlineWidth: 0,
                outlineColor: 'transparent',
                boxShadow: 'none',
                WebkitBoxShadow: 'none',
                WebkitAppearance: 'none',
            },
            default: {},
        }) as object),
    },
}));

