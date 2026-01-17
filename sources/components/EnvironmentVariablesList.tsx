import React from 'react';
import { View, Text, Pressable, TextInput, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { EnvironmentVariableCard } from './EnvironmentVariableCard';
import type { ProfileDocumentation } from '@/sync/profileUtils';
import { Item } from '@/components/Item';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useEnvironmentVariables } from '@/hooks/useEnvironmentVariables';

export interface EnvironmentVariablesListProps {
    environmentVariables: Array<{ name: string; value: string }>;
    machineId: string | null;
    machineName?: string | null;
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
    machineName,
    profileDocs,
    onChange,
}: EnvironmentVariablesListProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    // Extract variable name from a template value (for matching documentation / machine env lookup)
    const extractVarNameFromValue = React.useCallback((value: string): string | null => {
        const match = value.match(/^\$\{([A-Z_][A-Z0-9_]*)/);
        return match ? match[1] : null;
    }, []);

    const SECRET_NAME_REGEX = React.useMemo(() => /TOKEN|KEY|SECRET|AUTH|PASS|PASSWORD|COOKIE/i, []);

    const documentedSecretNames = React.useMemo(() => {
        if (!profileDocs) return new Set<string>();

        return new Set(
            profileDocs.environmentVariables
                .filter((envVar) => envVar.isSecret)
                .map((envVar) => envVar.name),
        );
    }, [profileDocs]);

    const resolvedEnvVarRefs = React.useMemo(() => {
        const refs = new Set<string>();
        environmentVariables.forEach((envVar) => {
            const ref = extractVarNameFromValue(envVar.value);
            if (!ref) return;
            // Don't query secret-like env vars from the machine.
            if (SECRET_NAME_REGEX.test(ref) || SECRET_NAME_REGEX.test(envVar.name)) return;
            if (documentedSecretNames.has(ref) || documentedSecretNames.has(envVar.name)) return;
            refs.add(ref);
        });
        return Array.from(refs);
    }, [SECRET_NAME_REGEX, documentedSecretNames, environmentVariables, extractVarNameFromValue]);

    const { variables: machineEnv, isLoading: isMachineEnvLoading } = useEnvironmentVariables(
        machineId,
        resolvedEnvVarRefs,
    );

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
        const normalizedName = newVarName.trim().toUpperCase();
        if (!normalizedName) {
            Modal.alert(t('common.error'), t('profiles.environmentVariables.validation.nameRequired'));
            return;
        }

        // Validate variable name format
        if (!/^[A-Z_][A-Z0-9_]*$/.test(normalizedName)) {
            Modal.alert(
                t('common.error'),
                t('profiles.environmentVariables.validation.invalidNameFormat'),
            );
            return;
        }

        // Check for duplicates
        if (environmentVariables.some(v => v.name === normalizedName)) {
            Modal.alert(t('common.error'), t('profiles.environmentVariables.validation.duplicateName'));
            return;
        }

        onChange([...environmentVariables, {
            name: normalizedName,
            value: newVarValue.trim() || ''
        }]);

        // Reset form
        setNewVarName('');
        setNewVarValue('');
        setShowAddForm(false);
    }, [environmentVariables, newVarName, newVarValue, onChange]);

    return (
        <View style={styles.container}>
            <View style={styles.titleContainer}>
                <Text style={styles.titleText}>
                    {t('profiles.environmentVariables.title')}
                </Text>
            </View>

            {environmentVariables.length > 0 && (
                <View style={styles.envVarListContainer}>
                    {environmentVariables.map((envVar, index) => {
                        const varNameFromValue = extractVarNameFromValue(envVar.value);
                        const primaryDocs = getDocumentation(envVar.name);
                        const refDocs = varNameFromValue ? getDocumentation(varNameFromValue) : undefined;
                        const isSecret =
                            primaryDocs.isSecret ||
                            refDocs?.isSecret ||
                            SECRET_NAME_REGEX.test(envVar.name) ||
                            SECRET_NAME_REGEX.test(varNameFromValue || '');
                        const expectedValue = primaryDocs.expectedValue ?? refDocs?.expectedValue;
                        const description = primaryDocs.description ?? refDocs?.description;

                        return (
                            <EnvironmentVariableCard
                                key={envVar.name}
                                variable={envVar}
                                index={index}
                                machineId={machineId}
                                machineName={machineName ?? null}
                                machineEnv={machineEnv}
                                isMachineEnvLoading={isMachineEnvLoading}
                                expectedValue={expectedValue}
                                description={description}
                                isSecret={isSecret}
                                onUpdate={handleUpdateVariable}
                                onDelete={handleDeleteVariable}
                                onDuplicate={handleDuplicateVariable}
                            />
                        );
                    })}
                </View>
            )}

            <View style={styles.addContainer}>
                <Item
                    title={showAddForm ? t('common.cancel') : t('profiles.environmentVariables.addVariable')}
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
                    <View style={styles.addFormContainer}>
                        <View style={styles.addInputRow}>
                            <TextInput
                                style={styles.addTextInput}
                                placeholder={t('profiles.environmentVariables.namePlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                value={newVarName}
                                onChangeText={(text) => setNewVarName(text.toUpperCase())}
                                autoCapitalize="characters"
                                autoCorrect={false}
                            />
                        </View>

                        <View style={[styles.addInputRow, styles.addInputRowLast]}>
                            <TextInput
                                style={styles.addTextInput}
                                placeholder={t('profiles.environmentVariables.valuePlaceholder')}
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
                            style={({ pressed }) => [
                                styles.addButton,
                                { opacity: !newVarName.trim() ? 0.5 : pressed ? 0.85 : 1 },
                            ]}
                        >
                            <Text style={styles.addButtonText}>
                                {t('common.add')}
                            </Text>
                        </Pressable>
                    </View>
                )}
            </View>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        marginBottom: 16,
    },
    titleContainer: {
        paddingTop: Platform.select({ ios: 35, default: 16 }),
        paddingBottom: Platform.select({ ios: 6, default: 8 }),
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
    },
    titleText: {
        ...Typography.default('regular'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        textTransform: 'uppercase',
        fontWeight: '500',
    },
    envVarListContainer: {
        marginHorizontal: Platform.select({ ios: 16, default: 12 }),
    },
    addContainer: {
        backgroundColor: theme.colors.surface,
        marginHorizontal: Platform.select({ ios: 16, default: 12 }),
        borderRadius: Platform.select({ ios: 10, default: 16 }),
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 0.33 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 0,
        elevation: 1,
    },
    addFormContainer: {
        paddingHorizontal: 16,
        paddingBottom: 12,
    },
    addInputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
        marginBottom: 8,
    },
    addInputRowLast: {
        marginBottom: 12,
    },
    addTextInput: {
        flex: 1,
        fontSize: 16,
        color: theme.colors.input.text,
        ...Typography.default('regular'),
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
    addButton: {
        backgroundColor: theme.colors.button.primary.background,
        borderRadius: 10,
        paddingVertical: 10,
        alignItems: 'center',
    },
    addButtonText: {
        color: theme.colors.button.primary.tint,
        ...Typography.default('semiBold'),
    },
}));
