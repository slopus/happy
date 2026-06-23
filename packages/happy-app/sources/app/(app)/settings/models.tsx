import * as React from 'react';
import { View, TextInput, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';
import type { CustomModelProvider } from '@/sync/settings';
import { t } from '@/text';
import { Modal } from '@/modal';
import { StyleSheet } from 'react-native-unistyles';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    formContainer: {
        padding: 16,
        gap: 12,
    },
    fieldRow: {
        flexDirection: 'column',
        gap: 4,
    },
    fieldLabel: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
    textInput: {
        fontSize: 16,
        color: theme.colors.text,
        backgroundColor: theme.colors.surfaceSecondary,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ ios: 10, default: 12 }),
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    flavorToggle: {
        flexDirection: 'row',
        gap: 8,
    },
    flavorButton: {
        flex: 1,
        paddingVertical: 10,
        borderRadius: 8,
        alignItems: 'center',
        borderWidth: 1,
    },
    flavorButtonActive: {
        backgroundColor: theme.colors.header.tint,
        borderColor: theme.colors.header.tint,
    },
    flavorButtonInactive: {
        backgroundColor: 'transparent',
        borderColor: theme.colors.divider,
    },
    flavorButtonText: {
        fontSize: 14,
        fontWeight: '600',
    },
    flavorButtonTextActive: {
        color: '#FFFFFF',
    },
    flavorButtonTextInactive: {
        color: theme.colors.textSecondary,
    },
    actionRow: {
        flexDirection: 'row',
        gap: 12,
        paddingTop: 8,
    },
    actionButton: {
        flex: 1,
        paddingVertical: 12,
        borderRadius: 8,
        alignItems: 'center',
    },
    saveButton: {
        backgroundColor: theme.colors.header.tint,
    },
    cancelButton: {
        backgroundColor: theme.colors.surfaceSecondary,
    },
    saveButtonText: {
        color: '#FFFFFF',
        fontWeight: '600',
        fontSize: 15,
    },
    cancelButtonText: {
        color: theme.colors.textSecondary,
        fontWeight: '600',
        fontSize: 15,
    },
    emptyState: {
        padding: 40,
        alignItems: 'center',
    },
    emptyStateText: {
        fontSize: 15,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        lineHeight: 22,
    },
}));

function generateId(): string {
    return `prov_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function FormFields({
    provider,
    onChange,
}: {
    provider: Partial<CustomModelProvider>;
    onChange: (updated: Partial<CustomModelProvider>) => void;
}) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <View style={styles.formContainer}>
            {/* Name */}
            <View style={styles.fieldRow}>
                <TextInput
                    style={styles.textInput}
                    placeholder="e.g., My Anthropic Proxy"
                    placeholderTextColor={theme.colors.textSecondary + '60'}
                    value={provider.name || ''}
                    onChangeText={(text) => onChange({ ...provider, name: text })}
                />
            </View>

            {/* Base URL */}
            <View style={styles.fieldRow}>
                <TextInput
                    style={styles.textInput}
                    placeholder="https://api.myproxy.com"
                    placeholderTextColor={theme.colors.textSecondary + '60'}
                    value={provider.baseUrl || ''}
                    onChangeText={(text) => onChange({ ...provider, baseUrl: text })}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                />
            </View>

            {/* API Key */}
            <View style={styles.fieldRow}>
                <TextInput
                    style={styles.textInput}
                    placeholder="sk-..."
                    placeholderTextColor={theme.colors.textSecondary + '60'}
                    value={provider.apiKey || ''}
                    onChangeText={(text) => onChange({ ...provider, apiKey: text })}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry
                />
            </View>

            {/* Model Name */}
            <View style={styles.fieldRow}>
                <TextInput
                    style={styles.textInput}
                    placeholder="claude-sonnet-4-20250514"
                    placeholderTextColor={theme.colors.textSecondary + '60'}
                    value={provider.modelName || ''}
                    onChangeText={(text) => onChange({ ...provider, modelName: text })}
                    autoCapitalize="none"
                    autoCorrect={false}
                />
            </View>

            {/* Agent Flavor Toggle */}
            <View style={styles.flavorToggle}>
                <Item
                    title="Claude Code"
                    style={{ flex: 1 }}
                    onPress={() => onChange({ ...provider, agentFlavor: 'claude' })}
                    showChevron={false}
                    rightElement={
                        provider.agentFlavor === 'claude' || !provider.agentFlavor ? (
                            <Ionicons name="checkmark-circle" size={22} color={theme.colors.header.tint} />
                        ) : undefined
                    }
                />
                <Item
                    title="Codex"
                    style={{ flex: 1 }}
                    onPress={() => onChange({ ...provider, agentFlavor: 'codex' })}
                    showChevron={false}
                    rightElement={
                        provider.agentFlavor === 'codex' ? (
                            <Ionicons name="checkmark-circle" size={22} color={theme.colors.header.tint} />
                        ) : undefined
                    }
                />
            </View>
        </View>
    );
}

export default React.memo(function CustomModelsSettingsScreen() {
    const { theme } = useUnistyles();
    const [providers, setProviders] = useSettingMutable('customModelProviders');
    const [editingId, setEditingId] = React.useState<string | null>(null);
    const [editForm, setEditForm] = React.useState<Partial<CustomModelProvider> | null>(null);

    const handleAdd = () => {
        const newId = generateId();
        setEditingId(newId);
        setEditForm({
            id: newId,
            name: '',
            baseUrl: '',
            apiKey: '',
            modelName: '',
            agentFlavor: 'claude',
        });
    };

    const handleEdit = (provider: CustomModelProvider) => {
        setEditingId(provider.id);
        setEditForm({ ...provider });
    };

    const handleDelete = (id: string) => {
        setProviders(providers.filter(p => p.id !== id));
        if (editingId === id) {
            setEditingId(null);
            setEditForm(null);
        }
    };

    const handleSave = () => {
        if (!editForm || !editForm.name || !editForm.baseUrl || !editForm.apiKey || !editForm.modelName) {
            Modal.alert('Missing Fields', 'Please fill in all fields before saving.');
            return;
        }

        const cleaned: CustomModelProvider = {
            id: editForm.id!,
            name: editForm.name!,
            baseUrl: editForm.baseUrl!,
            apiKey: editForm.apiKey!,
            modelName: editForm.modelName!,
            agentFlavor: editForm.agentFlavor || 'claude',
        };

        const existingIndex = providers.findIndex(p => p.id === cleaned.id);
        if (existingIndex >= 0) {
            const updated = [...providers];
            updated[existingIndex] = cleaned;
            setProviders(updated);
        } else {
            setProviders([...providers, cleaned]);
        }
        setEditingId(null);
        setEditForm(null);
    };

    const handleCancel = () => {
        setEditingId(null);
        setEditForm(null);
    };

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Header */}
            <ItemGroup>
                <Item
                    title="Add Custom Provider"
                    subtitle="Connect to a custom API endpoint"
                    icon={<Ionicons name="add-circle-outline" size={29} color="#34C759" />}
                    onPress={handleAdd}
                    showChevron={false}
                />
            </ItemGroup>

            {/* Empty State */}
            {providers.length === 0 && !editingId && (
                <ItemGroup>
                    <View style={stylesheet.emptyState}>
                        <Ionicons name="cloud-offline-outline" size={48} color={theme.colors.textSecondary + '60'} />
                        <View style={{ height: 12 }} />
                        <Item
                            title="No Custom Providers"
                            subtitle="Add a provider to use your own API endpoint with any agent flavor."
                            showChevron={false}
                        />
                    </View>
                </ItemGroup>
            )}

            {/* Active Form (Add/Edit) */}
            {editingId !== null && editForm && (
                <ItemGroup title={providers.find(p => p.id === editingId) ? 'Edit Provider' : 'New Provider'}>
                    <FormFields provider={editForm} onChange={setEditForm} />
                    <View style={stylesheet.actionRow}>
                        <Item
                            title="Cancel"
                            onPress={handleCancel}
                            showChevron={false}
                        />
                        <Item
                            title="Save"
                            onPress={handleSave}
                            showChevron={false}
                        />
                    </View>
                </ItemGroup>
            )}

            {/* Provider List */}
            {providers.map((provider) => (
                <ItemGroup key={provider.id} title={provider.name}>
                    <Item
                        title={provider.modelName}
                        subtitle={`${provider.baseUrl} • ${provider.agentFlavor === 'codex' ? 'Codex' : 'Claude Code'}`}
                        icon={<Ionicons name="cloud-outline" size={29} color="#5AC8FA" />}
                        onPress={() => handleEdit(provider)}
                        showChevron={false}
                    />
                    <View style={stylesheet.actionRow}>
                        <Item
                            title="Edit"
                            onPress={() => handleEdit(provider)}
                            showChevron={false}
                        />
                        <Item
                            title="Delete"
                            onPress={() => {
                                Modal.confirm(
                                    'Delete Provider',
                                    `Remove "${provider.name}" and all its saved credentials?`,
                                    { confirmText: 'Delete', destructive: true }
                                ).then((confirmed) => {
                                    if (confirmed) handleDelete(provider.id);
                                });
                            }}
                            showChevron={false}
                        />
                    </View>
                </ItemGroup>
            ))}

            {/* Info Footer */}
            <ItemGroup
                footer="Custom providers let you route agent requests through your own API. The base URL, API key, and model name are sent through Happy Server to the CLI and are never stored on the server."
            >
                <Item
                    title="How it works"
                    subtitle="For Claude Code: ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY are set. For Codex: OPENAI_BASE_URL and OPENAI_API_KEY are set. The model name is passed as the model parameter."
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});
