import * as React from 'react';
import { ToolViewProps } from './_all';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { knownTools } from '@/components/tools/knownTools';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { useSetting } from '@/sync/storage';

export const WriteView = React.memo<ToolViewProps>(({ tool }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');

    let contents: string = '<no contents>';
    const parsed = knownTools.Write.input.safeParse(tool.input);
    if (parsed.success && typeof parsed.data.content === 'string') {
        contents = parsed.data.content;
    }

    return (
        <>
            <ToolSectionView fullWidth>
                <ToolDiffView 
                    oldText={''} 
                    newText={contents} 
                    showLineNumbers={showLineNumbersInToolViews}
                    showPlusMinusSymbols={showLineNumbersInToolViews}
                />
            </ToolSectionView>
        </>
    );
});