import React from 'react';
import { View, Text, ScrollView, Pressable, Platform, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { useEnvironmentVariables } from '@/hooks/useEnvironmentVariables';

export interface EnvironmentVariablesPreviewModalProps {
    environmentVariables: Record<string, string>;
    machineId: string | null;
    machineName?: string | null;
    profileName?: string | null;
    onClose: () => void;
}

function parseTemplateValue(value: string): { sourceVar: string; fallback: string } | null {
    const withFallback = value.match(/^\$\{([A-Z_][A-Z0-9_]*):-(.*)\}$/);
    if (withFallback) {
        return { sourceVar: withFallback[1], fallback: withFallback[2] };
    }
    const noFallback = value.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
    if (noFallback) {
        return { sourceVar: noFallback[1], fallback: '' };
    }
    return null;
}

function isSecretLike(name: string) {
    return /TOKEN|KEY|SECRET|AUTH|PASS|PASSWORD|COOKIE/i.test(name);
}

export function EnvironmentVariablesPreviewModal(props: EnvironmentVariablesPreviewModalProps) {
    const { theme } = useUnistyles();
    const { height: windowHeight } = useWindowDimensions();

    const envVarEntries = React.useMemo(() => {
        return Object.entries(props.environmentVariables)
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [props.environmentVariables]);

    const refsToQuery = React.useMemo(() => {
        const refs = new Set<string>();
        envVarEntries.forEach((envVar) => {
            const parsed = parseTemplateValue(envVar.value);
            if (parsed?.sourceVar) {
                refs.add(parsed.sourceVar);
            }
        });
        return Array.from(refs);
    }, [envVarEntries]);

    const { variables: machineEnv } = useEnvironmentVariables(props.machineId, refsToQuery);

    const title = props.profileName ? `Env Vars · ${props.profileName}` : 'Environment Variables';
    const maxHeight = Math.min(720, Math.max(360, Math.floor(windowHeight * 0.85)));

    return (
        <View style={{
            width: '92%',
            maxWidth: 560,
            height: maxHeight,
            maxHeight,
            backgroundColor: theme.colors.groupped.background,
            borderRadius: 16,
            overflow: 'hidden',
            borderWidth: 1,
            borderColor: theme.colors.divider,
            flexShrink: 1,
        }}>
            <View style={{
                paddingHorizontal: 16,
                paddingVertical: 12,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.divider,
            }}>
                <Text style={{
                    fontSize: 17,
                    color: theme.colors.text,
                    ...Typography.default('semiBold'),
                }}>
                    {title}
                </Text>

                <Pressable
                    onPress={props.onClose}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                >
                    <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 16 }}>
                <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
                    <Text style={{
                        color: theme.colors.textSecondary,
                        fontSize: Platform.select({ ios: 15, default: 14 }),
                        lineHeight: 20,
                        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
                        ...Typography.default(),
                    }}>
                        These environment variables are sent when starting the session. Values are resolved using the daemon on{' '}
                        {props.machineName ? (
                            <Text style={{ color: theme.colors.status.connected, ...Typography.default('semiBold') }}>
                                {props.machineName}
                            </Text>
                        ) : (
                            'the selected machine'
                        )}
                        .
                    </Text>
                </View>

                {envVarEntries.length === 0 ? (
                    <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
                        <Text style={{
                            color: theme.colors.textSecondary,
                            fontSize: Platform.select({ ios: 15, default: 14 }),
                            lineHeight: 20,
                            letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
                            ...Typography.default(),
                        }}>
                            No environment variables are set for this profile.
                        </Text>
                    </View>
                ) : (
                    <ItemGroup title="Environment Variables">
                        {envVarEntries.map((envVar, idx) => {
                            const parsed = parseTemplateValue(envVar.value);
                            const secret = isSecretLike(envVar.name) || (parsed?.sourceVar ? isSecretLike(parsed.sourceVar) : false);

                            let displayValue: string;
                            if (secret) {
                                displayValue = '•••';
                            } else if (parsed) {
                                const resolved = machineEnv[parsed.sourceVar];
                                if (resolved === undefined) {
                                    displayValue = `\${${parsed.sourceVar}${parsed.fallback ? `:-${parsed.fallback}` : ''}} (checking…)`;
                                } else if (resolved === null || resolved === '') {
                                    displayValue = parsed.fallback ? parsed.fallback : '(empty)';
                                } else {
                                    displayValue = resolved;
                                }
                            } else {
                                displayValue = envVar.value || '(empty)';
                            }

                            return (
                                <Item
                                    key={`${envVar.name}-${idx}`}
                                    title={envVar.name}
                                    subtitle={displayValue}
                                    subtitleLines={0}
                                    copy={secret ? false : displayValue}
                                />
                            );
                        })}
                    </ItemGroup>
                )}
            </ScrollView>
        </View>
    );
}
