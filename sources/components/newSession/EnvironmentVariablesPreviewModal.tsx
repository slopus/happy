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
    const withFallback = value.match(/^\$\{([A-Z_][A-Z0-9_]*):[-=](.*)\}$/);
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
    const scrollRef = React.useRef<ScrollView>(null);
    const scrollYRef = React.useRef(0);

    const handleScroll = React.useCallback((e: any) => {
        scrollYRef.current = e?.nativeEvent?.contentOffset?.y ?? 0;
    }, []);

    // On web, RN ScrollView inside a modal doesn't reliably respond to mouse wheel / trackpad scroll.
    // Manually translate wheel deltas into scrollTo.
    const handleWheel = React.useCallback((e: any) => {
        if (Platform.OS !== 'web') return;
        const deltaY = e?.deltaY;
        if (typeof deltaY !== 'number' || Number.isNaN(deltaY)) return;

        if (e?.cancelable) {
            e?.preventDefault?.();
        }
        e?.stopPropagation?.();
        scrollRef.current?.scrollTo({ y: Math.max(0, scrollYRef.current + deltaY), animated: false });
    }, []);

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
                // Never fetch secret-like values into UI memory.
                if (isSecretLike(envVar.name) || isSecretLike(parsed.sourceVar)) return;
                refs.add(parsed.sourceVar);
            }
        });
        return Array.from(refs);
    }, [envVarEntries]);

    const { variables: machineEnv } = useEnvironmentVariables(props.machineId, refsToQuery);

    const title = props.profileName ? `Env Vars · ${props.profileName}` : 'Environment Variables';
    const maxHeight = Math.min(720, Math.max(360, Math.floor(windowHeight * 0.85)));

    return (
        <View
            style={{
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
            }}
            {...(Platform.OS === 'web' ? ({ onWheel: handleWheel } as any) : {})}
        >
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

            <ScrollView
                ref={scrollRef}
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingBottom: 16, flexGrow: 1 }}
                showsVerticalScrollIndicator
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
                onScroll={handleScroll}
                scrollEventThrottle={16}
            >
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

                            const hasMachineContext = Boolean(props.machineId);
                            const resolvedValue = parsed?.sourceVar ? machineEnv[parsed.sourceVar] : undefined;
                            const isMachineBased = Boolean(parsed?.sourceVar);

                            let displayValue: string;
                            if (secret) {
                                displayValue = '•••';
                            } else if (parsed) {
                                if (!hasMachineContext) {
                                    displayValue = `\${${parsed.sourceVar}${parsed.fallback ? `:-${parsed.fallback}` : ''}}`;
                                } else if (resolvedValue === undefined) {
                                    displayValue = `\${${parsed.sourceVar}${parsed.fallback ? `:-${parsed.fallback}` : ''}} (checking…)`;
                                } else if (resolvedValue === null || resolvedValue === '') {
                                    displayValue = parsed.fallback ? parsed.fallback : '(empty)';
                                } else {
                                    displayValue = resolvedValue;
                                }
                            } else {
                                displayValue = envVar.value || '(empty)';
                            }

                            const detailLabel = (() => {
                                if (secret) return undefined;
                                if (!isMachineBased) return 'Fixed';
                                if (!hasMachineContext) return 'Machine';
                                if (resolvedValue === undefined) return 'Checking';
                                if (resolvedValue === null || resolvedValue === '') return parsed?.fallback ? 'Fallback' : 'Missing';
                                return 'Machine';
                            })();

                            const detailColor = (() => {
                                if (!detailLabel) return theme.colors.textSecondary;
                                if (detailLabel === 'Machine') return theme.colors.status.connected;
                                if (detailLabel === 'Fallback' || detailLabel === 'Missing') return theme.colors.warning;
                                return theme.colors.textSecondary;
                            })();

                            const rightElement = (() => {
                                if (secret) return undefined;
                                if (!isMachineBased) return undefined;
                                if (!hasMachineContext || detailLabel === 'Checking') {
                                    return <Ionicons name="time-outline" size={18} color={theme.colors.textSecondary} />;
                                }
                                return <Ionicons name="desktop-outline" size={18} color={detailColor} />;
                            })();

                            return (
                                <Item
                                    key={`${envVar.name}-${idx}`}
                                    title={envVar.name}
                                    subtitle={displayValue}
                                    subtitleLines={0}
                                    copy={secret ? false : displayValue}
                                    detail={detailLabel}
                                    detailStyle={{
                                        fontSize: 13,
                                        color: detailColor,
                                        ...Typography.default('semiBold'),
                                    }}
                                    rightElement={rightElement}
                                    showChevron={false}
                                />
                            );
                        })}
                    </ItemGroup>
                )}
            </ScrollView>
        </View>
    );
}
