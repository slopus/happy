import * as React from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { AgentPreset, AGENT_PRESETS } from '../model/presets';

export const PresetPicker = React.memo((props: {
    onSelect: (preset: AgentPreset) => void;
}) => {
    const { theme } = useUnistyles();

    return (
        <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
            <Text style={{
                fontSize: 15,
                fontWeight: '600',
                color: theme.colors.textSecondary,
                marginBottom: 12,
                ...Typography.default('semiBold'),
            }}>
                Стиль общения
            </Text>
            <View style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: 10,
            }}>
                {AGENT_PRESETS.map(preset => (
                    <PresetCard
                        key={preset.id}
                        preset={preset}
                        onPress={() => props.onSelect(preset)}
                    />
                ))}
            </View>
        </View>
    );
});

const PresetCard = React.memo((props: {
    preset: AgentPreset;
    onPress: () => void;
}) => {
    const { theme } = useUnistyles();
    const { preset } = props;

    return (
        <Pressable
            onPress={props.onPress}
            style={(state) => ({
                width: Platform.OS === 'web' ? 'calc(50% - 5px)' as any : '48%',
                backgroundColor: theme.colors.card,
                borderRadius: 14,
                padding: 14,
                borderWidth: 1,
                borderColor: theme.colors.border,
                opacity: state.pressed ? 0.7 : 1,
            })}
        >
            <Text style={{ fontSize: 28, marginBottom: 6 }}>
                {preset.emoji}
            </Text>
            <Text style={{
                fontSize: 15,
                fontWeight: '600',
                color: theme.colors.text,
                marginBottom: 3,
                ...Typography.default('semiBold'),
            }}>
                {preset.titleRu}
            </Text>
            <Text style={{
                fontSize: 13,
                color: theme.colors.textSecondary,
                lineHeight: 17,
                ...Typography.default(),
            }} numberOfLines={2}>
                {preset.descriptionRu}
            </Text>
        </Pressable>
    );
});
