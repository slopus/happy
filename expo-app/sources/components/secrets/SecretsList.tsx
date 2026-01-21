import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { ItemRowActions } from '@/components/ItemRowActions';
import { Modal } from '@/modal';
import type { SavedSecret } from '@/sync/settings';
import { t } from '@/text';
import { SecretAddModal } from '@/components/secrets/SecretAddModal';

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

    const orderedSecrets = React.useMemo(() => {
        const defaultId = props.defaultId ?? null;
        if (!defaultId) return props.secrets;
        const defaultSecret = props.secrets.find((k) => k.id === defaultId) ?? null;
        if (!defaultSecret) return props.secrets;
        const rest = props.secrets.filter((k) => k.id !== defaultId);
        return [defaultSecret, ...rest];
    }, [props.secrets, props.defaultId]);

    const addSecret = React.useCallback(async () => {
        Modal.show({
            component: SecretAddModal,
            props: {
                onSubmit: ({ name, value }) => {
                    const now = Date.now();
                    const next: SavedSecret = {
                        id: newId(),
                        name,
                            kind: 'apiKey',
                        encryptedValue: { _isSecretValue: true, value },
                        createdAt: now,
                        updatedAt: now,
                    };
                    props.onChangeSecrets([next, ...props.secrets]);
                    props.onAfterAddSelectId?.(next.id);
                },
            },
        });
    }, [props]);

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
        props.onChangeSecrets(props.secrets.map((k) => (k.id === secret.id ? { ...k, name: name.trim(), updatedAt: now } : k)));
    }, [props]);

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
        props.onChangeSecrets(props.secrets.map((k) => (
            k.id === secret.id
                ? { ...k, encryptedValue: { ...(k.encryptedValue ?? { _isSecretValue: true }), _isSecretValue: true, value: value.trim() }, updatedAt: now }
                : k
        )));
    }, [props]);

    const deleteSecret = React.useCallback(async (secret: SavedSecret) => {
        const confirmed = await Modal.confirm(
            t('secrets.prompts.deleteTitle'),
            t('secrets.prompts.deleteConfirm', { name: secret.name }),
            { cancelText: t('common.cancel'), confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed) return;
        props.onChangeSecrets(props.secrets.filter((k) => k.id !== secret.id));
        if (props.selectedId === secret.id) {
            props.onSelectId?.('');
        }
        if (props.defaultId === secret.id) {
            props.onSetDefaultId?.(null);
        }
    }, [props]);

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
                                    </View>
                                )}
                            />
                        );
                    })
                )}
            </ItemGroup>
            <ItemGroup footer={groupFooter}>
                {props.allowAdd !== false ? (
                    <Item
                        title={t('common.add')}
                        subtitle={t('secrets.addSubtitle')}
                        icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.button.secondary.tint} />}
                        onPress={() => { void addSecret(); }}
                        showChevron={false}
                        showDivider={false}
                    />
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

