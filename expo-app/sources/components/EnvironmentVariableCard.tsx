import React from 'react';
import { View, Text, TextInput, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useEnvironmentVariables } from '@/hooks/useEnvironmentVariables';

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

    // Parse current value
    const parsed = parseVariableValue(variable.value);
    const [useRemoteVariable, setUseRemoteVariable] = React.useState(parsed.useRemoteVariable);
    const [remoteVariableName, setRemoteVariableName] = React.useState(parsed.remoteVariableName);
    const [defaultValue, setDefaultValue] = React.useState(parsed.defaultValue);

    // Query remote machine for variable value (only if checkbox enabled and not secret)
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

    return (
        <View style={{
            backgroundColor: theme.colors.input.background,
            borderRadius: theme.borderRadius.xl,
            padding: theme.margins.lg,
            marginBottom: theme.margins.md
        }}>
            {/* Header row with variable name and action buttons */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <Text style={{
                    fontSize: 12,
                    fontWeight: '600',
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
                    fontSize: 11,
                    color: theme.colors.textSecondary,
                    marginBottom: 8,
                    ...Typography.default()
                }}>
                    {description}
                </Text>
            )}

            {/* Checkbox: First try copying variable from remote machine */}
            <Pressable
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginBottom: 8,
                }}
                onPress={() => setUseRemoteVariable(!useRemoteVariable)}
            >
                <View style={{
                    width: 20,
                    height: 20,
                    borderRadius: theme.borderRadius.sm,
                    borderWidth: 2,
                    borderColor: useRemoteVariable ? theme.colors.button.primary.background : theme.colors.textSecondary,
                    backgroundColor: useRemoteVariable ? theme.colors.button.primary.background : 'transparent',
                    justifyContent: 'center',
                    alignItems: 'center',
                    marginRight: theme.margins.sm,
                }}>
                    {useRemoteVariable && (
                        <Ionicons name="checkmark" size={theme.iconSize.small} color={theme.colors.button.primary.tint} />
                    )}
                </View>
                <Text style={{
                    fontSize: 11,
                    color: theme.colors.textSecondary,
                    ...Typography.default()
                }}>
                    First try copying variable from remote machine:
                </Text>
            </Pressable>

            {/* Remote variable name input */}
            <TextInput
                style={{
                    backgroundColor: theme.colors.surface,
                    borderRadius: theme.borderRadius.lg,
                    padding: theme.margins.sm,
                    fontSize: 14,
                    color: theme.colors.text,
                    marginBottom: 4,
                    borderWidth: 1,
                    borderColor: theme.colors.textSecondary,
                    opacity: useRemoteVariable ? 1 : 0.5,
                }}
                placeholder="Variable name (e.g., Z_AI_MODEL)"
                placeholderTextColor={theme.colors.input.placeholder}
                value={remoteVariableName}
                onChangeText={setRemoteVariableName}
                editable={useRemoteVariable}
                autoCapitalize="none"
                autoCorrect={false}
            />

            {/* Remote variable status */}
            {useRemoteVariable && !isSecret && machineId && remoteVariableName.trim() !== '' && (
                <View style={{ marginBottom: 8 }}>
                    {remoteValue === undefined ? (
                        <Text style={{
                            fontSize: 11,
                            color: theme.colors.textSecondary,
                            fontStyle: 'italic',
                            ...Typography.default()
                        }}>
                            ⏳ Checking remote machine...
                        </Text>
                    ) : remoteValue === null ? (
                        <Text style={{
                            fontSize: 11,
                            color: theme.colors.warning,
                            ...Typography.default()
                        }}>
                            ✗ Value not found
                        </Text>
                    ) : (
                        <>
                            <Text style={{
                                fontSize: 11,
                                color: theme.colors.success,
                                ...Typography.default()
                            }}>
                                ✓ Value found: {remoteValue}
                            </Text>
                            {showRemoteDiffersWarning && (
                                <Text style={{
                                    fontSize: 11,
                                    color: theme.colors.textSecondary,
                                    marginTop: 2,
                                    ...Typography.default()
                                }}>
                                    ⚠️ Differs from documented value: {expectedValue}
                                </Text>
                            )}
                        </>
                    )}
                </View>
            )}

            {useRemoteVariable && !isSecret && !machineId && (
                <Text style={{
                    fontSize: 11,
                    color: theme.colors.textSecondary,
                    marginBottom: 8,
                    fontStyle: 'italic',
                    ...Typography.default()
                }}>
                    ℹ️ Select a machine to check if variable exists
                </Text>
            )}

            {/* Security message for secrets */}
            {isSecret && (
                <Text style={{
                    fontSize: 11,
                    color: theme.colors.textSecondary,
                    marginBottom: 8,
                    fontStyle: 'italic',
                    ...Typography.default()
                }}>
                    🔒 Secret value - not retrieved for security
                </Text>
            )}

            {/* Default value label */}
            <Text style={{
                fontSize: 11,
                color: theme.colors.textSecondary,
                marginBottom: 4,
                ...Typography.default()
            }}>
                Default value:
            </Text>

            {/* Default value input */}
            <TextInput
                style={{
                    backgroundColor: theme.colors.surface,
                    borderRadius: theme.borderRadius.lg,
                    padding: theme.margins.sm,
                    fontSize: 14,
                    color: theme.colors.text,
                    marginBottom: 4,
                    borderWidth: 1,
                    borderColor: theme.colors.textSecondary,
                }}
                placeholder={expectedValue || "Value"}
                placeholderTextColor={theme.colors.input.placeholder}
                value={defaultValue}
                onChangeText={setDefaultValue}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry={isSecret}
            />

            {/* Default override warning */}
            {showDefaultOverrideWarning && !isSecret && (
                <Text style={{
                    fontSize: 11,
                    color: theme.colors.textSecondary,
                    marginBottom: 8,
                    ...Typography.default()
                }}>
                    ⚠️ Overriding documented default: {expectedValue}
                </Text>
            )}

            {/* Session preview */}
            <Text style={{
                fontSize: 11,
                color: theme.colors.textSecondary,
                marginTop: 4,
                ...Typography.default()
            }}>
                Session will receive: {variable.name} = {
                    isSecret
                        ? (useRemoteVariable && remoteVariableName
                            ? `\${${remoteVariableName}${defaultValue ? `:-***` : ''}} - hidden for security`
                            : (defaultValue ? '***hidden***' : '(empty)'))
                        : (useRemoteVariable && remoteValue !== undefined && remoteValue !== null
                            ? remoteValue
                            : defaultValue || '(empty)')
                }
            </Text>
        </View>
    );
}
