import React from 'react';
import { View, Text, Pressable, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { EnvironmentVariableCard } from './EnvironmentVariableCard';
import type { ProfileDocumentation } from '@/sync/profileUtils';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { layout } from '@/components/layout';

export interface EnvironmentVariablesListProps {
    environmentVariables: Array<{ name: string; value: string }>;
    machineId: string | null;
    profileDocs?: ProfileDocumentation | null;
    onChange: (newVariables: Array<{ name: string; value: string }>) => void;
}

/**
 * Complete environment variables section with title, add button, and editable cards
 * Matches profile list pattern from index.tsx:1159-1308
 */
export function EnvironmentVariablesList({
    environmentVariables,
    machineId,
    profileDocs,
    onChange,
}: EnvironmentVariablesListProps) {
    const { theme } = useUnistyles();

    // Add variable inline form state
    const [showAddForm, setShowAddForm] = React.useState(false);
    const [newVarName, setNewVarName] = React.useState('');
    const [newVarValue, setNewVarValue] = React.useState('');

    // Helper to get expected value and description from documentation
    const getDocumentation = React.useCallback((varName: string) => {
        if (!profileDocs) return { expectedValue: undefined, description: undefined, isSecret: false };

        const doc = profileDocs.environmentVariables.find(ev => ev.name === varName);
        return {
            expectedValue: doc?.expectedValue,
            description: doc?.description,
            isSecret: doc?.isSecret || false
        };
    }, [profileDocs]);

    // Extract variable name from value (for matching documentation)
    const extractVarNameFromValue = React.useCallback((value: string): string | null => {
        const match = value.match(/^\$\{([A-Z_][A-Z0-9_]*)/);
        return match ? match[1] : null;
    }, []);

    const handleUpdateVariable = React.useCallback((index: number, newValue: string) => {
        const updated = [...environmentVariables];
        updated[index] = { ...updated[index], value: newValue };
        onChange(updated);
    }, [environmentVariables, onChange]);

    const handleDeleteVariable = React.useCallback((index: number) => {
        onChange(environmentVariables.filter((_, i) => i !== index));
    }, [environmentVariables, onChange]);

    const handleDuplicateVariable = React.useCallback((index: number) => {
        const envVar = environmentVariables[index];
        const baseName = envVar.name.replace(/_COPY\d*$/, '');

        // Find next available copy number
        let copyNum = 1;
        while (environmentVariables.some(v => v.name === `${baseName}_COPY${copyNum}`)) {
            copyNum++;
        }

        const duplicated = {
            name: `${baseName}_COPY${copyNum}`,
            value: envVar.value
        };
        onChange([...environmentVariables, duplicated]);
    }, [environmentVariables, onChange]);

    const handleAddVariable = React.useCallback(() => {
        if (!newVarName.trim()) return;

        // Validate variable name format
        if (!/^[A-Z_][A-Z0-9_]*$/.test(newVarName.trim())) {
            return;
        }

        // Check for duplicates
        if (environmentVariables.some(v => v.name === newVarName.trim())) {
            return;
        }

        onChange([...environmentVariables, {
            name: newVarName.trim(),
            value: newVarValue.trim() || ''
        }]);

        // Reset form
        setNewVarName('');
        setNewVarValue('');
        setShowAddForm(false);
    }, [newVarName, newVarValue, environmentVariables, onChange]);

    return (
        <View style={{ marginBottom: 16 }}>
            <ItemGroup title="Environment Variables">
                <Item
                    title={showAddForm ? 'Cancel' : 'Add Variable'}
                    icon={
                        <Ionicons
                            name={showAddForm ? 'close-circle-outline' : 'add-circle-outline'}
                            size={29}
                            color={theme.colors.button.secondary.tint}
                        />
                    }
                    showChevron={false}
                    onPress={() => {
                        if (showAddForm) {
                            setShowAddForm(false);
                            setNewVarName('');
                            setNewVarValue('');
                        } else {
                            setShowAddForm(true);
                        }
                    }}
                />

                {showAddForm && (
                    <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                        <View style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            backgroundColor: theme.colors.input.background,
                            borderRadius: 10,
                            paddingHorizontal: 12,
                            paddingVertical: 8,
                            marginBottom: 8,
                        }}>
                            <TextInput
                                style={{ flex: 1, fontSize: 16, color: theme.colors.input.text, ...Typography.default('regular') }}
                                placeholder="Variable name (e.g., MY_CUSTOM_VAR)"
                                placeholderTextColor={theme.colors.input.placeholder}
                                value={newVarName}
                                onChangeText={setNewVarName}
                                autoCapitalize="characters"
                                autoCorrect={false}
                            />
                        </View>

                        <View style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            backgroundColor: theme.colors.input.background,
                            borderRadius: 10,
                            paddingHorizontal: 12,
                            paddingVertical: 8,
                            marginBottom: 12,
                        }}>
                            <TextInput
                                style={{ flex: 1, fontSize: 16, color: theme.colors.input.text, ...Typography.default('regular') }}
                                placeholder="Value (e.g., my-value or ${MY_VAR})"
                                placeholderTextColor={theme.colors.input.placeholder}
                                value={newVarValue}
                                onChangeText={setNewVarValue}
                                autoCapitalize="none"
                                autoCorrect={false}
                            />
                        </View>

                        <Pressable
                            onPress={handleAddVariable}
                            disabled={!newVarName.trim()}
                            style={({ pressed }) => ({
                                backgroundColor: theme.colors.button.primary.background,
                                borderRadius: 10,
                                paddingVertical: 10,
                                alignItems: 'center',
                                opacity: !newVarName.trim() ? 0.5 : pressed ? 0.85 : 1,
                            })}
                        >
                            <Text style={{ color: theme.colors.button.primary.tint, ...Typography.default('semiBold') }}>
                                Add
                            </Text>
                        </Pressable>
                    </View>
                )}
            </ItemGroup>

            <View style={{ width: '100%', maxWidth: layout.maxWidth, alignSelf: 'center', marginTop: 12 }}>
                {environmentVariables.map((envVar, index) => {
                    const varNameFromValue = extractVarNameFromValue(envVar.value);
                    const docs = getDocumentation(varNameFromValue || envVar.name);

                    const SECRET_NAME_REGEX = /TOKEN|KEY|SECRET|AUTH|PASS|PASSWORD|COOKIE/i;
                    const isSecret =
                        docs.isSecret ||
                        SECRET_NAME_REGEX.test(envVar.name) ||
                        SECRET_NAME_REGEX.test(varNameFromValue || '');

                    return (
                        <EnvironmentVariableCard
                            key={index}
                            variable={envVar}
                            machineId={machineId}
                            expectedValue={docs.expectedValue}
                            description={docs.description}
                            isSecret={isSecret}
                            onUpdate={(newValue) => handleUpdateVariable(index, newValue)}
                            onDelete={() => handleDeleteVariable(index)}
                            onDuplicate={() => handleDuplicateVariable(index)}
                        />
                    );
                })}
            </View>
        </View>
    );
}
