import * as React from 'react';
import { Platform, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/Item';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useSetting } from '@/sync/storage';
import type { MachineDetectCliCacheState } from '@/hooks/useMachineDetectCliCache';

type Props = {
    state: MachineDetectCliCacheState;
    layout?: 'inline' | 'stacked';
};

export function DetectedClisList({ state, layout = 'inline' }: Props) {
    const { theme } = useUnistyles();
    const experimentsEnabled = useSetting('experiments');
    const expGemini = useSetting('expGemini');
    const allowGemini = experimentsEnabled && expGemini;

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

    if (state.status === 'not-supported') {
        return <Item title={t('machine.detectedCliNotSupported')} showChevron={false} />;
    }

    if (state.status === 'error') {
        return <Item title={t('machine.detectedCliUnknown')} showChevron={false} />;
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

    const entries = [
        ['claude', state.response.clis.claude] as const,
        ['codex', state.response.clis.codex] as const,
        ['gemini', state.response.clis.gemini] as const,
    ].filter(([name]) => name !== 'gemini' || allowGemini);

    return (
        <>
            {entries.map(([name, entry], index) => {
                const available = entry.available;
                const iconName = available ? 'checkmark-circle' : 'close-circle';
                const iconColor = available ? theme.colors.status.connected : theme.colors.textSecondary;
                const version = extractSemver(entry.version);

                const subtitle = !available
                    ? t('machine.detectedCliNotDetected')
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

