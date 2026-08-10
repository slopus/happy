import * as React from 'react';
import { ToolViewProps } from "./_all";
import { ToolSectionView } from '../../tools/ToolSectionView';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { knownTools } from '../../tools/knownTools';
import { View } from 'react-native';
import { useLocalSetting } from '@/sync/storage';

export const ExitPlanToolView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const conversationFontSize = useLocalSetting('conversationFontSize');
    let plan = '<empty>'
    const parsed = knownTools.ExitPlanMode.input.safeParse(tool.input);
    if (parsed.success) {
        plan = parsed.data.plan ?? '<empty>';
    }
    return (
        <ToolSectionView>
            <View style={{ paddingHorizontal: 8, marginTop: -10 }}>
                <MarkdownView
                    markdown={plan}
                    sessionId={sessionId}
                    conversationFontSize={conversationFontSize}
                />
            </View>
        </ToolSectionView>
    );
});
