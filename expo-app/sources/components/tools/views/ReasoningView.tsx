import * as React from 'react';
import { View } from 'react-native';
import type { ToolViewProps } from './_registry';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { MarkdownView } from '@/components/markdown/MarkdownView';

function extractReasoningMarkdown(result: unknown): string | null {
    if (!result) return null;
    if (typeof result === 'string') return result;
    if (typeof result === 'object' && !Array.isArray(result)) {
        const obj = result as Record<string, unknown>;
        if (typeof obj.content === 'string') return obj.content;
        if (typeof obj.text === 'string') return obj.text;
        if (typeof obj.reasoning === 'string') return obj.reasoning;
    }
    return null;
}

export const ReasoningView = React.memo<ToolViewProps>(({ tool }) => {
    const markdown = extractReasoningMarkdown(tool.result);
    if (!markdown) return null;

    return (
        <ToolSectionView>
            <View style={{ width: '100%' }}>
                <MarkdownView markdown={markdown} />
            </View>
        </ToolSectionView>
    );
});
