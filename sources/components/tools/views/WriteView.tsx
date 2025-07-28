import * as React from 'react';
import { ToolViewProps } from './_all';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { knownTools } from '@/components/tools/knownTools';
import { DiffView } from '@/components/diff/DiffView';
import { useSetting } from '@/sync/storage';

export const WriteView = React.memo<ToolViewProps>(({ tool }) => {
    const showLineNumbers = useSetting('showLineNumbers');

    let contents: string = '<no contents>';
    const parsed = knownTools.Write.input.safeParse(tool.input);
    if (parsed.success && typeof parsed.data.content === 'string') {
        contents = parsed.data.content;
    }

    return (
        <>
            <ToolSectionView>
                <DiffView 
                    oldText={''} 
                    newText={contents} 
                    wrapLines={false}
                    showLineNumbers={showLineNumbers}
                />
            </ToolSectionView>
        </>
    );
});