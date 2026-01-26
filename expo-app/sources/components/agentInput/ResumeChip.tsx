import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { ActivityIndicator, Pressable, Text } from 'react-native';
import { t } from '@/text';

export const RESUME_CHIP_ICON_NAME = 'refresh-outline' as const;
export const RESUME_CHIP_ICON_SIZE = 16 as const;

export function formatResumeChipLabel(params: {
    resumeSessionId: string | null | undefined;
    labelTitle: string;
    labelOptional: string;
}): string {
    const id = typeof params.resumeSessionId === 'string' ? params.resumeSessionId.trim() : '';
    if (!id) return params.labelOptional;

    // Avoid overlap/duplication when the id is short.
    if (id.length <= 20) return t('agentInput.resumeChip.withId', { title: params.labelTitle, id });

    return t('agentInput.resumeChip.withIdTruncated', { title: params.labelTitle, prefix: id.slice(0, 8), suffix: id.slice(-8) });
}

export type ResumeChipProps = {
    onPress: () => void;
    showLabel: boolean;
    resumeSessionId: string | null | undefined;
    isChecking?: boolean;
    labelTitle: string;
    labelOptional: string;
    iconColor: string;
    pressableStyle: (pressed: boolean) => any;
    textStyle: any;
};

export function ResumeChip(props: ResumeChipProps) {
    const label = props.showLabel
        ? formatResumeChipLabel({
            resumeSessionId: props.resumeSessionId,
            labelTitle: props.labelTitle,
            labelOptional: props.labelOptional,
        })
        : null;

    return (
        <Pressable
            onPress={props.onPress}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            style={(p) => props.pressableStyle(p.pressed)}
        >
            {props.isChecking ? (
                <ActivityIndicator
                    size="small"
                    color={props.iconColor}
                />
            ) : (
                <Ionicons
                    name={RESUME_CHIP_ICON_NAME}
                    size={RESUME_CHIP_ICON_SIZE}
                    color={props.iconColor}
                />
            )}
            {label ? (
                <Text style={props.textStyle}>
                    {label}
                </Text>
            ) : null}
        </Pressable>
    );
}
