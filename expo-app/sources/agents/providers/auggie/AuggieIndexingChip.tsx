import { Octicons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable, Text } from 'react-native';

import { hapticsLight } from '@/components/haptics';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput';
import { t } from '@/text';

export function createAuggieAllowIndexingChip(opts: Readonly<{
    allowIndexing: boolean;
    setAllowIndexing: (next: boolean) => void;
}>): AgentInputExtraActionChip {
    return {
        key: 'auggie-allow-indexing',
        render: ({ chipStyle, showLabel, iconColor, textStyle }) => (
            <Pressable
                onPress={() => {
                    hapticsLight();
                    opts.setAllowIndexing(!opts.allowIndexing);
                }}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={(p) => chipStyle(p.pressed)}
            >
                <Octicons name="search" size={16} color={iconColor} />
                {showLabel ? (
                    <Text style={textStyle}>
                        {t(opts.allowIndexing ? 'agentInput.auggieIndexingChip.on' : 'agentInput.auggieIndexingChip.off')}
                    </Text>
                ) : null}
            </Pressable>
        ),
    };
}

