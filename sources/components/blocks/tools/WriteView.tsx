import * as React from 'react';
import { ToolViewProps } from './_all';
import { ToolSectionView } from '../ToolSectionView';
import { knownTools } from '@/components/blocks/knownTools';
import { CodeView } from '../CodeView';

export const WriteView = React.memo<ToolViewProps>(({ tool }) => {

    let contents: string = '<no contents>';
    const parsed = knownTools.Write.input.safeParse(tool.input);
    if (parsed.success && typeof parsed.data.content === 'string') {
        contents = parsed.data.content;
    }

    return (
        <>
            <ToolSectionView>
                <CodeView code={contents} />
            </ToolSectionView>
        </>
    );
});