import React from 'react';
import { Platform, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { Modal } from '@/modal';
import type { SavedSecret } from '@/sync/settings';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

function newId(): string {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c: any = (globalThis as any).crypto;
        if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    } catch { }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export interface SecretsListProps {
    secrets: SavedSecret[];
    onChangeSecrets: (next: SavedSecret[]) => void;

    title?: string;
    footer?: string | null;

    selectedId?: string;
    onSelectId?: (id: string) => void;

    includeNoneRow?: boolean;
    noneSubtitle?: string;

    defaultId?: string | null;
    onSetDefaultId?: (id: string | null) => void;

    allowAdd?: boolean;
    allowEdit?: boolean;
    onAfterAddSelectId?: (id: string) => void;

    wrapInItemList?: boolean;
}

export function SecretsList(props: SecretsListProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const {
        secrets,
        defaultId,
        onChangeSecrets,
        onAfterAddSelectId,
        selectedId,
        onSelectId,
        onSetDefaultId,
    } = props;

    const orderedSecrets = React.useMemo(() => {
        const resolvedDefaultId = defaultId ?? null;
        if (!resolvedDefaultId) return secrets;
        const defaultSecret = secrets.find((k) => k.id === resolvedDefaultId) ?? null;
        if (!defaultSecret) return secrets;
        const rest = secrets.filter((k) => k.id !== resolvedDefaultId);
        return [defaultSecret, ...rest];
    }, [defaultId, secrets]);

    const [isAddExpanded, setIsAddExpanded] = React.useState(false);
    const [draftName, setDraftName] = React.useState('');
    const [draftValue, setDraftValue] = React.useState('');
    const nameInputRef = React.useRef<TextInput>(null);

    const resetAddDraft = React.useCallback(() => {
        setDraftName('');
        setDraftValue('');
        setIsAddExpanded(false);
    }, []);

    const submitAddSecret = React.useCallback(() => {
        const name = draftName.trim();
        const value = draftValue.trim();
        if (!name) return;
        if (!value) return;

        const now = Date.now();
        const next: SavedSecret = {
            id: newId(),
            name,
            kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, value },
            createdAt: now,
            updatedAt: now,
        };
        onChangeSecrets([next, ...secrets]);
        onAfterAddSelectId?.(next.id);
        resetAddDraft();
    }, [draftName, draftValue, onAfterAddSelectId, onChangeSecrets, resetAddDraft, secrets]);

    const renameSecret = React.useCallback(async (secret: SavedSecret) => {
        const name = await Modal.prompt(
            t('secrets.prompts.renameTitle'),
            t('secrets.prompts.renameDescription'),
            { defaultValue: secret.name, placeholder: t('secrets.fields.name'), cancelText: t('common.cancel'), confirmText: t('common.rename') },
        );
        if (name === null) return;
        if (!name.trim()) {
            Modal.alert(t('common.error'), t('secrets.validation.nameRequired'));
            return;
        }
        const now = Date.now();
        onChangeSecrets(secrets.map((k) => (k.id === secret.id ? { ...k, name: name.trim(), updatedAt: now } : k)));
    }, [onChangeSecrets, secrets]);

    const replaceSecretValue = React.useCallback(async (secret: SavedSecret) => {
        const value = await Modal.prompt(
            t('secrets.prompts.replaceValueTitle'),
            t('secrets.prompts.replaceValueDescription'),
            { placeholder: 'sk-...', inputType: 'secure-text', cancelText: t('common.cancel'), confirmText: t('secrets.actions.replace') },
        );
        if (value === null) return;
        if (!value.trim()) {
            Modal.alert(t('common.error'), t('secrets.validation.valueRequired'));
            return;
        }
        const now = Date.now();
        onChangeSecrets(secrets.map((k) => (
            k.id === secret.id
                ? { ...k, encryptedValue: { ...(k.encryptedValue ?? { _isSecretValue: true }), _isSecretValue: true, value: value.trim() }, updatedAt: now }
                : k
        )));
    }, [onChangeSecrets, secrets]);

    const deleteSecret = React.useCallback(async (secret: SavedSecret) => {
        const confirmed = await Modal.confirm(
            t('secrets.prompts.deleteTitle'),
            t('secrets.prompts.deleteConfirm', { name: secret.name }),
            { cancelText: t('common.cancel'), confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed) return;
        onChangeSecrets(secrets.filter((k) => k.id !== secret.id));
        if (selectedId === secret.id) {
            onSelectId?.('');
        }
        if (defaultId === secret.id) {
            onSetDefaultId?.(null);
        }
    }, [defaultId, onChangeSecrets, onSelectId, onSetDefaultId, secrets, selectedId]);

    const groupTitle = props.title ?? t('settings.secrets');
    const groupFooter = props.footer === undefined ? t('settings.secretsSubtitle') : (props.footer ?? undefined);

    const group = (
        <>
            <ItemGroup title={groupTitle}>
                {props.includeNoneRow && (
                    <Item
                        title={t('secrets.noneTitle')}
                        subtitle={props.noneSubtitle ?? t('secrets.noneSubtitle')}
                        icon={<Ionicons name="close-circle-outline" size={29} color={theme.colors.textSecondary} />}
                        onPress={() => props.onSelectId?.('')}
                        showChevron={false}
                        selected={props.selectedId === ''}
                        showDivider
                    />
                )}

                {props.secrets.length === 0 ? (
                    <Item
                        title={t('secrets.emptyTitle')}
                        subtitle={t('secrets.emptySubtitle')}
                        icon={<Ionicons name="key-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                ) : (
                    orderedSecrets.map((secret, idx) => {
                        const isSelected = props.selectedId === secret.id;
                        const isDefault = props.defaultId === secret.id;
                        return (
                            <Item
                                key={secret.id}
                                title={secret.name}
                                subtitle={t('secrets.savedHiddenSubtitle')}
                                icon={<Ionicons name="key-outline" size={29} color={theme.colors.button.secondary.tint} />}
                                onPress={props.onSelectId ? () => props.onSelectId?.(secret.id) : undefined}
                                showChevron={false}
                                selected={Boolean(props.onSelectId) ? isSelected : false}
                                showDivider={idx < orderedSecrets.length - 1}
                                rightElement={(
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                                        {props.onSetDefaultId && (
                                            <ItemRowActions
                                                title={t('secrets.defaultLabel')}
                                                compactActionIds={['default']}
                                                iconSize={18}
                                                actions={[
                                                    {
                                                        id: 'default',
                                                        title: isDefault ? t('secrets.actions.unsetDefault') : t('secrets.actions.setDefault'),
                                                        icon: isDefault ? 'star' : 'star-outline',
                                                        color: isDefault ? theme.colors.button.primary.background : theme.colors.textSecondary,
                                                        onPress: () => props.onSetDefaultId?.(isDefault ? null : secret.id),
                                                    },
                                                ]}
                                            />
                                        )}

                                        {props.allowEdit !== false && (
                                            <ItemRowActions
                                                title={secret.name}
                                                compactActionIds={['edit']}
                                                actions={[
                                                    { id: 'edit', title: t('common.rename'), icon: 'pencil-outline', onPress: () => { void renameSecret(secret); } },
                                                    { id: 'replace', title: t('secrets.actions.replaceValue'), icon: 'refresh-outline', onPress: () => { void replaceSecretValue(secret); } },
                                                    { id: 'delete', title: t('common.delete'), icon: 'trash-outline', destructive: true, onPress: () => { void deleteSecret(secret); } },
                                                ]}
                                            />
                                        )}

                                        {props.onSelectId && (
                                            <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
                                                <Ionicons
                                                    name="checkmark-circle"
                                                    size={24}
                                                    color={theme.colors.text}
                                                    style={{ opacity: isSelected ? 1 : 0 }}
                                                />
                                            </View>
                                        )}
                                    </View>
                                )}
                            />
                        );
                    })
                )}
            </ItemGroup>
            <ItemGroup footer={groupFooter}>
                {props.allowAdd !== false ? (
                    <InlineAddExpander
                        isOpen={isAddExpanded}
                        onOpenChange={setIsAddExpanded}
                        title={t('common.add')}
                        subtitle={t('secrets.addSubtitle')}
                        icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.button.secondary.tint} />}
                        onCancel={resetAddDraft}
                        onSave={submitAddSecret}
                        saveDisabled={!draftName.trim() || !draftValue.trim()}
                        cancelLabel={t('common.cancel')}
                        saveLabel={t('common.save')}
                        autoFocusRef={nameInputRef}
                    >
                        <Text style={styles.fieldLabel}>{t('secrets.fields.name')}</Text>
                        <TextInput
                            ref={nameInputRef}
                            style={styles.textInput}
                            placeholder={t('secrets.placeholders.nameExample')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={draftName}
                            onChangeText={setDraftName}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />

                        <View style={{ height: 12 }} />

                        <Text style={styles.fieldLabel}>{t('secrets.fields.value')}</Text>
                        <TextInput
                            style={styles.textInput}
                            placeholder="sk-..."
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={draftValue}
                            onChangeText={setDraftValue}
                            autoCapitalize="none"
                            autoCorrect={false}
                            secureTextEntry
                            textContentType={Platform.OS === 'ios' ? 'password' : undefined}
                        />
                    </InlineAddExpander>
                ) : null}
            </ItemGroup>
        </>
    );

    if (props.wrapInItemList === false) {
        return group;
    }

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {group}
        </ItemList>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
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
        paddingVertical: Platform.select({ ios: 8, default: 10 }),
        fontSize: Platform.select({ ios: 16, default: 16 }),
        lineHeight: Platform.select({ ios: 20, default: 22 }),
        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
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
