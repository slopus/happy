import * as React from 'react';
import { Pressable, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

interface SessionOriginBadgeProps {
    type: 'resumed' | 'forked';
    parentSessionName: string;
    onPress?: () => void;
}

export const SessionOriginBadge = React.memo(function SessionOriginBadge({
    type,
    parentSessionName,
    onPress,
}: SessionOriginBadgeProps) {
    const { theme } = useUnistyles();
    const icon = type === 'resumed' ? 'play-circle-outline' : 'git-branch-outline';
    const label = parentSessionName
        ? (type === 'resumed'
            ? t('session.resumedFrom', { name: parentSessionName })
            : t('session.forkedFrom', { name: parentSessionName }))
        : (type === 'resumed' ? t('session.resumedSession') : t('session.forkedSession'));

    return (
        <Pressable
            onPress={onPress}
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                alignSelf: 'center',
                gap: 4,
                backgroundColor: theme.colors.surfaceHigh,
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderRadius: 10,
                marginVertical: 6,
            }}
        >
            <Ionicons name={icon as any} size={12} color={theme.colors.textSecondary} />
            <Text style={{ fontSize: 11, color: theme.colors.textSecondary, fontWeight: '500' }}>
                {label}
            </Text>
        </Pressable>
    );
});
