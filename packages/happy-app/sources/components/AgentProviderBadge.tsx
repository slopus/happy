import * as React from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export type AgentProvider = 'claude' | 'codex' | 'gemini' | 'openclaw';

const providerIcons: Record<AgentProvider, number> = {
    claude: require('@/assets/images/icon-claude.png'),
    codex: require('@/assets/images/icon-gpt.png'),
    gemini: require('@/assets/images/icon-gemini.png'),
    openclaw: require('@/assets/images/icon-openclaw.png'),
};

const stylesheet = StyleSheet.create((theme) => ({
    stack: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    iconShell: {
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        overflow: 'hidden',
    },
}));

export function normalizeAgentProvider(value: string | null | undefined): AgentProvider {
    if (value === 'codex' || value === 'openai' || value?.includes('gpt')) return 'codex';
    if (value === 'gemini' || value === 'google') return 'gemini';
    if (value === 'openclaw') return 'openclaw';
    return 'claude';
}

export const AgentProviderBadge = React.memo((props: {
    providers: Array<string | null | undefined>;
    size?: number;
}) => {
    const { providers, size = 18 } = props;
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const normalized = React.useMemo(() => {
        const seen = new Set<AgentProvider>();
        const result: AgentProvider[] = [];
        providers.forEach(provider => {
            const normalizedProvider = normalizeAgentProvider(provider);
            if (!seen.has(normalizedProvider)) {
                seen.add(normalizedProvider);
                result.push(normalizedProvider);
            }
        });
        return result.slice(0, 3);
    }, [providers]);

    return (
        <View style={styles.stack}>
            {normalized.map((provider, index) => {
                const shellSize = size + 6;
                const iconSize = provider === 'codex' ? Math.round(size * 0.78) : size;
                return (
                    <View
                        key={provider}
                        style={[
                            styles.iconShell,
                            {
                                width: shellSize,
                                height: shellSize,
                                borderRadius: shellSize / 2,
                                marginLeft: index === 0 ? 0 : -7,
                                zIndex: normalized.length - index,
                            },
                        ]}
                    >
                        <Image
                            source={providerIcons[provider]}
                            style={{ width: iconSize, height: iconSize }}
                            contentFit="contain"
                            tintColor={provider === 'codex' ? theme.colors.text : undefined}
                        />
                    </View>
                );
            })}
        </View>
    );
});
