import React from 'react';
import { Text, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { hapticsLight } from './haptics';

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

interface PermissionModeSelectorProps {
    mode: PermissionMode;
    onModeChange: (mode: PermissionMode) => void;
    disabled?: boolean;
}

const modeConfig = {
    default: {
        label: 'Default',
        icon: 'shield-checkmark' as const,
        description: 'Ask for permissions'
    },
    acceptEdits: {
        label: 'Accept Edits',
        icon: 'create' as const,
        description: 'Auto-approve edits'
    },
    plan: {
        label: 'Plan',
        icon: 'list' as const,
        description: 'Plan before executing'
    },
    bypassPermissions: {
        label: 'Yolo',
        icon: 'flash' as const,
        description: 'Skip all permissions'
    },
};

const modeOrder: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

export const PermissionModeSelector: React.FC<PermissionModeSelectorProps> = ({
    mode,
    onModeChange,
    disabled = false
}) => {
    const currentConfig = modeConfig[mode];

    const handleTap = () => {
        hapticsLight();
        const currentIndex = modeOrder.indexOf(mode);
        const nextIndex = (currentIndex + 1) % modeOrder.length;
        onModeChange(modeOrder[nextIndex]);
    };

    return (
        <Pressable
            onPress={handleTap}
            disabled={disabled}
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                // backgroundColor: Platform.select({
                //     ios: '#F2F2F7',
                //     android: '#E0E0E0',
                //     default: '#F2F2F7'
                // }),
                borderRadius: Platform.select({ default: 16, android: 20 }),
                paddingHorizontal: 12,
                paddingVertical: 6,
                width: 120,
                justifyContent: 'center',
                height: 32,
                opacity: disabled ? 0.5 : 1,
            }}
        >
            <Ionicons
                name={'hammer-outline'}
                size={16}
                color={'black'}
                style={{ marginRight: 4 }}
            />
            {/* <Text style={{
                fontSize: 13,
                color: '#000',
                fontWeight: '600',
                ...Typography.default('semiBold')
            }}>
                {currentConfig.label}
            </Text> */}
        </Pressable>
    );
};