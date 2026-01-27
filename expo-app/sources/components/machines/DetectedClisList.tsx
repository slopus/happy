import * as React from 'react';
import { Platform, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/ui/lists/Item';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import type { MachineCapabilitiesCacheState } from '@/hooks/useMachineCapabilitiesCache';
import type { CapabilityDetectResult, CapabilityId, CliCapabilityData, TmuxCapabilityData } from '@/sync/capabilitiesProtocol';
import { getAgentCore } from '@/agents/catalog';
import { useEnabledAgentIds } from '@/agents/useEnabledAgentIds';

type Props = {
    state: MachineCapabilitiesCacheState;
    layout?: 'inline' | 'stacked';
};

export function DetectedClisList({ state, layout = 'inline' }: Props) {
    const { theme } = useUnistyles();
    const enabledAgents = useEnabledAgentIds();

    const extractSemver = React.useCallback((value: string | undefined): string | null => {
        if (!value) return null;
        const match = value.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
        return match?.[0] ?? null;
    }, []);

    const subtitleBaseStyle = React.useMemo(() => {
        return [
            Typography.default('regular'),
            {
                color: theme.colors.textSecondary,
                fontSize: Platform.select({ ios: 15, default: 14 }),
                lineHeight: 20,
                letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
                flexWrap: 'wrap' as const,
            },
        ];
    }, [theme.colors.textSecondary]);

    const snapshotForRender = React.useMemo(() => {
        if (state.status === 'loaded') return state.snapshot;
        if (state.status === 'error') return state.snapshot;
        return undefined;
    }, [state]);

    if (state.status === 'not-supported') {
        return <Item title={t('machine.detectedCliNotSupported')} showChevron={false} />;
    }

    if (state.status === 'loading' || state.status === 'idle') {
        return (
            <Item
                title={t('common.loading')}
                showChevron={false}
                rightElement={<Ionicons name="time-outline" size={18} color={theme.colors.textSecondary} />}
            />
        );
    }

    if (!snapshotForRender) {
        return <Item title={t('machine.detectedCliUnknown')} showChevron={false} />;
    }

    const results = snapshotForRender.response.results ?? {};

    function readCliResult(result: CapabilityDetectResult | undefined): { available: boolean | null; resolvedPath?: string; version?: string } {
        if (!result || !result.ok) return { available: null };
        const data = result.data as Partial<CliCapabilityData>;
        const available = typeof data.available === 'boolean' ? data.available : null;
        if (!available) return { available };
        return {
            available,
            ...(typeof data.resolvedPath === 'string' ? { resolvedPath: data.resolvedPath } : {}),
            ...(typeof data.version === 'string' ? { version: data.version } : {}),
        };
    }

    function readTmuxResult(result: CapabilityDetectResult | undefined): { available: boolean | null; resolvedPath?: string; version?: string } {
        if (!result || !result.ok) return { available: null };
        const data = result.data as Partial<TmuxCapabilityData>;
        const available = typeof data.available === 'boolean' ? data.available : null;
        if (!available) return { available };
        return {
            available,
            ...(typeof data.resolvedPath === 'string' ? { resolvedPath: data.resolvedPath } : {}),
            ...(typeof data.version === 'string' ? { version: data.version } : {}),
        };
    }

    const entries: Array<[string, { available: boolean | null; resolvedPath?: string; version?: string }]> = [
        ...enabledAgents.map((agentId): [string, { available: boolean | null; resolvedPath?: string; version?: string }] => {
            const capId = `cli.${getAgentCore(agentId).cli.detectKey}` as CapabilityId;
            return [t(getAgentCore(agentId).displayNameKey), readCliResult(results[capId])];
        }),
        ['tmux', readTmuxResult(results['tool.tmux'])],
    ];

    return (
        <>
            {entries.map(([name, entry], index) => {
                const available = entry.available;
                const iconName = available === true ? 'checkmark-circle' : available === false ? 'close-circle' : 'time-outline';
                const iconColor = available === true ? theme.colors.status.connected : theme.colors.textSecondary;
                const version = name === 'tmux' ? (entry.version ?? null) : extractSemver(entry.version);

                const subtitle = available === false
                    ? t('machine.detectedCliNotDetected')
                    : available === null
                        ? t('machine.detectedCliUnknown')
                    : (
                        layout === 'stacked' ? (
                            <View style={{ gap: 2 }}>
                                {version ? (
                                    <Text style={subtitleBaseStyle}>
                                        {version}
                                    </Text>
                                ) : null}
                                {entry.resolvedPath ? (
                                    <Text style={[subtitleBaseStyle, { opacity: 0.6 }]}>
                                        {entry.resolvedPath}
                                    </Text>
                                ) : null}
                                {!version && !entry.resolvedPath ? (
                                    <Text style={subtitleBaseStyle}>
                                        {t('machine.detectedCliUnknown')}
                                    </Text>
                                ) : null}
                            </View>
                        ) : (
                            <Text style={subtitleBaseStyle}>
                                {version ?? null}
                                {version && entry.resolvedPath ? ' • ' : null}
                                {entry.resolvedPath ? (
                                    <Text style={{ opacity: 0.6 }}>
                                        {entry.resolvedPath}
                                    </Text>
                                ) : null}
                                {!version && !entry.resolvedPath ? t('machine.detectedCliUnknown') : null}
                            </Text>
                        )
                    );

                return (
                    <Item
                        key={name}
                        title={name}
                        subtitle={subtitle}
                        subtitleLines={0}
                        showChevron={false}
                        showDivider={index !== entries.length - 1}
                        leftElement={<Ionicons name={iconName as any} size={18} color={iconColor} />}
                    />
                );
            })}
        </>
    );
}
