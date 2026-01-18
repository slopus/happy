import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { ItemRowActions } from '@/components/ItemRowActions';
import { Modal } from '@/modal';
import type { SavedApiKey } from '@/sync/settings';
import { t } from '@/text';
import { ApiKeyAddModal } from '@/components/ApiKeyAddModal';

function newId(): string {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c: any = (globalThis as any).crypto;
        if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    } catch { }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export interface ApiKeysListProps {
    apiKeys: SavedApiKey[];
    onChangeApiKeys: (next: SavedApiKey[]) => void;

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

export function ApiKeysList(props: ApiKeysListProps) {
    const { theme } = useUnistyles();

    const addApiKey = React.useCallback(async () => {
        Modal.show({
            component: ApiKeyAddModal,
            props: {
                onSubmit: ({ name, value }) => {
                    const now = Date.now();
                    const next: SavedApiKey = { id: newId(), name, value, createdAt: now, updatedAt: now };
                    props.onChangeApiKeys([next, ...props.apiKeys]);
                    props.onAfterAddSelectId?.(next.id);
                },
            },
        });
    }, [props]);

    const renameApiKey = React.useCallback(async (key: SavedApiKey) => {
        const name = await Modal.prompt(
            t('apiKeys.prompts.renameTitle'),
            t('apiKeys.prompts.renameDescription'),
            { defaultValue: key.name, placeholder: t('apiKeys.fields.name'), cancelText: t('common.cancel'), confirmText: t('common.rename') },
        );
        if (name === null) return;
        if (!name.trim()) {
            Modal.alert(t('common.error'), t('apiKeys.validation.nameRequired'));
            return;
        }
        const now = Date.now();
        props.onChangeApiKeys(props.apiKeys.map((k) => (k.id === key.id ? { ...k, name: name.trim(), updatedAt: now } : k)));
    }, [props]);

    const replaceApiKeyValue = React.useCallback(async (key: SavedApiKey) => {
        const value = await Modal.prompt(
            t('apiKeys.prompts.replaceValueTitle'),
            t('apiKeys.prompts.replaceValueDescription'),
            { placeholder: 'sk-...', inputType: 'secure-text', cancelText: t('common.cancel'), confirmText: t('apiKeys.actions.replace') },
        );
        if (value === null) return;
        if (!value.trim()) {
            Modal.alert(t('common.error'), t('apiKeys.validation.valueRequired'));
            return;
        }
        const now = Date.now();
        props.onChangeApiKeys(props.apiKeys.map((k) => (k.id === key.id ? { ...k, value: value.trim(), updatedAt: now } : k)));
    }, [props]);

    const deleteApiKey = React.useCallback(async (key: SavedApiKey) => {
        const confirmed = await Modal.confirm(
            t('apiKeys.prompts.deleteTitle'),
            t('apiKeys.prompts.deleteConfirm', { name: key.name }),
            { cancelText: t('common.cancel'), confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed) return;
        props.onChangeApiKeys(props.apiKeys.filter((k) => k.id !== key.id));
        if (props.selectedId === key.id) {
            props.onSelectId?.('');
        }
        if (props.defaultId === key.id) {
            props.onSetDefaultId?.(null);
        }
    }, [props]);

    const groupTitle = props.title ?? t('settings.apiKeys');
    const groupFooter = props.footer === undefined ? t('settings.apiKeysSubtitle') : (props.footer ?? undefined);

    const group = (
        <>
            <ItemGroup title={groupTitle}>
                {props.includeNoneRow && (
                    <Item
                        title={t('apiKeys.noneTitle')}
                        subtitle={props.noneSubtitle ?? t('apiKeys.noneSubtitle')}
                        icon={<Ionicons name="close-circle-outline" size={29} color={theme.colors.textSecondary} />}
                        onPress={() => props.onSelectId?.('')}
                        showChevron={false}
                        selected={props.selectedId === ''}
                        showDivider
                    />
                )}

                {props.apiKeys.length === 0 ? (
                    <Item
                        title={t('apiKeys.emptyTitle')}
                        subtitle={t('apiKeys.emptySubtitle')}
                        icon={<Ionicons name="key-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                ) : (
                    props.apiKeys.map((key, idx) => {
                        const isSelected = props.selectedId === key.id;
                        const isDefault = props.defaultId === key.id;
                        return (
                            <Item
                                key={key.id}
                                title={key.name}
                                subtitle={t('apiKeys.savedHiddenSubtitle')}
                                icon={<Ionicons name="key-outline" size={29} color={theme.colors.button.secondary.tint} />}
                                onPress={props.onSelectId ? () => props.onSelectId?.(key.id) : undefined}
                                showChevron={false}
                                selected={Boolean(props.onSelectId) ? isSelected : false}
                                showDivider={idx < props.apiKeys.length - 1}
                                rightElement={(
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                                        {props.onSetDefaultId && (
                                            <ItemRowActions
                                                title={t('apiKeys.defaultLabel')}
                                                compactActionIds={[]}
                                                iconSize={0}
                                                actions={[
                                                    {
                                                        id: 'default',
                                                        title: isDefault ? t('apiKeys.actions.unsetDefault') : t('apiKeys.actions.setDefault'),
                                                        icon: isDefault ? 'star' : 'star-outline',
                                                        onPress: () => props.onSetDefaultId?.(isDefault ? null : key.id),
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
                                                title={key.name}
                                                compactActionIds={['edit']}
                                                actions={[
                                                    { id: 'edit', title: t('common.rename'), icon: 'pencil-outline', onPress: () => { void renameApiKey(key); } },
                                                    { id: 'replace', title: t('apiKeys.actions.replaceValue'), icon: 'refresh-outline', onPress: () => { void replaceApiKeyValue(key); } },
                                                    { id: 'delete', title: t('common.delete'), icon: 'trash-outline', destructive: true, onPress: () => { void deleteApiKey(key); } },
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
                        subtitle={t('apiKeys.addSubtitle')}
                        icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.button.secondary.tint} />}
                        onPress={() => { void addApiKey(); }}
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
