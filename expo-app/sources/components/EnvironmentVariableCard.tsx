import React from 'react';
import { View, Text, TextInput, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Switch } from '@/components/Switch';
import { formatEnvVarTemplate, parseEnvVarTemplate, type EnvVarTemplateOperator } from '@/utils/envVarTemplate';
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

    return (
        <View style={styles.container}>
            {/* Header row with variable name and action buttons */}
            <View style={styles.headerRow}>
                <Text style={styles.nameText}>
                    {variable.name}
                    {hideValueInUi && (
                        <Ionicons
                            name="lock-closed"
                            size={theme.iconSize.small}
                            color={theme.colors.textDestructive}
                            style={styles.lockIcon}
                        />
                    )}
                </Text>

                <View style={styles.actionRow}>
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
            </View>

            {/* Description */}
            {description && (
                <Text style={[styles.secondaryText, styles.descriptionText]}>
                    {description}
                </Text>
            )}

            {/* Value label */}
            <Text style={[styles.secondaryText, styles.labelText]}>
                {(useRemoteVariable
                    ? t('profiles.environmentVariables.card.fallbackValueLabel')
                    : t('profiles.environmentVariables.card.valueLabel')
                ).replace(/:$/, '')}
            </Text>

            {/* Value input */}
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

            {useSecretVault ? (
                <Text style={[styles.secondaryText, { marginTop: 6 }]}>
                    {t('profiles.environmentVariables.card.fallbackDisabledForVault')}
                </Text>
            ) : null}

            <View style={styles.secretRow}>
                <View style={styles.secretRowLeft}>
                    <Text style={[styles.toggleLabelText, styles.secretLabel]}>
                        {t('profiles.environmentVariables.card.secretToggleLabel')}
                    </Text>
                    <Text style={[styles.secondaryText, styles.secretSubtitleText]}>
                        {isForcedSensitive
                            ? t('profiles.environmentVariables.card.secretToggleEnforcedByDaemon')
                            : useSecretVault
                                ? t('profiles.environmentVariables.card.secretToggleEnforcedByVault')
                                : t('profiles.environmentVariables.card.secretToggleSubtitle')}
                    </Text>
                </View>
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
            </View>

            {/* Security message for secrets */}
            {hideValueInUi && (machineEnvPolicy === null || machineEnvPolicy === 'none') && (
                <Text style={[styles.secondaryText, styles.secretMessage]}>
                    {t('profiles.environmentVariables.card.secretNotRetrieved')}
                </Text>
            )}

            {/* Default override warning */}
            {showDefaultOverrideWarning && !hideValueInUi && (
                <Text style={[styles.secondaryText, styles.defaultOverrideWarning]}>
                    {t('profiles.environmentVariables.card.overridingDefault', { expectedValue })}
                </Text>
            )}

            <View style={styles.divider} />

            {/* Toggle: Use value from machine environment */}
            <View style={styles.toggleRow}>
                <Text style={[styles.toggleLabelText, styles.toggleLabel]}>
                    {t('profiles.environmentVariables.card.useMachineEnvToggle')}
                </Text>
                <Switch
                    value={useRemoteVariable}
                    onValueChange={setUseRemoteVariable}
                />
            </View>

            <Text
                style={[
                    styles.secondaryText,
                    styles.resolvedOnStartText,
                    useRemoteVariable && styles.resolvedOnStartWithRemote,
                ]}
            >
                {t('profiles.environmentVariables.card.resolvedOnSessionStart')}
            </Text>

            {/* Requirements (independent of "use machine env") */}
            {hasRequirementVarName ? (
                <>
                    <View style={styles.toggleRow}>
                        <Text style={[styles.toggleLabelText, styles.toggleLabel]}>
                            {t('profiles.environmentVariables.card.requirementRequiredLabel')}
                        </Text>
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
                    </View>
                    <Text style={[styles.secondaryText, styles.resolvedOnStartText]}>
                        {t('profiles.environmentVariables.card.requirementRequiredSubtitle')}
                    </Text>

                    <View style={styles.toggleRow}>
                        <Text style={[styles.toggleLabelText, styles.toggleLabel]}>
                            {t('profiles.environmentVariables.card.requirementUseVaultLabel')}
                        </Text>
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
                    </View>
                    <Text style={[styles.secondaryText, styles.resolvedOnStartText]}>
                        {t('profiles.environmentVariables.card.requirementUseVaultSubtitle')}
                    </Text>

                    {Boolean(effectiveSourceRequirement?.useSecretVault) ? (
                        <Pressable
                            onPress={() => onPickDefaultSecretForSourceVar?.(requirementVarName)}
                            style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
                        >
                            <View style={styles.toggleRow}>
                                <Text style={[styles.toggleLabelText, styles.toggleLabel]}>
                                    {t('profiles.environmentVariables.card.defaultSecretLabel')}
                                </Text>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                    <Text style={[styles.secondaryText, { marginTop: 0 }]}>
                                        {defaultSecretNameForSourceVar ?? t('secrets.noneTitle')}
                                    </Text>
                                    <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
                                </View>
                            </View>
                        </Pressable>
                    ) : null}
                </>
            ) : null}

            {/* Source variable name input (only when enabled) */}
            {useRemoteVariable && (
                <>
                    <Text style={[styles.secondaryText, styles.sourceLabel]}>
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
                </>
            )}

            {/* Machine environment status (only with machine context) */}
            {useRemoteVariable && !hideValueInUi && machineId && remoteVariableName.trim() !== '' && (
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

            {/* Session preview */}
            <Text style={[styles.secondaryText, styles.sessionPreview]}>
                {t('profiles.environmentVariables.preview.sessionWillReceive', {
                    name: variable.name,
                    value: resolvedSessionValue ?? emptyValue,
                })}
            </Text>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        padding: 16,
        marginBottom: 12,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 0.33 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 0,
        elevation: 1,
    },
    headerRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 4,
    },
    nameText: {
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    lockIcon: {
        marginLeft: 4,
    },
    secretRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 8,
        marginBottom: 4,
    },
    secretRowLeft: {
        flex: 1,
        paddingRight: 10,
    },
    secretLabel: {
        color: theme.colors.textSecondary,
    },
    secretSubtitleText: {
        marginTop: 2,
        color: theme.colors.textSecondary,
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
    actionRow: {
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
    descriptionText: {
        color: theme.colors.textSecondary,
        marginBottom: 8,
    },
    labelText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.groupped.sectionTitle,
        marginBottom: 4,
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
        marginBottom: 4,
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
    secretMessage: {
        color: theme.colors.textSecondary,
        marginBottom: 8,
        fontStyle: 'italic',
    },
    defaultOverrideWarning: {
        color: theme.colors.textSecondary,
        marginBottom: 8,
    },
    divider: {
        height: 1,
        backgroundColor: theme.colors.divider,
        marginVertical: 12,
    },
    toggleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 6,
    },
    toggleLabelText: {
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: 20,
        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
        ...Typography.default(),
    },
    toggleLabel: {
        flex: 1,
        color: theme.colors.textSecondary,
    },
    resolvedOnStartText: {
        color: theme.colors.textSecondary,
        marginBottom: 0,
    },
    resolvedOnStartWithRemote: {
        marginBottom: 10,
    },
    sourceLabel: {
        color: theme.colors.textSecondary,
        marginBottom: 4,
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
        marginBottom: 6,
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
    machineStatusContainer: {
        marginBottom: 8,
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
        marginTop: 4,
    },
}));
