import * as React from 'react';
import { View } from 'react-native';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { knownTools } from '@/components/tools/knownTools';
import { toolFullViewStyles } from '../ToolFullView';
import { DiffView } from '@/components/diff/DiffView';
import { trimIdent } from '@/utils/trimIdent';
import { useSetting } from '@/sync/storage';

interface EditViewFullProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const EditViewFull = React.memo<EditViewFullProps>(({ tool, metadata }) => {
    const showLineNumbers = useSetting('showLineNumbers');
    const { input } = tool;

    // Parse the input
    let oldString = '';
    let newString = '';
    const parsed = knownTools.Edit.input.safeParse(input);
    if (parsed.success) {
        oldString = trimIdent(parsed.data.old_string || '');
        newString = trimIdent(parsed.data.new_string || '');
    }

    return (
        <View style={toolFullViewStyles.section}>
            <DiffView 
                oldText={oldString} 
                newText={newString} 
                wrapLines={false}
                showLineNumbers={showLineNumbers}
                style={{ width: '100%' }}
            />
        </View>
    );
});