import * as React from 'react';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { getProviderIconKind } from '@/sync/rig';

const providerImages = {
    codex: require('@/assets/images/icon-gpt.png'),
    claude: require('@/assets/images/icon-claude.png'),
} as const;

export function ProviderIcon({ kind, size = 14 }: { kind?: string | null; size?: number }) {
    const { theme } = useUnistyles();
    const mapped = getProviderIconKind(kind);
    if (mapped === 'codex' || mapped === 'claude') {
        return (
            <Image
                source={providerImages[mapped]}
                style={{ width: size, height: size }}
                contentFit="contain"
                tintColor={mapped === 'codex' ? theme.colors.textSecondary : undefined}
            />
        );
    }
    const icon = mapped === 'grok'
        ? 'flash-outline'
        : mapped === 'kimi'
            ? 'moon-outline'
            : 'sparkles-outline';
    return <Ionicons name={icon} size={size} color={theme.colors.textSecondary} />;
}
