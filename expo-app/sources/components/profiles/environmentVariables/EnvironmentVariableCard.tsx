import React from 'react';
import { View, Text, TextInput, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Switch } from '@/components/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { formatEnvVarTemplate, parseEnvVarTemplate, type EnvVarTemplateOperator } from '@/utils/profiles/envVarTemplate';
import { t } from '@/text';
import type { EnvPreviewSecretsPolicy, PreviewEnvValue } from '@/sync/ops';

export interface EnvironmentVariableCardProps {
    variable: { name: string; value: string; isSecret?: boolean };
    index: number;
    machineId: string | null;
    machineName?: string | null;
    machineEnv?: Record<string, PreviewEnvValue>;
    machineEnvPolicy?: EnvPreviewSecretsPolicy | null;
    isMachineEnvLoading?: boolean;
    expectedValue?: string;  // From profile documentation
    description?: string;    // Variable description
    isSecret?: boolean;      // Whether this is a secret (never query remote)
    secretOverride?: boolean; // user override (true/false) or undefined for auto
    autoSecret?: boolean;     // UI auto classification (docs + heuristic)
    isForcedSensitive?: boolean; // daemon-enforced sensitivity
    sourceRequirement?: { required: boolean; useSecretVault: boolean } | null;
    onUpdateSourceRequirement?: (
        sourceVarName: string,
        next: { required: boolean; useSecretVault: boolean } | null
    ) => void;
    defaultSecretNameForSourceVar?: string | null;
    onPickDefaultSecretForSourceVar?: (sourceVarName: string) => void;
    onUpdateSecretOverride?: (index: number, isSecret: boolean | undefined) => void;
    onUpdate: (index: number, newValue: string) => void;
    onDelete: (index: number) => void;
    onDuplicate: (index: number) => void;
}

/**
 * Parse environment variable value to determine configuration
 */
function parseVariableValue(value: string): {
    useRemoteVariable: boolean;
    remoteVariableName: string;
    defaultValue: string;
    fallbackOperator: EnvVarTemplateOperator | null;
} {
    const parsedTemplate = parseEnvVarTemplate(value);
    if (parsedTemplate) {
        return {
            useRemoteVariable: true,
            remoteVariableName: parsedTemplate.sourceVar,
            defaultValue: parsedTemplate.fallback,
            fallbackOperator: parsedTemplate.operator,
        };
    }

    // Literal value (no template)
    return {
        useRemoteVariable: false,
        remoteVariableName: '',
        defaultValue: value,
        fallbackOperator: null,
    };
}

/**
 * Single environment variable card component
 * Matches profile list pattern from index.tsx:1163-1217
 */
export function EnvironmentVariableCard({
    variable,
    index,
    machineId,
    machineName,
    machineEnv,
    machineEnvPolicy = null,
    isMachineEnvLoading = false,
    expectedValue,
    description,
    isSecret = false,
    secretOverride,
    autoSecret = false,
    isForcedSensitive = false,
    sourceRequirement = null,
    onUpdateSourceRequirement,
    defaultSecretNameForSourceVar = null,
    onPickDefaultSecretForSourceVar,
    onUpdateSecretOverride,
    onUpdate,
    onDelete,
    onDuplicate,
}: EnvironmentVariableCardProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    // Parse current value
    const parsed = React.useMemo(() => parseVariableValue(variable.value), [variable.value]);
    const [useRemoteVariable, setUseRemoteVariable] = React.useState(parsed.useRemoteVariable);
    const [remoteVariableName, setRemoteVariableName] = React.useState(parsed.remoteVariableName);
    const [defaultValue, setDefaultValue] = React.useState(parsed.defaultValue);
    const fallbackOperator = parsed.fallbackOperator;

    React.useEffect(() => {
        setUseRemoteVariable(parsed.useRemoteVariable);
        setRemoteVariableName(parsed.remoteVariableName);
        setDefaultValue(parsed.defaultValue);
    }, [parsed.defaultValue, parsed.remoteVariableName, parsed.useRemoteVariable]);

    /**
     * The requirement key is the env var name that is actually *required/resolved* at session start.
     *
     * If the value is a template (e.g. `${SOURCE_VAR}`), then the requirement applies to `SOURCE_VAR`
     * (not necessarily `variable.name`) because that's what the daemon will read from the machine env.
     */
    const requirementVarName = React.useMemo(() => {
        if (parsed.useRemoteVariable) {
            const name = parsed.remoteVariableName.trim().toUpperCase();
            return name.length > 0 ? name : variable.name.trim().toUpperCase();
        }
        return variable.name.trim().toUpperCase();
    }, [parsed.remoteVariableName, parsed.useRemoteVariable, variable.name]);

    const hasRequirementVarName = requirementVarName.length > 0;
    const effectiveSourceRequirement = hasRequirementVarName
        ? (sourceRequirement ?? { required: false, useSecretVault: false })
        : null;
    const useSecretVault = Boolean(effectiveSourceRequirement?.useSecretVault);
    const hideValueInUi = Boolean(isSecret) || useSecretVault;

    // Vault-enforced secrets must not persist plaintext or fallbacks.
    React.useEffect(() => {
        if (!useSecretVault) return;
        if (defaultValue.trim() !== '') {
            setDefaultValue('');
        }
    }, [defaultValue, useSecretVault]);

    // If the user opts into the secret vault, we must enforce hiding the value in the UI.
    // This is treated similarly to daemon-enforced sensitivity: the user cannot disable it while vault is enabled.
    React.useEffect(() => {
        if (!useSecretVault) return;
        if (!onUpdateSecretOverride) return;
        if (isForcedSensitive) return;
        if (Boolean(isSecret) === true) return;
        onUpdateSecretOverride(index, true);
    }, [index, isForcedSensitive, isSecret, onUpdateSecretOverride, useSecretVault]);

    const remoteEntry = remoteVariableName ? machineEnv?.[remoteVariableName] : undefined;
    const remoteValue = remoteEntry?.value;
    const hasFallback = defaultValue.trim() !== '';
    const computedOperator: EnvVarTemplateOperator | null = useSecretVault
        ? null
        : (hasFallback ? (fallbackOperator ?? ':-') : null);
    const machineLabel = machineName?.trim() ? machineName.trim() : t('common.machine');

    const emptyValue = t('profiles.environmentVariables.preview.emptyValue');

    const canEditSecret = Boolean(onUpdateSecretOverride) && !isForcedSensitive && !useSecretVault;
    const showResetToAuto = canEditSecret && secretOverride !== undefined;

    // Update parent when local state changes
    React.useEffect(() => {
        // Important UX: when "use machine env" is enabled, allow the user to clear/edit the
        // source variable name without implicitly disabling the mode or overwriting the stored
        // template value. Only persist when source var is non-empty.
        if (useRemoteVariable && remoteVariableName.trim() === '') {
            return;
        }

        const newValue = useRemoteVariable
            ? formatEnvVarTemplate({ sourceVar: remoteVariableName, fallback: defaultValue, operator: computedOperator })
            : defaultValue;

        if (newValue !== variable.value) {
            onUpdate(index, newValue);
        }
    }, [computedOperator, defaultValue, index, onUpdate, remoteVariableName, useRemoteVariable, useSecretVault, variable.value]);

    // Determine status
    const showRemoteDiffersWarning = remoteValue !== null && expectedValue && remoteValue !== expectedValue;
    const showDefaultOverrideWarning = expectedValue && defaultValue !== expectedValue;

    const computedTemplateValue =
        useRemoteVariable && remoteVariableName.trim() !== ''
            ? formatEnvVarTemplate({ sourceVar: remoteVariableName, fallback: defaultValue, operator: computedOperator })
            : defaultValue;

    const targetEntry = machineEnv?.[variable.name];
    const resolvedSessionValue = (() => {
        // Prefer daemon-computed effective value for the target env var (matches spawn exactly).
        if (machineId && targetEntry) {
            if (targetEntry.display === 'full' || targetEntry.display === 'redacted') {
                return targetEntry.value ?? emptyValue;
            }
            if (targetEntry.display === 'hidden') {
                return t('profiles.environmentVariables.preview.hiddenValue');
            }
            return emptyValue; // unset
        }

        // Fallback (no machine context / older daemon): best-effort preview.
        if (hideValueInUi) {
            // If daemon policy is known and allows showing secrets, targetEntry would have handled it above.
            // Otherwise, keep secrets hidden in UI.
            if (useRemoteVariable && remoteVariableName) {
                return t('profiles.environmentVariables.preview.secretValueHidden', {
                    value: formatEnvVarTemplate({
                        sourceVar: remoteVariableName,
                        fallback: defaultValue !== '' ? '***' : '',
                        operator: computedOperator,
                    }),
                });
            }
            return defaultValue ? t('profiles.environmentVariables.preview.hiddenValue') : emptyValue;
        }

        if (useRemoteVariable && machineId && remoteEntry !== undefined) {
            // Note: remoteEntry may be hidden/redacted by daemon policy. We do NOT treat hidden as missing.
            if (remoteEntry.display === 'hidden') return t('profiles.environmentVariables.preview.hiddenValue');
            if (remoteEntry.display === 'unset' || remoteValue === null || remoteValue === '') {
                return hasFallback ? defaultValue : emptyValue;
            }
            return remoteValue;
        }

        return computedTemplateValue || emptyValue;
    })();

    const valueRowTitle = (useRemoteVariable
        ? t('profiles.environmentVariables.card.fallbackValueLabel')
        : t('profiles.environmentVariables.card.valueLabel')
    ).replace(/:$/, '');

    const valueRowSubtitle = !useSecretVault ? (
        <View style={styles.valueRowContent}>
            <TextInput
                style={styles.valueInput}
                placeholder={
                    expectedValue ||
                    (useRemoteVariable
                        ? t('profiles.environmentVariables.card.defaultValueInputPlaceholder')
                        : t('profiles.environmentVariables.card.valueInputPlaceholder'))
                }
                placeholderTextColor={theme.colors.input.placeholder}
                value={defaultValue}
                onChangeText={setDefaultValue}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry={hideValueInUi}
                editable={!useSecretVault}
                selectTextOnFocus={!useSecretVault}
            />

            {hideValueInUi && (machineEnvPolicy === null || machineEnvPolicy === 'none') && (
                <Text style={[styles.secondaryText, styles.helperText, styles.helperTextItalic]}>
                    {t('profiles.environmentVariables.card.secretNotRetrieved')}
                </Text>
            )}

            {showDefaultOverrideWarning && !hideValueInUi && (
                <Text style={[styles.secondaryText, styles.helperText]}>
                    {t('profiles.environmentVariables.card.overridingDefault', { expectedValue })}
                </Text>
            )}
        </View>
    ) : (Boolean(effectiveSourceRequirement?.useSecretVault) ? (
        <Pressable
            onPress={() => onPickDefaultSecretForSourceVar?.(requirementVarName)}
            style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
        >
            <View style={styles.valueRowContent}>
                <View style={styles.vaultRow}>
                    <Text style={[styles.secondaryText, styles.vaultRowLabel]}>
                        {t('profiles.environmentVariables.card.defaultSecretLabel')}
                    </Text>
                    <View style={styles.vaultRowRight}>
                        <Text style={[styles.secondaryText, styles.vaultRowValue]}>
                            {defaultSecretNameForSourceVar ?? t('secrets.noneTitle')}
                        </Text>
                        <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
                    </View>
                </View>
            </View>
        </Pressable>
    ) : null);

    const machineEnvRowSubtitle = (
        <View style={styles.sectionContent}>
            <Text style={[styles.secondaryText, styles.helperText]}>
                {t('profiles.environmentVariables.card.resolvedOnSessionStart')}
            </Text>

            {useRemoteVariable && (
                <>
                    <Text style={[styles.secondaryText, styles.fieldLabel]}>
                        {t('profiles.environmentVariables.card.sourceVariableLabel')}
                    </Text>
                    <TextInput
                        style={styles.sourceInput}
                        placeholder={t('profiles.environmentVariables.card.sourceVariablePlaceholder')}
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={remoteVariableName}
                        onChangeText={(text) => setRemoteVariableName(text.toUpperCase())}
                        autoCapitalize="characters"
                        autoCorrect={false}
                    />

                    {(!hideValueInUi && machineId && remoteVariableName.trim() !== '') && (
                        <View style={styles.machineStatusContainer}>
                            {isMachineEnvLoading || remoteEntry === undefined ? (
                                <Text style={[styles.secondaryText, styles.machineStatusLoading]}>
                                    {t('profiles.environmentVariables.card.checkingMachine', { machine: machineLabel })}
                                </Text>
                            ) : (remoteEntry.display === 'unset' || remoteValue === null || remoteValue === '') ? (
                                <Text style={[styles.secondaryText, styles.machineStatusWarning]}>
                                    {remoteValue === '' ? (
                                        hasFallback
                                            ? t('profiles.environmentVariables.card.emptyOnMachineUsingFallback', { machine: machineLabel })
                                            : t('profiles.environmentVariables.card.emptyOnMachine', { machine: machineLabel })
                                    ) : (
                                        hasFallback
                                            ? t('profiles.environmentVariables.card.notFoundOnMachineUsingFallback', { machine: machineLabel })
                                            : t('profiles.environmentVariables.card.notFoundOnMachine', { machine: machineLabel })
                                    )}
                                </Text>
                            ) : (
                                <>
                                    <Text style={[styles.secondaryText, styles.machineStatusSuccess]}>
                                        {t('profiles.environmentVariables.card.valueFoundOnMachine', { machine: machineLabel })}
                                    </Text>
                                    {showRemoteDiffersWarning && (
                                        <Text style={[styles.secondaryText, styles.machineStatusDiffers]}>
                                            {t('profiles.environmentVariables.card.differsFromDocumented', { expectedValue })}
                                        </Text>
                                    )}
                                </>
                            )}
                        </View>
                    )}
                </>
            )}

            <Text style={[styles.secondaryText, styles.sessionPreview]}>
                {t('profiles.environmentVariables.preview.sessionWillReceive', {
                    name: variable.name,
                    value: resolvedSessionValue ?? emptyValue,
                })}
            </Text>
        </View>
    );

    const secretRowSubtitle = (
        isForcedSensitive
            ? t('profiles.environmentVariables.card.secretToggleEnforcedByDaemon')
            : useSecretVault
                ? t('profiles.environmentVariables.card.secretToggleEnforcedByVault')
                : t('profiles.environmentVariables.card.secretToggleSubtitle')
    );

    return (
        <ItemGroup
            // Hide the ItemGroup header spacing: this card renders its own "title row" as the first Item.
            title={<View />}
            headerStyle={styles.hiddenHeader}
            style={styles.groupWrapper}
            containerStyle={styles.groupContainer}
        >
            <Item
                title={variable.name}
                subtitle={description}
                showChevron={false}
                rightElement={(
                    <View style={styles.titleRowActions}>
                        {hideValueInUi && (
                            <Ionicons
                                name="lock-closed"
                                size={theme.iconSize.small}
                                color={theme.colors.textDestructive}
                            />
                        )}
                        <Pressable
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                            onPress={() => onDelete(index)}
                        >
                            <Ionicons name="trash-outline" size={theme.iconSize.large} color={theme.colors.deleteAction} />
                        </Pressable>
                        <Pressable
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                            onPress={() => onDuplicate(index)}
                        >
                            <Ionicons name="copy-outline" size={theme.iconSize.large} color={theme.colors.button.secondary.tint} />
                        </Pressable>
                    </View>
                )}
            />

            <Item
                title={valueRowTitle}
                subtitle={valueRowSubtitle}
                showChevron={false}
            />

            <Item
                title={t('profiles.environmentVariables.card.useMachineEnvToggle')}
                subtitle={machineEnvRowSubtitle}
                showChevron={false}
                rightElement={(
                    <Switch
                        value={useRemoteVariable}
                        onValueChange={setUseRemoteVariable}
                    />
                )}
            />

            <Item
                title={t('profiles.environmentVariables.card.secretToggleLabel')}
                subtitle={secretRowSubtitle}
                showChevron={false}
                rightElement={(
                    <View style={styles.secretRowRight}>
                        {showResetToAuto && (
                            <Pressable
                                onPress={() => onUpdateSecretOverride?.(index, undefined)}
                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                            >
                                <Text style={styles.resetToAutoText}>
                                    {t('profiles.environmentVariables.card.secretToggleResetToAuto')}
                                </Text>
                            </Pressable>
                        )}
                        <Switch
                            value={hideValueInUi}
                            onValueChange={(next) => {
                                if (!canEditSecret) return;
                                onUpdateSecretOverride?.(index, next);
                            }}
                            disabled={!canEditSecret}
                        />
                    </View>
                )}
            />

            {hasRequirementVarName ? (
                <>
                    <Item
                        title={t('profiles.environmentVariables.card.requirementRequiredLabel')}
                        subtitle={t('profiles.environmentVariables.card.requirementRequiredSubtitle')}
                        showChevron={false}
                        rightElement={(
                            <Switch
                                value={Boolean(effectiveSourceRequirement?.required)}
                                onValueChange={(next) => {
                                    if (!onUpdateSourceRequirement) return;
                                    onUpdateSourceRequirement(requirementVarName, {
                                        required: next,
                                        useSecretVault: Boolean(effectiveSourceRequirement?.useSecretVault),
                                    });
                                }}
                            />
                        )}
                    />
                    <Item
                        title={t('profiles.environmentVariables.card.requirementUseVaultLabel')}
                        subtitle={t('profiles.environmentVariables.card.requirementUseVaultSubtitle')}
                        showChevron={false}
                        rightElement={(
                            <Switch
                                value={Boolean(effectiveSourceRequirement?.useSecretVault)}
                                onValueChange={(next) => {
                                    if (!onUpdateSourceRequirement) return;
                                    const prevRequired = Boolean(effectiveSourceRequirement?.required);
                                    onUpdateSourceRequirement(requirementVarName, {
                                        required: next ? (prevRequired || true) : prevRequired,
                                        useSecretVault: next,
                                    });
                                }}
                            />
                        )}
                    />
                </>
            ) : null}
        </ItemGroup>
    );
}


const stylesheet = StyleSheet.create((theme) => ({
    groupWrapper: {
        // The card spacing between env vars should match other grouped settings lists.
        marginBottom: 12,
    },
    hiddenHeader: {
        paddingTop: 0,
        paddingBottom: 0,
        paddingHorizontal: 0,
        height: 0,
        overflow: 'hidden',
    },
    groupContainer: {
        // Avoid double horizontal margins: the list should not add its own margin.
        marginHorizontal: 0,
    },
    secretRowRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    resetToAutoText: {
        color: theme.colors.button.secondary.tint,
        fontSize: Platform.select({ ios: 13, default: 12 }),
        ...Typography.default('semiBold'),
    },
    titleRowActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.md,
    },
    secondaryText: {
        fontSize: Platform.select({ ios: 15, default: 14 }),
        lineHeight: 20,
        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
        ...Typography.default(),
    },
    valueInput: {
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
    sectionContent: {
        marginTop: 4,
    },
    helperText: {
        color: theme.colors.textSecondary,
    },
    helperTextItalic: {
        fontStyle: 'italic',
    },
    fieldLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.groupped.sectionTitle,
        marginTop: 10,
        marginBottom: 6,
    },
    sourceInput: {
        ...Typography.default('regular'),
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ ios: 10, default: 12 }),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
        color: theme.colors.input.text,
        marginBottom: 2,
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
    valueRowContent: {
        marginTop: 8,
    },
    vaultRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    vaultRowLabel: {
        color: theme.colors.textSecondary,
        flex: 1,
    },
    vaultRowRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    vaultRowValue: {
        color: theme.colors.textSecondary,
    },
    machineStatusContainer: {
        marginTop: 8,
    },
    machineStatusLoading: {
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
    },
    machineStatusWarning: {
        color: theme.colors.warning,
    },
    machineStatusSuccess: {
        color: theme.colors.success,
    },
    machineStatusDiffers: {
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    sessionPreview: {
        color: theme.colors.textSecondary,
        marginTop: 10,
    },
}));
