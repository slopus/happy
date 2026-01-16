import React from 'react';
import { View, Text, TextInput, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Switch } from '@/components/Switch';
import { formatEnvVarTemplate, parseEnvVarTemplate, type EnvVarTemplateOperator } from '@/utils/envVarTemplate';
import { t } from '@/text';

export interface EnvironmentVariableCardProps {
    variable: { name: string; value: string };
    index: number;
    machineId: string | null;
    machineName?: string | null;
    machineEnv?: Record<string, string | null>;
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
    isMachineEnvLoading = false,
    expectedValue,
    description,
    isSecret = false,
    onUpdate,
    onDelete,
    onDuplicate,
}: EnvironmentVariableCardProps) {
    const { theme } = useUnistyles();

    const webNoOutline = React.useMemo(() => (Platform.select({
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
    }) as object), []);

    const secondaryTextStyle = React.useMemo(() => ({
        fontSize: Platform.select({ ios: 15, default: 14 }),
        lineHeight: 20,
        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
        ...Typography.default(),
    }), []);

    const remoteToggleLabelStyle = React.useMemo(() => ({
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: 20,
        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
        ...Typography.default(),
    }), []);

    // Parse current value
    const parsed = parseVariableValue(variable.value);
    const [useRemoteVariable, setUseRemoteVariable] = React.useState(parsed.useRemoteVariable);
    const [remoteVariableName, setRemoteVariableName] = React.useState(parsed.remoteVariableName);
    const [defaultValue, setDefaultValue] = React.useState(parsed.defaultValue);
    const fallbackOperator = parsed.fallbackOperator;

    const remoteValue = machineEnv?.[remoteVariableName];
    const hasFallback = defaultValue.trim() !== '';
    const machineLabel = machineName?.trim() ? machineName.trim() : t('common.machine');

    const emptyValue = t('profiles.environmentVariables.preview.emptyValue');

    // Update parent when local state changes
    React.useEffect(() => {
        const newValue = useRemoteVariable && remoteVariableName.trim() !== ''
            ? formatEnvVarTemplate({ sourceVar: remoteVariableName, fallback: defaultValue, operator: fallbackOperator })
            : defaultValue;

        if (newValue !== variable.value) {
            onUpdate(index, newValue);
        }
    }, [defaultValue, fallbackOperator, index, onUpdate, remoteVariableName, useRemoteVariable, variable.value]);

    // Determine status
    const showRemoteDiffersWarning = remoteValue !== null && expectedValue && remoteValue !== expectedValue;
    const showDefaultOverrideWarning = expectedValue && defaultValue !== expectedValue;

    const computedTemplateValue =
        useRemoteVariable && remoteVariableName.trim() !== ''
            ? formatEnvVarTemplate({ sourceVar: remoteVariableName, fallback: defaultValue, operator: fallbackOperator })
            : defaultValue;

    const resolvedSessionValue =
        isSecret
            ? (useRemoteVariable && remoteVariableName
                ? t('profiles.environmentVariables.preview.secretValueHidden', {
                    value: formatEnvVarTemplate({ sourceVar: remoteVariableName, fallback: defaultValue !== '' ? '***' : '', operator: fallbackOperator }),
                })
            : (defaultValue ? t('profiles.environmentVariables.preview.hiddenValue') : emptyValue))
            : (useRemoteVariable && machineId && remoteValue !== undefined
                ? (remoteValue === null || remoteValue === '' ? (hasFallback ? defaultValue : emptyValue) : remoteValue)
                : (computedTemplateValue || emptyValue));

    return (
        <View style={{
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
        }}>
            {/* Header row with variable name and action buttons */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <Text style={{
                    fontSize: Platform.select({ ios: 17, default: 16 }),
                    lineHeight: Platform.select({ ios: 22, default: 24 }),
                    letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
                    color: theme.colors.text,
                    ...Typography.default('semiBold')
                }}>
                    {variable.name}
                    {isSecret && (
                        <Ionicons name="lock-closed" size={theme.iconSize.small} color={theme.colors.textDestructive} style={{ marginLeft: 4 }} />
                    )}
                </Text>

                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.margins.md }}>
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
                <Text style={{
                    color: theme.colors.textSecondary,
                    marginBottom: 8,
                    ...secondaryTextStyle,
                }}>
                    {description}
                </Text>
            )}

            {/* Value label */}
            <Text style={{
                color: theme.colors.textSecondary,
                marginBottom: 4,
                ...secondaryTextStyle,
            }}>
                {useRemoteVariable ? t('profiles.environmentVariables.card.fallbackValueLabel') : t('profiles.environmentVariables.card.valueLabel')}
            </Text>

            {/* Value input */}
            <TextInput
                style={{
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
                    ...webNoOutline,
                }}
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
            {isSecret && (
                <Text style={{
                    color: theme.colors.textSecondary,
                    marginBottom: 8,
                    fontStyle: 'italic',
                    ...secondaryTextStyle,
                }}>
                    {t('profiles.environmentVariables.card.secretNotRetrieved')}
                </Text>
            )}

            {/* Default override warning */}
            {showDefaultOverrideWarning && !isSecret && (
                <Text style={{
                    color: theme.colors.textSecondary,
                    marginBottom: 8,
                    ...secondaryTextStyle,
                }}>
                    {t('profiles.environmentVariables.card.overridingDefault', { expectedValue })}
                </Text>
            )}

            <View style={{
                height: 1,
                backgroundColor: theme.colors.divider,
                marginVertical: 12,
            }} />

            {/* Toggle: Use value from machine environment */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <Text style={{
                    flex: 1,
                    color: theme.colors.textSecondary,
                    ...remoteToggleLabelStyle,
                }}>
                    {t('profiles.environmentVariables.card.useMachineEnvToggle')}
                </Text>
                <Switch
                    value={useRemoteVariable}
                    onValueChange={setUseRemoteVariable}
                />
            </View>

            <Text style={{
                color: theme.colors.textSecondary,
                marginBottom: useRemoteVariable ? 10 : 0,
                ...secondaryTextStyle,
            }}>
                {t('profiles.environmentVariables.card.resolvedOnSessionStart')}
            </Text>

            {/* Source variable name input (only when enabled) */}
            {useRemoteVariable && (
                <>
                    <Text style={{
                        color: theme.colors.textSecondary,
                        marginBottom: 4,
                        ...secondaryTextStyle,
                    }}>
                        {t('profiles.environmentVariables.card.sourceVariableLabel')}
                    </Text>

                    <TextInput
                        style={{
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
                            ...webNoOutline,
                        }}
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
                <View style={{ marginBottom: 8 }}>
                    {isMachineEnvLoading || remoteValue === undefined ? (
                        <Text style={{
                            color: theme.colors.textSecondary,
                            fontStyle: 'italic',
                            ...secondaryTextStyle,
                        }}>
                            {t('profiles.environmentVariables.card.checkingMachine', { machine: machineLabel })}
                        </Text>
                    ) : (remoteValue === null || remoteValue === '') ? (
                        <Text style={{
                            color: theme.colors.warning,
                            ...secondaryTextStyle,
                        }}>
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
                            <Text style={{
                                color: theme.colors.success,
                                ...secondaryTextStyle,
                            }}>
                                {t('profiles.environmentVariables.card.valueFoundOnMachine', { machine: machineLabel })}
                            </Text>
                            {showRemoteDiffersWarning && (
                                <Text style={{
                                    color: theme.colors.textSecondary,
                                    marginTop: 2,
                                    ...secondaryTextStyle,
                                }}>
                                    {t('profiles.environmentVariables.card.differsFromDocumented', { expectedValue })}
                                </Text>
                            )}
                        </>
                    )}
                </View>
            )}

            {/* Session preview */}
            <Text style={{
                color: theme.colors.textSecondary,
                marginTop: 4,
                ...secondaryTextStyle,
            }}>
                {t('profiles.environmentVariables.preview.sessionWillReceive', {
                    name: variable.name,
                    value: resolvedSessionValue,
                })}
            </Text>
        </View>
    );
}
