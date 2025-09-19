import * as React from 'react';
import { View } from 'react-native';

import { knownTools } from '../../tools/knownTools';
import { ToolSectionView } from '../../tools/ToolSectionView';

import { ToolViewProps } from "./_all";

import { MarkdownView } from '@/components/markdown/MarkdownView';



export const ExitPlanToolView = React.memo<ToolViewProps>(({ tool }) => {
    let plan = '<empty>'
    const parsed = knownTools.ExitPlanMode.input.safeParse(tool.input);
    if (parsed.success) {
        plan = parsed.data.plan ?? '<empty>';
    }
    return (
        <ToolSectionView>
            <View style={{ paddingHorizontal: 8, marginTop: -10 }}>
                <MarkdownView markdown={plan} />
            </View>
        </ToolSectionView>
    );
});