import * as React from 'react';
import { Platform, Text } from 'react-native';
import { ToolCall } from '@/sync/typesMessage';
import type { Metadata } from '@/sync/storageTypes';
import { knownTools } from '@/components/tools/knownTools';
import { getToolActivityLabel, getToolDisplayTitle, isTerminalToolName } from '@/utils/toolDisplay';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { StyleSheet } from 'react-native-unistyles';

interface ToolHeaderProps {
    tool?: ToolCall;
    metadata?: Metadata | null;
}

/** One bounded, non-interactive navigation title, including while loading. */
export function ToolHeader({ tool, metadata = null }: ToolHeaderProps) {
    let title = t('common.message');
    if (tool) {
        const knownTool = knownTools[tool.name as keyof typeof knownTools];
        title = getToolDisplayTitle(tool);
        if (!tool.title?.trim() && knownTool && 'title' in knownTool && knownTool.title) {
            title = typeof knownTool.title === 'function'
                ? knownTool.title({ tool, metadata })
                : knownTool.title;
        }
        if (isTerminalToolName(tool.name)) title = getToolActivityLabel(tool);
    }

    return (
        <Text style={styles.title} numberOfLines={1} ellipsizeMode="middle" accessibilityRole="header">
            {title}
        </Text>
    );
}

const styles = StyleSheet.create((theme) => ({
    title: {
        ...Typography.default('semiBold'),
        fontSize: Platform.OS === 'web' ? 17 : 16,
        lineHeight: 20,
        color: theme.colors.header.tint,
        textAlign: 'center',
        maxWidth: '100%',
        flexShrink: 1,
    },
}));