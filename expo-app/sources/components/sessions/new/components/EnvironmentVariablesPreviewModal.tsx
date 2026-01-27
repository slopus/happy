import React from 'react';
import { View, Text, ScrollView, Pressable, Platform, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { useEnvironmentVariables } from '@/hooks/useEnvironmentVariables';
import { t } from '@/text';
import { formatEnvVarTemplate, parseEnvVarTemplate } from '@/utils/profiles/envVarTemplate';

export interface EnvironmentVariablesPreviewModalProps {
    environmentVariables: Record<string, string>;
    machineId: string | null;
    machineName?: string | null;
    profileName?: string | null;
    onClose: () => void;
}

function isSecretLike(name: string) {
    return /TOKEN|KEY|SECRET|AUTH|PASS|PASSWORD|COOKIE/i.test(name);
}

const ENV_VAR_TEMPLATE_REF_REGEX = /\$\{([A-Z_][A-Z0-9_]*)(?::[-=][^}]*)?\}/g;

function extractVarRefsFromValue(value: string): string[] {
    const refs: string[] = [];
    if (!value) return refs;
    ENV_VAR_TEMPLATE_REF_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ENV_VAR_TEMPLATE_REF_REGEX.exec(value)) !== null) {
        const name = match[1];
        if (name) refs.push(name);
    }
    return refs;
}

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        width: '92%',
        maxWidth: 560,
        backgroundColor: theme.colors.groupped.background,
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        flexShrink: 1,
    },
    header: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    headerTitle: {
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    scroll: {
        flex: 1,
    },
    scrollContent: {
        paddingBottom: 16,
        flexGrow: 1,
    },
    section: {
        paddingHorizontal: 16,
        paddingTop: 12,
    },
    descriptionText: {
        color: theme.colors.textSecondary,
        fontSize: Platform.select({ ios: 15, default: 14 }),
        lineHeight: 20,
        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
        ...Typography.default(),
    },
    machineNameText: {
        color: theme.colors.status.connected,
        ...Typography.default('semiBold'),
    },
    detailText: {
        fontSize: 13,
        ...Typography.default('semiBold'),
    },
}));

export function EnvironmentVariablesPreviewModal(props: EnvironmentVariablesPreviewModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
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
            // Query both target keys and any referenced keys so preview can show the effective spawned value.
            refs.add(envVar.name);
            extractVarRefsFromValue(envVar.value).forEach((ref) => refs.add(ref));
        });
        return Array.from(refs);
    }, [envVarEntries]);

    const sensitiveKeys = React.useMemo(() => {
        const keys = new Set<string>();
        envVarEntries.forEach((envVar) => {
            const refs = extractVarRefsFromValue(envVar.value);
            const isSensitive = isSecretLike(envVar.name) || refs.some(isSecretLike);
            if (isSensitive) {
                keys.add(envVar.name);
                refs.forEach((ref) => { keys.add(ref); });
            }
        });
        return Array.from(keys);
    }, [envVarEntries]);

    const { meta: machineEnv, policy: machineEnvPolicy } = useEnvironmentVariables(
        props.machineId,
        refsToQuery,
        { extraEnv: props.environmentVariables, sensitiveKeys },
    );

    const title = props.profileName
        ? t('profiles.environmentVariables.previewModal.titleWithProfile', { profileName: props.profileName })
        : t('profiles.environmentVariables.title');
    const maxHeight = Math.min(720, Math.max(360, Math.floor(windowHeight * 0.85)));
    const emptyValue = t('profiles.environmentVariables.preview.emptyValue');

    return (
        <View
            style={[styles.container, { height: maxHeight, maxHeight }]}
            {...(Platform.OS === 'web' ? ({ onWheel: handleWheel } as any) : {})}
        >
            <View style={styles.header}>
                <Text style={styles.headerTitle}>
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
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
                onScroll={handleScroll}
                scrollEventThrottle={16}
            >
                <View style={styles.section}>
                    <Text style={styles.descriptionText}>
                        {t('profiles.environmentVariables.previewModal.descriptionPrefix')}{' '}
                        {props.machineName ? (
                            <Text style={styles.machineNameText}>
                                {props.machineName}
                            </Text>
                        ) : (
                            t('profiles.environmentVariables.previewModal.descriptionFallbackMachine')
                        )}
                        {t('profiles.environmentVariables.previewModal.descriptionSuffix')}
                    </Text>
                </View>

                {envVarEntries.length === 0 ? (
                    <View style={styles.section}>
                        <Text style={styles.descriptionText}>
                            {t('profiles.environmentVariables.previewModal.emptyMessage')}
                        </Text>
                    </View>
                ) : (
                    <ItemGroup title={t('profiles.environmentVariables.title')}>
                        {envVarEntries.map((envVar, idx) => {
                            const parsed = parseEnvVarTemplate(envVar.value);
                            const refs = extractVarRefsFromValue(envVar.value);
                            const primaryRef = refs[0];
                            const secret = isSecretLike(envVar.name) || (primaryRef ? isSecretLike(primaryRef) : false);

                            const hasMachineContext = Boolean(props.machineId);
                            const targetEntry = machineEnv?.[envVar.name];
                            const resolvedValue = parsed?.sourceVar ? machineEnv?.[parsed.sourceVar] : undefined;
                            const isMachineBased = Boolean(refs.length > 0);

                            let displayValue: string;
                            if (hasMachineContext && targetEntry) {
                                if (targetEntry.display === 'full' || targetEntry.display === 'redacted') {
                                    displayValue = targetEntry.value ?? emptyValue;
                                } else if (targetEntry.display === 'hidden') {
                                    displayValue = '•••';
                                } else {
                                    displayValue = emptyValue;
                                }
                            } else if (secret) {
                                // If daemon policy is known and allows showing secrets, we would have used targetEntry above.
                                displayValue = machineEnvPolicy === 'full' || machineEnvPolicy === 'redacted' ? (envVar.value || emptyValue) : '•••';
                            } else if (parsed) {
                                if (!hasMachineContext) {
                                    displayValue = formatEnvVarTemplate(parsed);
                                } else if (resolvedValue === undefined) {
                                    displayValue = `${formatEnvVarTemplate(parsed)} ${t('profiles.environmentVariables.previewModal.checkingSuffix')}`;
                                } else if (resolvedValue.display === 'hidden') {
                                    displayValue = '•••';
                                } else if (resolvedValue.display === 'unset' || resolvedValue.value === null || resolvedValue.value === '') {
                                    displayValue = parsed.fallback ? parsed.fallback : emptyValue;
                                } else {
                                    displayValue = resolvedValue.value ?? emptyValue;
                                }
                            } else {
                                displayValue = envVar.value || emptyValue;
                            }

                            type DetailKind = 'fixed' | 'machine' | 'checking' | 'fallback' | 'missing';

                            const detailKind: DetailKind | undefined = (() => {
                                if (secret) return undefined;
                                if (!isMachineBased) return 'fixed';
                                if (!hasMachineContext) return 'machine';
                                if (parsed?.sourceVar && resolvedValue === undefined) return 'checking';
                                if (parsed?.sourceVar && resolvedValue && (resolvedValue.display === 'unset' || resolvedValue.value === null || resolvedValue.value === '')) {
                                    return parsed?.fallback ? 'fallback' : 'missing';
                                }
                                return 'machine';
                            })();

                            const detailLabel = (() => {
                                if (!detailKind) return undefined;
                                return detailKind === 'fixed'
                                    ? t('profiles.environmentVariables.previewModal.detail.fixed')
                                    : detailKind === 'machine'
                                        ? t('profiles.environmentVariables.previewModal.detail.machine')
                                        : detailKind === 'checking'
                                            ? t('profiles.environmentVariables.previewModal.detail.checking')
                                            : detailKind === 'fallback'
                                                ? t('profiles.environmentVariables.previewModal.detail.fallback')
                                                : t('profiles.environmentVariables.previewModal.detail.missing');
                            })();

                            const detailColor =
                                detailKind === 'machine'
                                    ? theme.colors.status.connected
                                    : detailKind === 'fallback' || detailKind === 'missing'
                                        ? theme.colors.warning
                                        : theme.colors.textSecondary;

                            const rightElement = (() => {
                                if (secret) return undefined;
                                if (!isMachineBased) return undefined;
                                if (!hasMachineContext || detailKind === 'checking') {
                                    return <Ionicons name="time-outline" size={18} color={theme.colors.textSecondary} />;
                                }
                                return <Ionicons name="desktop-outline" size={18} color={detailColor} />;
                            })();

                            const canCopy = (() => {
                                if (secret) return false;
                                return Boolean(displayValue);
                            })();

                            return (
                                <Item
                                    key={`${envVar.name}-${idx}`}
                                    title={envVar.name}
                                    subtitle={displayValue}
                                    subtitleLines={0}
                                    copy={canCopy ? displayValue : false}
                                    detail={detailLabel}
                                    detailStyle={{
                                        color: detailColor,
                                        ...styles.detailText,
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
