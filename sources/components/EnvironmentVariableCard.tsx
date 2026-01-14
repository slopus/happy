import React from 'react';
import { View, Text, TextInput, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useEnvironmentVariables } from '@/hooks/useEnvironmentVariables';
import { Switch } from '@/components/Switch';

export interface EnvironmentVariableCardProps {
    variable: { name: string; value: string };
    machineId: string | null;
    expectedValue?: string;  // From profile documentation
    description?: string;    // Variable description
    isSecret?: boolean;      // Whether this is a secret (never query remote)
    onUpdate: (newValue: string) => void;
    onDelete: () => void;
    onDuplicate: () => void;
}

/**
 * Parse environment variable value to determine configuration
 */
function parseVariableValue(value: string): {
    useRemoteVariable: boolean;
    remoteVariableName: string;
    defaultValue: string;
} {
    // Match: ${VARIABLE_NAME:-default_value}
    const matchWithFallback = value.match(/^\$\{([A-Z_][A-Z0-9_]*):-(.*)\}$/);
    if (matchWithFallback) {
        return {
            useRemoteVariable: true,
            remoteVariableName: matchWithFallback[1],
            defaultValue: matchWithFallback[2]
        };
    }

    // Match: ${VARIABLE_NAME} (no fallback)
    const matchNoFallback = value.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
    if (matchNoFallback) {
        return {
            useRemoteVariable: true,
            remoteVariableName: matchNoFallback[1],
            defaultValue: ''
        };
    }

    // Literal value (no template)
    return {
        useRemoteVariable: false,
        remoteVariableName: '',
        defaultValue: value
    };
}

/**
 * Single environment variable card component
 * Matches profile list pattern from index.tsx:1163-1217
 */
export function EnvironmentVariableCard({
    variable,
    machineId,
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

    // Query remote machine for variable value (only if toggle enabled and not secret)
    const shouldQueryRemote = useRemoteVariable && !isSecret && remoteVariableName.trim() !== '';
    const { variables: remoteValues } = useEnvironmentVariables(
        machineId,
        shouldQueryRemote ? [remoteVariableName] : []
    );

    const remoteValue = remoteValues[remoteVariableName];

    // Update parent when local state changes
    React.useEffect(() => {
        const newValue = useRemoteVariable && remoteVariableName.trim() !== ''
            ? `\${${remoteVariableName}${defaultValue ? `:-${defaultValue}` : ''}}`
            : defaultValue;

        if (newValue !== variable.value) {
            onUpdate(newValue);
        }
    }, [useRemoteVariable, remoteVariableName, defaultValue, variable.value, onUpdate]);

    // Determine status
    const showRemoteDiffersWarning = remoteValue !== null && expectedValue && remoteValue !== expectedValue;
    const showDefaultOverrideWarning = expectedValue && defaultValue !== expectedValue;

    const computedTemplateValue =
        useRemoteVariable && remoteVariableName.trim() !== ''
            ? `\${${remoteVariableName}${defaultValue ? `:-${defaultValue}` : ''}}`
            : defaultValue;

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
                    fontSize: 13,
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
                        onPress={onDelete}
                    >
                        <Ionicons name="trash-outline" size={theme.iconSize.large} color={theme.colors.deleteAction} />
                    </Pressable>
                    <Pressable
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        onPress={onDuplicate}
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
                {useRemoteVariable ? 'Fallback value:' : 'Value:'}
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
                placeholder={expectedValue || (useRemoteVariable ? 'Default value' : 'Value')}
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
                    Secret value - not retrieved for security
                </Text>
            )}

            {/* Default override warning */}
            {showDefaultOverrideWarning && !isSecret && (
                <Text style={{
                    color: theme.colors.textSecondary,
                    marginBottom: 8,
                    ...secondaryTextStyle,
                }}>
                    Overriding documented default: {expectedValue}
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
                    Use value from machine environment
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
                Resolved when the session starts on the selected machine.
            </Text>

            {/* Source variable name input (only when enabled) */}
            {useRemoteVariable && (
                <>
                    <Text style={{
                        color: theme.colors.textSecondary,
                        marginBottom: 4,
                        ...secondaryTextStyle,
                    }}>
                        Source variable
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
                        placeholder="Source variable name (e.g., Z_AI_MODEL)"
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={remoteVariableName}
                        onChangeText={setRemoteVariableName}
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                </>
            )}

            {/* Machine environment status (only with machine context) */}
            {useRemoteVariable && !isSecret && machineId && remoteVariableName.trim() !== '' && (
                <View style={{ marginBottom: 8 }}>
                    {remoteValue === undefined ? (
                        <Text style={{
                            color: theme.colors.textSecondary,
                            fontStyle: 'italic',
                            ...secondaryTextStyle,
                        }}>
                            Checking machine environment...
                        </Text>
                    ) : remoteValue === null ? (
                        <Text style={{
                            color: theme.colors.warning,
                            ...secondaryTextStyle,
                        }}>
                            Value not found
                        </Text>
                    ) : (
                        <>
                            <Text style={{
                                color: theme.colors.success,
                                ...secondaryTextStyle,
                            }}>
                                Value found
                            </Text>
                            {showRemoteDiffersWarning && (
                                <Text style={{
                                    color: theme.colors.textSecondary,
                                    marginTop: 2,
                                    ...secondaryTextStyle,
                                }}>
                                    Differs from documented value: {expectedValue}
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
                Session will receive: {variable.name} = {
                    isSecret
                        ? (useRemoteVariable && remoteVariableName
                            ? `\${${remoteVariableName}${defaultValue ? `:-***` : ''}} - hidden for security`
                            : (defaultValue ? '***hidden***' : '(empty)'))
                        : (useRemoteVariable && machineId && remoteValue !== undefined && remoteValue !== null
                            ? remoteValue
                            : (computedTemplateValue || '(empty)'))
                }
            </Text>
        </View>
    );
}
