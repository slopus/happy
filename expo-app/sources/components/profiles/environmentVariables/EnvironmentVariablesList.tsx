import React from 'react';
import { View, Text, TextInput, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { EnvironmentVariableCard } from './EnvironmentVariableCard';
import type { ProfileDocumentation } from '@/sync/profileUtils';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useEnvironmentVariables } from '@/hooks/useEnvironmentVariables';
import { parseEnvVarTemplate } from '@/utils/profiles/envVarTemplate';

export interface EnvironmentVariablesListProps {
    environmentVariables: Array<{ name: string; value: string; isSecret?: boolean }>;
    machineId: string | null;
    machineName?: string | null;
    profileDocs?: ProfileDocumentation | null;
    onChange: (newVariables: Array<{ name: string; value: string; isSecret?: boolean }>) => void;
    sourceRequirementsByName: Record<string, { required: boolean; useSecretVault: boolean } | undefined>;
    onUpdateSourceRequirement: (
        sourceVarName: string,
        next: { required: boolean; useSecretVault: boolean } | null
    ) => void;
    getDefaultSecretNameForSourceVar: (sourceVarName: string) => string | null;
    onPickDefaultSecretForSourceVar: (sourceVarName: string) => void;
}

const SECRET_NAME_REGEX = /TOKEN|KEY|SECRET|AUTH|PASS|PASSWORD|COOKIE/i;
const ENV_VAR_TEMPLATE_REF_REGEX = /\$\{([A-Z_][A-Z0-9_]*)(?::[-=][^}]*)?\}/g;

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
    sourceRequirementsByName,
    onUpdateSourceRequirement,
    getDefaultSecretNameForSourceVar,
    onPickDefaultSecretForSourceVar,
}: EnvironmentVariablesListProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const extractVarRefsFromValue = React.useCallback((value: string): string[] => {
        const refs: string[] = [];
        if (!value) return refs;
        let match: RegExpExecArray | null;
        // Reset regex state defensively (global regex).
        ENV_VAR_TEMPLATE_REF_REGEX.lastIndex = 0;
        while ((match = ENV_VAR_TEMPLATE_REF_REGEX.exec(value)) !== null) {
            const name = match[1];
            if (name) refs.push(name);
        }
        return refs;
    }, []);

    const documentedSecretNames = React.useMemo(() => {
        if (!profileDocs) return new Set<string>();

        return new Set(
            profileDocs.environmentVariables
                .filter((envVar) => envVar.isSecret)
                .map((envVar) => envVar.name),
        );
    }, [profileDocs]);

    const { keysToQuery, extraEnv, sensitiveKeys } = React.useMemo(() => {
        const keys = new Set<string>();
        const env: Record<string, string> = {};
        const sensitive = new Set<string>();

        const isSecretName = (name: string) =>
            documentedSecretNames.has(name) || SECRET_NAME_REGEX.test(name);

        environmentVariables.forEach((envVar) => {
            keys.add(envVar.name);
            env[envVar.name] = envVar.value;

            const valueRefs = extractVarRefsFromValue(envVar.value);
            valueRefs.forEach((ref) => keys.add(ref));

            const isSensitive = isSecretName(envVar.name) || valueRefs.some(isSecretName);
            if (isSensitive) {
                sensitive.add(envVar.name);
                valueRefs.forEach((ref) => { sensitive.add(ref); });
            } else {
                if (SECRET_NAME_REGEX.test(envVar.name)) sensitive.add(envVar.name);
                valueRefs.forEach((ref) => {
                    if (SECRET_NAME_REGEX.test(ref)) sensitive.add(ref);
                });
            }
        });

        return {
            keysToQuery: Array.from(keys),
            extraEnv: env,
            sensitiveKeys: Array.from(sensitive),
        };
    }, [documentedSecretNames, environmentVariables, extractVarRefsFromValue]);

    const { meta: machineEnv, isLoading: isMachineEnvLoading, policy: machineEnvPolicy } = useEnvironmentVariables(
        machineId,
        keysToQuery,
        { extraEnv, sensitiveKeys },
    );

    // Add variable inline form state
    const [isAddExpanded, setIsAddExpanded] = React.useState(false);
    const [newVarName, setNewVarName] = React.useState('');
    const [newVarValue, setNewVarValue] = React.useState('');
    const nameInputRef = React.useRef<TextInput>(null);

    const resetAddDraft = React.useCallback(() => {
        setNewVarName('');
        setNewVarValue('');
        setIsAddExpanded(false);
    }, []);

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

    const handleUpdateSecretOverride = React.useCallback((index: number, isSecret: boolean | undefined) => {
        const updated = [...environmentVariables];
        updated[index] = { ...updated[index], isSecret };
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
            value: envVar.value,
            isSecret: envVar.isSecret,
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
            value: newVarValue.trim() || '',
        }]);

        resetAddDraft();
    }, [environmentVariables, newVarName, newVarValue, onChange, resetAddDraft]);

    return (
        <View style={styles.container}>
            <View style={styles.titleContainer}>
                <Text style={styles.titleText}>
                    {t('profiles.environmentVariables.title')}
                </Text>
            </View>

            {environmentVariables.length > 0 && (
                <View>
                    {environmentVariables.map((envVar, index) => {
                        const refs = extractVarRefsFromValue(envVar.value);
                        const primaryRef = refs[0] ?? null;
                        const primaryDocs = getDocumentation(envVar.name);
                        const refDocs = primaryRef ? getDocumentation(primaryRef) : undefined;
                        const autoSecret =
                            primaryDocs.isSecret ||
                            refDocs?.isSecret ||
                            SECRET_NAME_REGEX.test(envVar.name) ||
                            refs.some((ref) => SECRET_NAME_REGEX.test(ref));
                        const forcedSecret = Boolean(machineEnv?.[envVar.name]?.isForcedSensitive);
                        const effectiveIsSecret = forcedSecret
                            ? true
                            : envVar.isSecret !== undefined
                                ? envVar.isSecret
                                : autoSecret;
                        const expectedValue = primaryDocs.expectedValue ?? refDocs?.expectedValue;
                        const description = primaryDocs.description ?? refDocs?.description;
                        const template = parseEnvVarTemplate(envVar.value);
                        const sourceVarName = template?.sourceVar ?? null;
                        const requirementVarName = (sourceVarName ?? envVar.name).trim().toUpperCase();

                        return (
                            <EnvironmentVariableCard
                                key={envVar.name}
                                variable={envVar}
                                index={index}
                                machineId={machineId}
                                machineName={machineName ?? null}
                                machineEnv={machineEnv}
                                machineEnvPolicy={machineEnvPolicy}
                                isMachineEnvLoading={isMachineEnvLoading}
                                expectedValue={expectedValue}
                                description={description}
                                isSecret={effectiveIsSecret}
                                secretOverride={envVar.isSecret}
                                autoSecret={autoSecret}
                                isForcedSensitive={forcedSecret}
                                sourceRequirement={requirementVarName ? (sourceRequirementsByName[requirementVarName] ?? null) : null}
                                onUpdateSourceRequirement={onUpdateSourceRequirement}
                                defaultSecretNameForSourceVar={requirementVarName ? getDefaultSecretNameForSourceVar(requirementVarName) : null}
                                onPickDefaultSecretForSourceVar={onPickDefaultSecretForSourceVar}
                                onUpdateSecretOverride={handleUpdateSecretOverride}
                                onUpdate={handleUpdateVariable}
                                onDelete={handleDeleteVariable}
                                onDuplicate={handleDuplicateVariable}
                            />
                        );
                    })}
                </View>
            )}

            <View style={styles.addContainer}>
                <InlineAddExpander
                    isOpen={isAddExpanded}
                    onOpenChange={setIsAddExpanded}
                    title={t('profiles.environmentVariables.addVariable')}
                    icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.button.secondary.tint} />}
                    onCancel={resetAddDraft}
                    onSave={handleAddVariable}
                    saveDisabled={!newVarName.trim()}
                    cancelLabel={t('common.cancel')}
                    saveLabel={t('common.save')}
                    autoFocusRef={nameInputRef}
                >
                    <Text style={styles.fieldLabel}>
                        {t('secrets.fields.name')}
                    </Text>
                    <View style={styles.addInputRow}>
                        <TextInput
                            ref={nameInputRef}
                            style={styles.addTextInput}
                            placeholder={t('profiles.environmentVariables.namePlaceholder')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={newVarName}
                            onChangeText={(text) => setNewVarName(text.toUpperCase())}
                            autoCapitalize="characters"
                            autoCorrect={false}
                        />
                    </View>

                    <Text style={styles.fieldLabel}>
                        {t('secrets.fields.value')}
                    </Text>
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
                </InlineAddExpander>
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
        // Intentionally unused: each EnvironmentVariableCard is an ItemGroup
        // and provides its own consistent horizontal margins.
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
    fieldLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.groupped.sectionTitle,
        marginBottom: 8,
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
}));
