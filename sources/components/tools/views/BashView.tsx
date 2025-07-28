import * as React from 'react';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { CommandView } from '@/components/CommandView';
import { knownTools } from '@/components/tools/knownTools';
import { Metadata } from '@/sync/storageTypes';


export const BashView = React.memo((props: { tool: ToolCall, metadata: Metadata | null }) => {
    const { input, result, state } = props.tool;

    let output: string | null = null;
    let error: string | null = null;
    if (state === 'completed') {
        let parsed = knownTools.Bash.result.safeParse(result);
        if (parsed.success) {
            output = parsed.data.stdout ?? null;
        }
    }
    if (state === 'error' && typeof result === 'string') {
        error = result;
    }

    return (
        <>
            <ToolSectionView>
                <CommandView command={input.command} output={output} />
            </ToolSectionView>
        </>
    );
});