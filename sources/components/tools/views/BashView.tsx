import * as React from 'react';

import { ToolSectionView } from '../../tools/ToolSectionView';

import { CommandView } from '@/components/CommandView';
import { Metadata } from '@/sync/storageTypes';
import { ToolCall } from '@/sync/typesMessage';

export const BashView = React.memo((props: { tool: ToolCall, metadata: Metadata | null }) => {
    const { input, result, state } = props.tool;

    const error: string | null = (state === 'error' && typeof result === 'string') ? result : null;

    return (
        <>
            <ToolSectionView>
                <CommandView 
                    command={input.command}
                    // Don't show output in compact view
                    stdout={null}
                    stderr={null}
                    error={error}
                    hideEmptyOutput
                />
            </ToolSectionView>
        </>
    );
});