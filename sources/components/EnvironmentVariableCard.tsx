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
    variable: { name: string; value: string };
    index: number;
    machineId: string | null;
    machineName?: string | null;
    machineEnv?: Record<string, PreviewEnvValue>;
    machineEnvPolicy?: EnvPreviewSecretsPolicy | null;
    isMachineEnvLoading?: boolean;
    expectedValue?: string;  // From profile documentation
    description?: string;    // Variable description
    isSecret?: boolean;      // Whether this is a secret (never query remote)
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

    const remoteEntry = remoteVariableName ? machineEnv?.[remoteVariableName] : undefined;
    const remoteValue = remoteEntry?.value;
    const hasFallback = defaultValue.trim() !== '';
    const computedOperator: EnvVarTemplateOperator | null = hasFallback ? (fallbackOperator ?? ':-') : null;
    const machineLabel = machineName?.trim() ? machineName.trim() : t('common.machine');

    const emptyValue = t('profiles.environmentVariables.preview.emptyValue');

    // Update parent when local state changes
    React.useEffect(() => {
        const newValue = useRemoteVariable && remoteVariableName.trim() !== ''
            ? formatEnvVarTemplate({ sourceVar: remoteVariableName, fallback: defaultValue, operator: computedOperator })
            : defaultValue;

        if (newValue !== variable.value) {
            onUpdate(index, newValue);
        }
    }, [computedOperator, defaultValue, index, onUpdate, remoteVariableName, useRemoteVariable, variable.value]);

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
        if (isSecret) {
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
                    {isSecret && (
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
                {useRemoteVariable ? t('profiles.environmentVariables.card.fallbackValueLabel') : t('profiles.environmentVariables.card.valueLabel')}
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
                secureTextEntry={isSecret}
            />

            {/* Security message for secrets */}
            {isSecret && (machineEnvPolicy === null || machineEnvPolicy === 'none') && (
                <Text style={[styles.secondaryText, styles.secretMessage]}>
                    {t('profiles.environmentVariables.card.secretNotRetrieved')}
                </Text>
            )}

            {/* Default override warning */}
            {showDefaultOverrideWarning && !isSecret && (
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
            {useRemoteVariable && !isSecret && machineId && remoteVariableName.trim() !== '' && (
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
        color: theme.colors.textSecondary,
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
