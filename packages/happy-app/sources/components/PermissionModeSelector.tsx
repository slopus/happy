import React from 'react';
import { Pressable, Platform, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { hapticsLight } from './haptics';
import { hackMode, hackModes } from '@/sync/modeHacks';
import type {
    PermissionMode,
    ModelMode,
    PermissionModeKey,
    ModelModeKey,
} from './modelModeOptions';

export type {
    PermissionMode,
    ModelMode,
    PermissionModeKey,
    ModelModeKey,
} from './modelModeOptions';

interface PermissionModeSelectorProps {
    mode: PermissionMode;
    availableModes?: PermissionMode[];
    onModeChange: (mode: PermissionMode) => void;
    disabled?: boolean;
}

export const PermissionModeSelector: React.FC<PermissionModeSelectorProps> = ({
    mode,
    availableModes = [],
    onModeChange,
    disabled = false,
}) => {
    const hackedMode = hackMode(mode);
    const hackedAvailableModes = hackModes(availableModes);

    const handleTap = () => {
        if (hackedAvailableModes.length === 0) {
            return;
        }

        hapticsLight();
        const currentIndex = hackedAvailableModes.findIndex((candidate) => candidate.key === hackedMode.key);
        const nextIndex = (currentIndex + 1) % hackedAvailableModes.length;
        onModeChange(hackedAvailableModes[nextIndex]);
    };

    return (
        <Pressable
            onPress={handleTap}
            disabled={disabled}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                borderRadius: Platform.select({ default: 16, android: 20 }),
                paddingHorizontal: 12,
                paddingVertical: 6,
                width: 120,
                justifyContent: 'center',
                height: 32,
                opacity: disabled ? 0.5 : 1,
            }}
        >
            <Ionicons name={'hammer-outline'} size={16} color={'black'} style={{ marginRight: 4 }} />
            <View />
        </Pressable>
    );
};
