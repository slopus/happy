import React from 'react';
import { View, Text, Pressable, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { EnvironmentVariableCard } from './EnvironmentVariableCard';
import type { ProfileDocumentation } from '@/sync/profileUtils';

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
            {/* Section header */}
            <Text style={{
                fontSize: 14,
                fontWeight: '600',
                color: theme.colors.text,
                marginBottom: 12,
                ...Typography.default('semiBold')
            }}>
                Environment Variables
            </Text>

            {/* Add Variable Button */}
            <Pressable
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: theme.colors.button.primary.background,
                    borderRadius: theme.borderRadius.md,
                    paddingHorizontal: theme.margins.md,
                    paddingVertical: 6,
                    gap: 6,
                    marginBottom: theme.margins.md
                }}
                onPress={() => setShowAddForm(true)}
            >
                <Ionicons name="add" size={theme.iconSize.medium} color={theme.colors.button.primary.tint} />
                <Text style={{
                    fontSize: 13,
                    fontWeight: '600',
                    color: theme.colors.button.primary.tint,
                    ...Typography.default('semiBold')
                }}>
                    Add Variable
                </Text>
            </Pressable>

            {/* Add variable inline form */}
            {showAddForm && (
                <View style={{
                    backgroundColor: theme.colors.input.background,
                    borderRadius: theme.borderRadius.lg,
                    padding: theme.margins.md,
                    marginBottom: theme.margins.md,
                    borderWidth: 2,
                    borderColor: theme.colors.button.primary.background,
                }}>
                    <TextInput
                        style={{
                            backgroundColor: theme.colors.surface,
                            borderRadius: theme.borderRadius.lg,
                            padding: theme.margins.sm,
                            fontSize: 14,
                            color: theme.colors.text,
                            marginBottom: theme.margins.sm,
                            borderWidth: 1,
                            borderColor: theme.colors.textSecondary,
                        }}
                        placeholder="Variable name (e.g., MY_CUSTOM_VAR)"
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={newVarName}
                        onChangeText={setNewVarName}
                        autoCapitalize="characters"
                        autoCorrect={false}
                    />
                    <TextInput
                        style={{
                            backgroundColor: theme.colors.surface,
                            borderRadius: theme.borderRadius.lg,
                            padding: theme.margins.sm,
                            fontSize: 14,
                            color: theme.colors.text,
                            marginBottom: theme.margins.md,
                            borderWidth: 1,
                            borderColor: theme.colors.textSecondary,
                        }}
                        placeholder="Value (e.g., my-value or ${MY_VAR})"
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={newVarValue}
                        onChangeText={setNewVarValue}
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                        <Pressable
                            style={{
                                flex: 1,
                                backgroundColor: theme.colors.surface,
                                borderRadius: 6,
                                padding: theme.margins.sm,
                                alignItems: 'center',
                                borderWidth: 1,
                                borderColor: theme.colors.textSecondary,
                            }}
                            onPress={() => {
                                setShowAddForm(false);
                                setNewVarName('');
                                setNewVarValue('');
                            }}
                        >
                            <Text style={{
                                fontSize: 14,
                                color: theme.colors.textSecondary,
                                ...Typography.default()
                            }}>
                                Cancel
                            </Text>
                        </Pressable>
                        <Pressable
                            style={{
                                flex: 1,
                                backgroundColor: theme.colors.button.primary.background,
                                borderRadius: 6,
                                padding: theme.margins.sm,
                                alignItems: 'center',
                            }}
                            onPress={handleAddVariable}
                        >
                            <Text style={{
                                fontSize: 14,
                                fontWeight: '600',
                                color: theme.colors.button.primary.tint,
                                ...Typography.default('semiBold')
                            }}>
                                Add
                            </Text>
                        </Pressable>
                    </View>
                </View>
            )}

            {/* Variable cards */}
            {environmentVariables.map((envVar, index) => {
                const varNameFromValue = extractVarNameFromValue(envVar.value);
                const docs = getDocumentation(varNameFromValue || envVar.name);

                // Auto-detect secrets if not explicitly documented
                const isSecret = docs.isSecret || /TOKEN|KEY|SECRET|AUTH/i.test(envVar.name) || /TOKEN|KEY|SECRET|AUTH/i.test(varNameFromValue || '');

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
    );
}
